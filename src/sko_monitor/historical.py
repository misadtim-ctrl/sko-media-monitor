from __future__ import annotations

import asyncio
import re
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup

from .analyzers.semantic import SemanticScorer
from .collectors.parsing import parse_datetime
from .config import Settings, load_sources
from .dedupe import canonical_url


@dataclass(slots=True)
class HistoricalHit:
    source: str
    url: str
    title: str
    published_at: str
    summary: str
    relevance: float
    method: str

    def to_dict(self) -> dict:
        return asdict(self)


class HistoricalSearcher:
    """On-demand semantic search. Results are returned, never added to the state DB."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.semantic = SemanticScorer(settings.semantic_model, enabled=True)

    async def search(
        self,
        query: str,
        date_from: date,
        date_to: date,
        scope: str = "regional",
    ) -> list[HistoricalHit]:
        sources = [
            source
            for source in load_sources(self.settings.registry_path)
            if source.enabled and source.platform == "website" and (scope == "all" or source.scope == scope)
        ]
        timeout = httpx.Timeout(max(30.0, self.settings.request_timeout))
        headers = {"User-Agent": self.settings.user_agent, "Accept-Language": "ru,kk;q=0.9"}
        async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=True) as client:
            semaphore = asyncio.Semaphore(self.settings.concurrency)

            async def source_candidates(source) -> list[tuple[str, datetime | None, str]]:
                async with semaphore:
                    candidates = await self._sitemap_candidates(client, source.url, date_from, date_to)
                    if candidates:
                        return [(url, published, "sitemap") for url, published in candidates]
                    return await self._wordpress_candidates(client, source.url, query, date_from, date_to)

            batches = await asyncio.gather(*(source_candidates(source) for source in sources))
            seen: set[str] = set()
            jobs = []
            for source, candidates in zip(sources, batches, strict=True):
                for url, published, method in candidates:
                    key = canonical_url(url)
                    if key in seen:
                        continue
                    seen.add(key)
                    jobs.append((source.name, url, published, method))

            async def inspect(job):
                source_name, url, sitemap_date, method = job
                async with semaphore:
                    article = await self._article(client, url)
                if article is None:
                    return None
                title, text, article_date = article
                published = article_date or sitemap_date
                if published and not self._in_range(published, date_from, date_to):
                    return None
                return source_name, url, title, text, published, method

            inspected = []
            for start in range(0, len(jobs), 200):
                batch = await asyncio.gather(*(inspect(job) for job in jobs[start : start + 200]))
                inspected.extend(item for item in batch if item)

            searchable = [item[2] + "\n" + item[3] for item in inspected]
            semantic_scores = await asyncio.to_thread(self.semantic.similarities, query, searchable)
            hits: list[HistoricalHit] = []
            for item, semantic_score in zip(inspected, semantic_scores, strict=True):
                source_name, url, title, text, published, method = item
                score = max(semantic_score, self._lexical_similarity(query, title + " " + text))
                if score < 0.42:
                    continue
                hits.append(
                    HistoricalHit(
                        source=source_name,
                        url=url,
                        title=title,
                        published_at=published.astimezone(UTC).isoformat() if published else "",
                        summary=(text[:380].rsplit(" ", 1)[0] + "…") if len(text) > 380 else text,
                        relevance=round(score, 3),
                        method=method,
                    )
                )
        return sorted(hits, key=lambda hit: (hit.published_at, hit.relevance), reverse=True)

    async def _sitemap_candidates(
        self,
        client: httpx.AsyncClient,
        site_url: str,
        date_from: date,
        date_to: date,
    ) -> list[tuple[str, datetime | None]]:
        root = f"{urlsplit(site_url).scheme}://{urlsplit(site_url).netloc}"
        queue: list[str] = []
        try:
            robots = await client.get(root + "/robots.txt")
            if robots.status_code < 400:
                queue.extend(
                    match.strip() for match in re.findall(r"(?im)^sitemap:\s*(https?://\S+)", robots.text)
                )
        except httpx.HTTPError:
            pass
        queue.extend(root + path for path in ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"))
        visited: set[str] = set()
        result: list[tuple[str, datetime | None]] = []
        while queue:
            sitemap = queue.pop(0)
            if sitemap in visited:
                continue
            visited.add(sitemap)
            try:
                response = await client.get(sitemap)
                if response.status_code >= 400 or len(response.content) > 50 * 1024 * 1024:
                    continue
                root_node = ET.fromstring(response.content)
            except (httpx.HTTPError, ET.ParseError):
                continue
            node_type = root_node.tag.rsplit("}", 1)[-1].lower()
            if node_type == "sitemapindex":
                for node in root_node:
                    location = self._xml_child(node, "loc")
                    modified = parse_datetime(self._xml_child(node, "lastmod"))
                    if location and (not modified or modified.date() >= date_from - timedelta(days=2)):
                        queue.append(location)
                continue
            if node_type != "urlset":
                continue
            for node in root_node:
                location = self._xml_child(node, "loc")
                modified = parse_datetime(self._xml_child(node, "lastmod"))
                inferred = modified or self._date_from_url(location)
                if location and (not inferred or self._in_range(inferred, date_from, date_to)):
                    result.append((location, inferred))
        return result

    async def _wordpress_candidates(
        self,
        client: httpx.AsyncClient,
        site_url: str,
        query: str,
        date_from: date,
        date_to: date,
    ) -> list[tuple[str, datetime | None, str]]:
        root = f"{urlsplit(site_url).scheme}://{urlsplit(site_url).netloc}"
        result: list[tuple[str, datetime | None, str]] = []
        page = 1
        while page <= 100:
            try:
                response = await client.get(
                    root + "/wp-json/wp/v2/search",
                    params={"search": query, "per_page": 100, "page": page},
                )
                if response.status_code in {400, 404}:
                    break
                response.raise_for_status()
                rows = response.json()
            except (httpx.HTTPError, ValueError):
                break
            if not rows:
                break
            for row in rows:
                url = row.get("url")
                if url:
                    result.append((url, self._date_from_url(url), "WordPress search"))
            page += 1
        return result

    @staticmethod
    async def _article(client: httpx.AsyncClient, url: str) -> tuple[str, str, datetime | None] | None:
        try:
            response = await client.get(url)
            response.raise_for_status()
        except httpx.HTTPError:
            return None
        soup = BeautifulSoup(response.text, "html.parser")
        for node in soup.select("script, style, nav, footer, aside, form"):
            node.decompose()
        title_node = soup.select_one('meta[property="og:title"], h1, title')
        if not title_node:
            return None
        title = (
            title_node.get("content") if title_node.name == "meta" else title_node.get_text(" ", strip=True)
        )
        article = soup.select_one("article, main, [itemprop='articleBody']")
        text = article.get_text(" ", strip=True) if article else ""
        if not text:
            description = soup.select_one('meta[name="description"], meta[property="og:description"]')
            text = description.get("content", "") if description else ""
        date_node = soup.select_one(
            'meta[property="article:published_time"], time[datetime], meta[itemprop="datePublished"]'
        )
        raw_date = ""
        if date_node:
            raw_date = date_node.get("content") or date_node.get("datetime") or ""
        return " ".join(title.split()), " ".join(text.split())[:20000], parse_datetime(raw_date)

    @staticmethod
    def _xml_child(node: ET.Element, name: str) -> str:
        for child in node:
            if child.tag.rsplit("}", 1)[-1].lower() == name and child.text:
                return child.text.strip()
        return ""

    @staticmethod
    def _date_from_url(url: str) -> datetime | None:
        match = re.search(r"/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:/|$)", url)
        if not match:
            return None
        try:
            return datetime(int(match[1]), int(match[2]), int(match[3]), tzinfo=UTC)
        except ValueError:
            return None

    @staticmethod
    def _in_range(moment: datetime, date_from: date, date_to: date) -> bool:
        start = datetime.combine(date_from, time.min, tzinfo=UTC)
        end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=UTC)
        return start <= moment.astimezone(UTC) < end

    @staticmethod
    def _lexical_similarity(query: str, text: str) -> float:
        def tokens(value: str) -> set[str]:
            return {
                word[: max(5, len(word) - 2)]
                for word in re.findall(r"[0-9a-zа-яёәғқңөұүһі]{4,}", value.lower())
            }

        query_tokens = tokens(query)
        text_tokens = tokens(text)
        if not query_tokens or not text_tokens:
            return 0.0
        return len(query_tokens & text_tokens) / len(query_tokens)
