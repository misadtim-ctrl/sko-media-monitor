from __future__ import annotations

import asyncio
import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from ..models import Publication, Source
from .base import Collector, CollectorError
from .parsing import parse_datetime


class WebsiteCollector(Collector):
    platforms = frozenset({"website"})

    async def collect(self, source: Source) -> list[Publication]:
        raw = await self.fetch_text(source.url)
        if self._looks_like_feed(raw):
            return self._parse_feed(source, raw)

        soup = BeautifulSoup(raw, "html.parser")
        feed_url = self._discover_feed(source.url, soup)
        if feed_url:
            try:
                feed = await self.fetch_text(feed_url)
                parsed = self._parse_feed(source, feed)
                if parsed:
                    return parsed[:80]
            except CollectorError:
                pass

        candidates = self._parse_listing(source, soup)[:20]
        semaphore = asyncio.Semaphore(4)

        async def hydrate(item: Publication) -> Publication:
            async with semaphore:
                try:
                    article = await self.fetch_text(item.url)
                    self._hydrate_article(item, article)
                except CollectorError:
                    pass
                return item

        return list(await asyncio.gather(*(hydrate(item) for item in candidates)))

    @staticmethod
    def _looks_like_feed(raw: str) -> bool:
        start = raw.lstrip()[:500].lower()
        return start.startswith("<?xml") or "<rss" in start or "<feed" in start

    @staticmethod
    def _discover_feed(base_url: str, soup: BeautifulSoup) -> str:
        for link in soup.select('link[rel="alternate"]'):
            kind = (link.get("type") or "").lower()
            href = link.get("href")
            if href and ("rss" in kind or "atom" in kind or "xml" in kind):
                return urljoin(base_url, href)
        return ""

    @staticmethod
    def _xml_text(element: ET.Element, names: tuple[str, ...]) -> str:
        for child in element.iter():
            tag = child.tag.rsplit("}", 1)[-1].lower()
            if tag in names and child.text:
                return child.text.strip()
        return ""

    def _parse_feed(self, source: Source, raw: str) -> list[Publication]:
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as exc:
            raise CollectorError(f"Invalid feed for {source.name}: {exc}") from exc

        entries = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1].lower() in {"item", "entry"}]
        result: list[Publication] = []
        for entry in entries[:100]:
            title = self._xml_text(entry, ("title",))
            link = self._xml_text(entry, ("link",))
            if not link:
                for child in entry.iter():
                    if child.tag.rsplit("}", 1)[-1].lower() == "link" and child.get("href"):
                        link = child.get("href", "")
                        break
            if not title or not link:
                continue
            description = self._xml_text(entry, ("description", "summary", "content", "encoded"))
            description = BeautifulSoup(description, "html.parser").get_text(" ", strip=True)
            published = self._xml_text(entry, ("pubdate", "published", "updated", "date"))
            media_urls = []
            for child in entry.iter():
                tag = child.tag.rsplit("}", 1)[-1].lower()
                media_url = child.get("url") if tag in {"content", "thumbnail", "enclosure"} else None
                if media_url and media_url.startswith("http"):
                    media_urls.append(media_url)
            result.append(
                Publication(
                    source_id=source.id,
                    source_name=source.name,
                    platform=source.platform,
                    workflow=source.workflow,
                    url=urljoin(source.url, link),
                    title=title.strip(),
                    text=description[:8000],
                    published_at=parse_datetime(published),
                    media_urls=list(dict.fromkeys(media_urls))[:4],
                )
            )
        return result

    def _parse_listing(self, source: Source, soup: BeautifulSoup) -> list[Publication]:
        base_host = urlsplit(source.url).netloc.lower().removeprefix("www.")
        candidates: list[Publication] = []
        seen: set[str] = set()
        selectors = "article a[href], h1 a[href], h2 a[href], h3 a[href], a[href]"
        for anchor in soup.select(selectors):
            title = " ".join(anchor.get_text(" ", strip=True).split())
            href = anchor.get("href") or ""
            url = urljoin(source.url, href)
            parts = urlsplit(url)
            if parts.scheme not in {"http", "https"}:
                continue
            if parts.netloc.lower().removeprefix("www.") != base_host:
                continue
            if len(title) < 20 or len(title) > 350:
                continue
            if re.search(r"/(tag|tags|author|search|login|category|page)/", parts.path, re.I):
                continue
            clean = url.split("#", 1)[0]
            if clean in seen:
                continue
            seen.add(clean)
            candidates.append(
                Publication(
                    source_id=source.id,
                    source_name=source.name,
                    platform=source.platform,
                    workflow=source.workflow,
                    url=clean,
                    title=title,
                )
            )
            if len(candidates) >= 80:
                break
        return candidates

    @staticmethod
    def _hydrate_article(item: Publication, raw: str) -> None:
        soup = BeautifulSoup(raw, "html.parser")
        structured = WebsiteCollector._structured_article(soup)
        for node in soup.select("script, style, nav, footer, aside, form, noscript"):
            node.decompose()
        noise = re.compile(
            r"(?:^|[-_\s])(related|recommend(?:ed|ations?)?|read[-_]?also|also[-_]?read|"
            r"similar|other[-_]?news|more[-_]?news|latest[-_]?news|popular|sidebar)(?:$|[-_\s])",
            re.IGNORECASE,
        )
        for node in list(soup.find_all(True)):
            identity = " ".join([str(node.get("id", "")), *node.get("class", [])])
            if identity and noise.search(identity):
                node.decompose()
        description = soup.select_one('meta[name="description"], meta[property="og:description"]')
        description_text = description.get("content", "") if description else ""
        article = soup.select_one("article, main, [itemprop='articleBody']")
        body = structured.get("articleBody", "")
        if not body:
            body = article.get_text(" ", strip=True) if article else description_text
        item.text = " ".join(body.split())[:12000]
        item.metadata["text_source"] = "structured" if structured.get("articleBody") else "html"
        image = soup.select_one('meta[property="og:image"], meta[name="twitter:image"]')
        if image and image.get("content"):
            item.media_urls = [urljoin(item.url, image["content"])]
        elif structured.get("image"):
            structured_image = structured["image"]
            if isinstance(structured_image, list):
                structured_image = structured_image[0] if structured_image else ""
            if isinstance(structured_image, dict):
                structured_image = structured_image.get("url", "")
            if isinstance(structured_image, str) and structured_image:
                item.media_urls = [urljoin(item.url, structured_image)]
        date_node = soup.select_one(
            'meta[property="article:published_time"], time[datetime], meta[itemprop="datePublished"]'
        )
        raw_date = structured.get("datePublished", "")
        if not raw_date and date_node:
            raw_date = date_node.get("content") or date_node.get("datetime")
        if raw_date:
            item.published_at = item.published_at or parse_datetime(str(raw_date))

    @staticmethod
    def _structured_article(soup: BeautifulSoup) -> dict:
        def walk(value):
            if isinstance(value, list):
                for child in value:
                    yield from walk(child)
                return
            if not isinstance(value, dict):
                return
            yield value
            for key in ("@graph", "mainEntity", "itemListElement"):
                if key in value:
                    yield from walk(value[key])

        article_types = {"article", "newsarticle", "reportagenewsarticle"}
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                payload = json.loads(script.string or script.get_text() or "")
            except (json.JSONDecodeError, TypeError):
                continue
            for candidate in walk(payload):
                raw_type = candidate.get("@type", "")
                types = raw_type if isinstance(raw_type, list) else [raw_type]
                if any(str(kind).lower() in article_types for kind in types):
                    return candidate
        return {}
