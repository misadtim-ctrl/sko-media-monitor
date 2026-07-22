from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from ..models import Publication, Source
from .base import Collector, CollectorError
from .parsing import parse_datetime


class YouTubeCollector(Collector):
    platforms = frozenset({"youtube"})

    async def collect(self, source: Source) -> list[Publication]:
        page = await self.fetch_text(source.url)
        channel_id = self._channel_id(page)
        if not channel_id:
            raise CollectorError(f"YouTube channel id not found for {source.name}")
        feed_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
        raw = await self.fetch_text(feed_url)
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as exc:
            raise CollectorError(f"Invalid YouTube feed for {source.name}") from exc

        result: list[Publication] = []
        for entry in [node for node in root.iter() if node.tag.endswith("entry")]:
            title = self._text(entry, "title")
            video_id = self._text(entry, "videoId")
            published = self._text(entry, "published")
            description = self._text(entry, "description")
            if not title or not video_id:
                continue
            result.append(
                Publication(
                    source_id=source.id,
                    source_name=source.name,
                    platform=source.platform,
                    workflow=source.workflow,
                    url=f"https://www.youtube.com/watch?v={video_id}",
                    title=title,
                    text=description[:12000],
                    published_at=parse_datetime(published),
                    media_urls=[f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"],
                    metadata={"channel_id": channel_id, "video_id": video_id},
                )
            )
        return result

    @staticmethod
    def _channel_id(page: str) -> str:
        patterns = (
            r'"channelId":"(UC[\w-]{20,})"',
            r'"externalId":"(UC[\w-]{20,})"',
            r'<meta itemprop="channelId" content="(UC[\w-]{20,})"',
        )
        for pattern in patterns:
            match = re.search(pattern, page)
            if match:
                return match.group(1)
        return ""

    @staticmethod
    def _text(entry: ET.Element, suffix: str) -> str:
        for child in entry.iter():
            if child.tag.rsplit("}", 1)[-1] == suffix and child.text:
                return child.text.strip()
        return ""
