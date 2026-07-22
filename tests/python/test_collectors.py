import httpx
import pytest
import respx

from sko_monitor.collectors.base import CollectorError
from sko_monitor.collectors.instagram import InstagramCollector
from sko_monitor.collectors.parsing import compact_title
from sko_monitor.collectors.telegram import TelegramCollector
from sko_monitor.collectors.website import WebsiteCollector
from sko_monitor.config import Settings
from sko_monitor.models import Publication, Source


@pytest.mark.asyncio
@respx.mock
async def test_telegram_public_page() -> None:
    html = """
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message" data-post="news/123">
        <div class="tgme_widget_message_text">В Петропавловске открыли новую школу</div>
        <time datetime="2026-07-22T08:00:00+00:00"></time>
      </div>
    </div>
    """
    respx.get("https://t.me/s/news").mock(return_value=httpx.Response(200, text=html))
    source = Source("tg-news", "News", "telegram", "https://t.me/news/", "republican", "sko_mentions")
    async with httpx.AsyncClient() as client:
        result = await TelegramCollector(client).collect(source)
    assert len(result) == 1
    assert result[0].url == "https://t.me/news/123"
    assert "Петропавловске" in result[0].text


@pytest.mark.asyncio
@respx.mock
async def test_website_rss() -> None:
    rss = """<?xml version="1.0"?><rss><channel><item>
      <title>В СКО открыли школу</title>
      <link>https://example.kz/news/1</link>
      <description>Новый объект начал работу</description>
      <pubDate>Wed, 22 Jul 2026 08:00:00 GMT</pubDate>
    </item></channel></rss>"""
    respx.get("https://example.kz/feed/").mock(return_value=httpx.Response(200, text=rss))
    source = Source("web", "Example", "website", "https://example.kz/feed/", "republican", "sko_mentions")
    async with httpx.AsyncClient() as client:
        result = await WebsiteCollector(client).collect(source)
    assert len(result) == 1
    assert result[0].published_at is not None
    assert result[0].text == "Новый объект начал работу"


def test_article_hydration_ignores_related_news_geography() -> None:
    publication = Publication(
        source_id="web",
        source_name="Example",
        platform="website",
        workflow="sko_mentions",
        url="https://example.kz/news/pavlodar",
        title="В Павлодарской области прошел ураган",
    )
    html = """
    <article>
      <p>Сильный ветер повредил несколько домов в Павлодарской области.</p>
      <div class="related-news">В СКО спасатели укрепили дамбу</div>
    </article>
    """
    WebsiteCollector._hydrate_article(publication, html)
    assert "Павлодарской" in publication.text
    assert "СКО" not in publication.text


def test_article_hydration_prefers_structured_article_body() -> None:
    publication = Publication(
        source_id="web",
        source_name="Example",
        platform="website",
        workflow="sko_mentions",
        url="https://example.kz/news/petropavl",
        title="Рабочая поездка",
    )
    html = """
    <script type="application/ld+json">
      {"@type":"NewsArticle","articleBody":"В Петропавловске открыли школу.",
       "datePublished":"2026-07-22T08:00:00+05:00"}
    </script>
    <article><p>Короткая версия.</p></article>
    """
    WebsiteCollector._hydrate_article(publication, html)
    assert publication.text == "В Петропавловске открыли школу."
    assert publication.published_at is not None


def test_compact_title_never_cuts_a_word_into_fake_sko() -> None:
    title = compact_title("А" * 160 + " мопедист ехал на полной скорости и скрылся", limit=190)
    assert " ско…" not in title.lower()


@pytest.mark.asyncio
async def test_instagram_does_not_probe_profiles_without_authorised_session(monkeypatch) -> None:
    for name in (
        "INSTAGRAM_USERNAME",
        "INSTAGRAM_SESSION_FILE",
        "META_ACCESS_TOKEN",
        "META_IG_USER_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    source = Source(
        "instagram-public",
        "Public account",
        "instagram",
        "https://www.instagram.com/public_account/",
        "civic_watch",
        "akimat_negative",
    )
    async with httpx.AsyncClient() as client:
        collector = InstagramCollector(client, Settings.from_env())
        with pytest.raises(CollectorError, match="authorised session"):
            await collector.collect(source)
