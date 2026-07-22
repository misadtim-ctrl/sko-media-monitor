from __future__ import annotations

import re
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from ..models import Publication, Source
from .base import Collector
from .parsing import parse_datetime


class TelegramCollector(Collector):
    platforms = frozenset({"telegram"})

    async def collect(self, source: Source) -> list[Publication]:
        username = self._username(source.url)
        raw = await self.fetch_text(f"https://t.me/s/{username}")
        soup = BeautifulSoup(raw, "html.parser")
        result: list[Publication] = []
        for block in soup.select(".tgme_widget_message_wrap"):
            message = block.select_one("[data-post]")
            if not message:
                continue
            post_id = message.get("data-post", "")
            if not post_id:
                continue
            text_node = block.select_one(".tgme_widget_message_text")
            text = text_node.get_text(" ", strip=True) if text_node else ""
            if len(text) < 10:
                caption = block.select_one(".tgme_widget_message_caption")
                text = caption.get_text(" ", strip=True) if caption else text
            if len(text) < 10:
                continue
            time_node = block.select_one("time[datetime]")
            published = parse_datetime(time_node.get("datetime")) if time_node else None
            media_urls: list[str] = []
            for photo in block.select(".tgme_widget_message_photo_wrap"):
                style = photo.get("style", "")
                match = re.search(r"url\(['\"]?([^)'\"]+)", style)
                if match:
                    media_urls.append(match.group(1))
            for video in block.select("video[src]"):
                media_urls.append(video.get("src", ""))
            result.append(
                Publication(
                    source_id=source.id,
                    source_name=source.name,
                    platform=source.platform,
                    workflow=source.workflow,
                    url=f"https://t.me/{post_id}",
                    title=(text[:180] + "…") if len(text) > 180 else text,
                    text=text[:12000],
                    published_at=published,
                    media_urls=list(dict.fromkeys(url for url in media_urls if url))[:4],
                )
            )
        return result

    @staticmethod
    def _username(url: str) -> str:
        path = urlsplit(url).path.strip("/")
        if path.startswith("s/"):
            path = path[2:]
        return path.split("/", 1)[0].lstrip("@")
