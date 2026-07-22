import httpx
import pytest
import respx

from sko_monitor.collectors.telegram import TelegramCollector
from sko_monitor.collectors.website import WebsiteCollector
from sko_monitor.models import Source


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
