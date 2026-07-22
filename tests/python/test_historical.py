import json
from datetime import UTC, date, datetime

import httpx
import pytest
import respx

from sko_monitor.config import Settings
from sko_monitor.historical import HistoricalSearcher


@pytest.mark.asyncio
async def test_historical_search_reads_sitemap_without_archiving(tmp_path, monkeypatch) -> None:
    registry = tmp_path / "sources.json"
    registry.write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "id": "regional",
                        "name": "Regional",
                        "platform": "website",
                        "url": "https://regional.kz/",
                        "scope": "regional",
                        "workflow": "regional_news",
                        "enabled": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SOURCE_REGISTRY", str(registry))
    monkeypatch.setenv("STATE_DB", str(tmp_path / "state.sqlite3"))
    sitemap = """<?xml version="1.0"?><urlset>
      <url><loc>https://regional.kz/2025/04/10/flood</loc><lastmod>2025-04-10</lastmod></url>
    </urlset>"""
    article = """<html><head><meta property="og:title" content="Паводки в районе" />
      <meta property="article:published_time" content="2025-04-10T08:00:00Z" /></head>
      <article>Жители и спасатели готовятся к паводкам.</article></html>"""
    with respx.mock(assert_all_called=False, assert_all_mocked=False) as router:
        router.get("https://regional.kz/robots.txt").mock(
            return_value=httpx.Response(200, text="Sitemap: https://regional.kz/sitemap.xml")
        )
        router.get("https://regional.kz/sitemap.xml").mock(return_value=httpx.Response(200, text=sitemap))
        router.get("https://regional.kz/sitemap_index.xml").mock(return_value=httpx.Response(404))
        router.get("https://regional.kz/wp-sitemap.xml").mock(return_value=httpx.Response(404))
        router.get("https://regional.kz/2025/04/10/flood").mock(
            return_value=httpx.Response(200, text=article)
        )

        searcher = HistoricalSearcher(Settings.from_env())
        searcher.semantic.enabled = False
        hits = await searcher.search("паводки", date(2025, 1, 1), date(2025, 12, 31))
    assert len(hits) == 1
    assert hits[0].source == "Regional"
    assert hits[0].url.endswith("/flood")


@pytest.mark.asyncio
async def test_historical_search_continues_when_one_source_fails(tmp_path, monkeypatch) -> None:
    registry = tmp_path / "sources.json"
    registry.write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "id": "broken",
                        "name": "Broken",
                        "platform": "website",
                        "url": "https://broken.kz/",
                        "scope": "regional",
                        "workflow": "regional_news",
                        "enabled": True,
                    },
                    {
                        "id": "working",
                        "name": "Working",
                        "platform": "website",
                        "url": "https://working.kz/",
                        "scope": "regional",
                        "workflow": "regional_news",
                        "enabled": True,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SOURCE_REGISTRY", str(registry))

    async def sitemap(_self, _client, site_url, _date_from, _date_to):
        if "broken" in site_url:
            raise RuntimeError("temporary source failure")
        return [("https://working.kz/2025/04/10/flood", datetime(2025, 4, 10, tzinfo=UTC))]

    async def article(_client, _url):
        return "Паводки в районе", "Жители готовятся к паводкам.", datetime(2025, 4, 10, tzinfo=UTC)

    monkeypatch.setattr(HistoricalSearcher, "_sitemap_candidates", sitemap)
    monkeypatch.setattr(HistoricalSearcher, "_article", staticmethod(article))

    searcher = HistoricalSearcher(Settings.from_env())
    searcher.semantic.enabled = False
    hits = await searcher.search("паводки", date(2025, 1, 1), date(2025, 12, 31))

    assert len(hits) == 1
    assert hits[0].source == "Working"
