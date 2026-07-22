from __future__ import annotations

import asyncio
from datetime import UTC
from pathlib import Path
from urllib.parse import urlsplit

from ..config import Settings
from ..models import Publication, Source
from .base import Collector, CollectorError
from .parsing import parse_datetime


class InstagramCollector(Collector):
    platforms = frozenset({"instagram"})

    def __init__(self, client, settings: Settings) -> None:
        super().__init__(client)
        self.settings = settings
        self._rate_lock = asyncio.Lock()

    async def collect(self, source: Source) -> list[Publication]:
        username = urlsplit(source.url).path.strip("/").split("/", 1)[0]
        if not username:
            raise CollectorError(f"Instagram username missing in {source.url}")
        if self.settings.meta_access_token and self.settings.meta_ig_user_id:
            try:
                result = await self._collect_meta(source, username)
                if result:
                    return result
            except CollectorError:
                # A profile may be personal rather than Business/Creator.
                # Instaloader remains a bounded fallback for public profiles.
                pass
        async with self._rate_lock:
            try:
                return await asyncio.to_thread(self._collect_instaloader, source, username)
            finally:
                await asyncio.sleep(1.5)

    async def _collect_meta(self, source: Source, username: str) -> list[Publication]:
        version = self.settings.meta_graph_version.strip("/")
        endpoint = f"https://graph.facebook.com/{version}/{self.settings.meta_ig_user_id}"
        fields = (
            f"business_discovery.username({username})"
            "{media.limit(16){caption,media_type,media_url,permalink,timestamp,thumbnail_url}}"
        )
        try:
            response = await self.client.get(
                endpoint,
                params={"fields": fields, "access_token": self.settings.meta_access_token},
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            raise CollectorError(f"Meta API failed for @{username}: {exc}") from exc
        media = payload.get("business_discovery", {}).get("media", {}).get("data", [])
        result: list[Publication] = []
        for post in media:
            caption = " ".join(str(post.get("caption", "")).split())
            permalink = post.get("permalink")
            if not permalink:
                continue
            media_urls = [url for url in (post.get("media_url"), post.get("thumbnail_url")) if url]
            result.append(
                Publication(
                    source_id=source.id,
                    source_name=source.name,
                    platform=source.platform,
                    workflow=source.workflow,
                    url=permalink,
                    title=(caption[:180] + "…") if len(caption) > 180 else caption or "Публикация Instagram",
                    text=caption,
                    published_at=parse_datetime(post.get("timestamp")),
                    media_urls=list(dict.fromkeys(media_urls)),
                    metadata={"media_type": post.get("media_type", "")},
                )
            )
        return result

    def _collect_instaloader(self, source: Source, username: str) -> list[Publication]:
        try:
            import instaloader
        except ImportError as exc:
            raise CollectorError(
                "Instagram needs either the free Meta API credentials or the optional "
                "'instagram' package with a reusable session"
            ) from exc

        loader = instaloader.Instaloader(
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False,
            quiet=True,
        )
        if self.settings.instagram_username and self.settings.instagram_session_file:
            session = Path(self.settings.instagram_session_file)
            if session.exists():
                loader.load_session_from_file(self.settings.instagram_username, str(session))

        try:
            profile = instaloader.Profile.from_username(loader.context, username)
            posts = profile.get_posts()
            result: list[Publication] = []
            seen_shortcodes: set[str] = set()
            for index, post in enumerate(posts):
                if index >= 24:
                    break
                if post.shortcode in seen_shortcodes:
                    continue
                seen_shortcodes.add(post.shortcode)
                caption = " ".join((post.caption or "").split())
                media_urls: list[str] = []
                if post.typename == "GraphSidecar":
                    try:
                        for node in list(post.get_sidecar_nodes())[:4]:
                            media_url = node.video_url if node.is_video else node.display_url
                            if media_url:
                                media_urls.append(media_url)
                    except Exception:
                        pass
                if not media_urls and post.url:
                    media_urls.append(post.url)
                if post.is_video and getattr(post, "video_url", None):
                    media_urls.insert(0, post.video_url)
                result.append(
                    Publication(
                        source_id=source.id,
                        source_name=source.name,
                        platform=source.platform,
                        workflow=source.workflow,
                        url=f"https://www.instagram.com/p/{post.shortcode}/",
                        title=(caption[:180] + "…")
                        if len(caption) > 180
                        else caption or "Публикация Instagram",
                        text=caption,
                        published_at=post.date_utc.replace(tzinfo=UTC),
                        media_urls=list(dict.fromkeys(media_urls))[:2],
                        metadata={"shortcode": post.shortcode, "is_video": post.is_video},
                    )
                )
            return result
        except Exception as exc:
            raise CollectorError(f"Instagram @{username} unavailable: {exc}") from exc
