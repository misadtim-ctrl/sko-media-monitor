from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from ..config import Settings
from ..models import Publication, Source
from .base import CollectorError
from .parsing import compact_title

LOGGER = logging.getLogger("sko_monitor.collectors.instagram_feed")

# The private timeline endpoint the official app calls. One request returns the
# newest posts of every account the monitoring profile follows, which is the
# whole point: 39 profile crawls collapse into one call, so the contour can be
# polled every ten minutes instead of once an hour without provoking a 429.
TIMELINE_URL = "https://i.instagram.com/api/v1/feed/timeline/"

# The app identifies itself as a phone here. A desktop user agent on this
# endpoint answers 403, so the pair of headers below is not decoration.
APP_HEADERS = {
    "User-Agent": (
        "Instagram 275.0.0.27.98 Android "
        "(33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)"
    ),
    "X-IG-App-ID": "936619743392459",
    "X-IG-Capabilities": "3brTvw==",
    "Accept-Language": "en-US",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
}

MEDIA_TYPE_VIDEO = 2
MEDIA_TYPE_CAROUSEL = 8


class InstagramFeedCollector:
    """Collects городские паблики through the subscription feed.

    Unlike the per-profile collector this one is not driven by a single Source:
    it fetches once and then distributes the posts across the registry by
    username. Accounts the monitoring profile follows but the registry does not
    know are reported separately rather than silently dropped — that mismatch is
    exactly what made the old contour monitor accounts that no longer exist.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._session = None

    async def collect(
        self, sources: list[Source], cutoff: datetime, pages: int | None = None
    ) -> tuple[dict[str, list[Publication]], list[str]]:
        """Returns posts grouped by source id, plus usernames outside the registry."""
        by_username = {_username_of(source): source for source in sources}
        by_username.pop("", None)
        if not by_username:
            return {}, []
        budget = max(1, pages or self.settings.instagram_feed_pages)
        return await asyncio.to_thread(self._collect_blocking, by_username, cutoff, budget)

    def _collect_blocking(
        self, by_username: dict[str, Source], cutoff: datetime, pages: int
    ) -> tuple[dict[str, list[Publication]], list[str]]:
        session = self._authorised_session()
        grouped: dict[str, list[Publication]] = {}
        unknown: list[str] = []
        seen_codes: set[str] = set()
        max_id = ""
        for page in range(pages):
            payload = self._fetch_page(session, max_id)
            items = payload.get("feed_items") or []
            fresh_on_page = 0
            for item in items:
                media = item.get("media_or_ad")
                if not isinstance(media, dict):
                    continue  # promoted units and "suggested for you" blocks
                code = str(media.get("code") or "")
                username = str((media.get("user") or {}).get("username") or "").lower()
                if not code or code in seen_codes or not username:
                    continue
                seen_codes.add(code)
                published_at = _taken_at(media)
                # The feed is ranked, not chronological: week-old posts sit
                # between fresh ones. Age is therefore filtered per post rather
                # than used to stop reading the page.
                if published_at and published_at < cutoff:
                    continue
                source = by_username.get(username)
                if source is None:
                    if username not in unknown:
                        unknown.append(username)
                    continue
                fresh_on_page += 1
                grouped.setdefault(source.id, []).append(
                    _publication(source, media, code, published_at)
                )
            if not payload.get("more_available") or not payload.get("next_max_id"):
                break
            # Ranking means a page can be entirely stale while the next one is
            # not, so one empty page is tolerated and two end the walk.
            if fresh_on_page == 0 and page > 0:
                break
            max_id = str(payload.get("next_max_id"))
        LOGGER.info(
            "Feed walked: %d posts across %d publics, %d unknown accounts",
            sum(len(items) for items in grouped.values()),
            len(grouped),
            len(unknown),
        )
        return grouped, unknown

    def _fetch_page(self, session, max_id: str) -> dict[str, Any]:
        data = {"reason": "cold_start_fetch", "is_pull_to_refresh": "0"}
        if max_id:
            data = {"reason": "pagination", "max_id": max_id}
        try:
            response = session.post(
                TIMELINE_URL,
                headers=APP_HEADERS,
                data=data,
                timeout=self.settings.request_timeout,
            )
        except Exception as exc:
            raise CollectorError(f"Instagram feed unreachable: {exc}") from exc
        if response.status_code != 200:
            # 429 and 401 read very differently for the operator: the first is a
            # blocked address, the second a session that has to be renewed on
            # the Mac. Both are quoted verbatim so the Telegram alert is useful.
            raise CollectorError(
                f"Instagram feed answered HTTP {response.status_code}: {response.text[:200]}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise CollectorError(f"Instagram feed returned malformed JSON: {exc}") from exc

    def _authorised_session(self):
        if self._session is not None:
            return self._session
        try:
            import instaloader
        except ImportError as exc:
            raise CollectorError(
                "Чтение ленты требует пакет 'instagram' — переустановите через setup.command"
            ) from exc
        username = self.settings.instagram_username
        session_file = Path(self.settings.instagram_session_file or "")
        if not username or not session_file.is_file():
            raise CollectorError(
                "Нет сохранённого входа в Instagram — запустите instagram-login.command"
            )
        loader = instaloader.Instaloader(quiet=True, max_connection_attempts=1)
        loader.load_session_from_file(username, str(session_file))
        # instaloader keeps an authenticated requests.Session; reusing it means
        # the cookies stay in one place and are refreshed by the same login.
        self._session = loader.context._session
        return self._session


def _username_of(source: Source) -> str:
    return urlsplit(source.url).path.strip("/").split("/", 1)[0].lower()


def _taken_at(media: dict[str, Any]) -> datetime | None:
    raw = media.get("taken_at")
    if not raw:
        return None
    try:
        return datetime.fromtimestamp(int(raw), UTC)
    except (TypeError, ValueError, OSError):
        return None


def _publication(
    source: Source, media: dict[str, Any], code: str, published_at: datetime | None
) -> Publication:
    caption = " ".join(str((media.get("caption") or {}).get("text") or "").split())
    return Publication(
        source_id=source.id,
        source_name=source.name,
        platform=source.platform,
        workflow=source.workflow,
        url=f"https://www.instagram.com/p/{code}/",
        title=compact_title(caption) if caption else "Публикация Instagram",
        text=caption,
        published_at=published_at,
        media_urls=_media_urls(media),
        metadata={
            "shortcode": code,
            "is_video": media.get("media_type") == MEDIA_TYPE_VIDEO,
            "via": "feed",
        },
    )


def _media_urls(media: dict[str, Any]) -> list[str]:
    """Picks at most two illustrations — the OCR step reads them, not the archive."""
    urls: list[str] = []
    videos = [item for item in (media.get("video_versions") or []) if item.get("url")]
    if videos:
        # Самая лёгкая версия: кадры нужны только чтобы прочитать текст, а
        # тяжёлые реалы упираются в 30-мегабайтный предел загрузки и тогда
        # пропускаются целиком.
        lightest = min(videos, key=lambda item: (item.get("width") or 0) * (item.get("height") or 0))
        urls.append(lightest["url"])
    nodes = media.get("carousel_media") or [media]
    for node in nodes:
        candidates = (node.get("image_versions2") or {}).get("candidates") or []
        if candidates:
            url = candidates[0].get("url")
            if url:
                urls.append(url)
        if len(urls) >= 2:
            break
    return list(dict.fromkeys(urls))[:2]
