from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from ..models import Publication, Source
from .base import Collector
from .parsing import compact_title


class SocialPageCollector(Collector):
    """Best-effort public-page fallback for Threads, VK, Facebook and TikTok."""

    platforms = frozenset({"threads", "vk", "facebook", "tiktok"})

    PATTERNS = {
        "threads": re.compile(r"/@[^/]+/post/[A-Za-z0-9_-]+", re.I),
        "vk": re.compile(r"/(?:wall|video|clip)[^/?#]+", re.I),
        "facebook": re.compile(r"/(?:posts|videos|reel|permalink\.php)[^#]*", re.I),
        "tiktok": re.compile(r"/@[^/]+/video/\d+", re.I),
    }

    async def collect(self, source: Source) -> list[Publication]:
        raw = await self.fetch_text(source.url)
        soup = BeautifulSoup(raw, "html.parser")
        pattern = self.PATTERNS[source.platform]
        found: list[Publication] = []
        seen: set[str] = set()
        for anchor in soup.select("a[href]"):
            href = anchor.get("href") or ""
            url = urljoin(source.url, href)
            parts = urlsplit(url)
            if not pattern.search(parts.path + ("?" + parts.query if parts.query else "")):
                continue
            clean = url.split("#", 1)[0]
            if clean in seen:
                continue
            seen.add(clean)
            text = " ".join(anchor.get_text(" ", strip=True).split())
            if len(text) < 10 and anchor.parent:
                text = " ".join(anchor.parent.get_text(" ", strip=True).split())
            found.append(
                Publication(
                    source_id=source.id,
                    source_name=source.name,
                    platform=source.platform,
                    workflow=source.workflow,
                    url=clean,
                    title=compact_title(text) if text else f"Публикация {source.name}",
                    text=text[:8000],
                )
            )
            if len(found) >= 20:
                break
        return found
