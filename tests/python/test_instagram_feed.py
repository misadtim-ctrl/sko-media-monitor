from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from sko_monitor.collectors.base import CollectorError
from sko_monitor.collectors.instagram_feed import InstagramFeedCollector
from sko_monitor.config import Settings
from sko_monitor.models import Source

NOW = datetime(2026, 7, 26, 18, 0, tzinfo=UTC)


def public(handle: str, source_id: str | None = None) -> Source:
    return Source(
        id=source_id or f"instagram-{handle}",
        name=handle,
        platform="instagram",
        url=f"https://www.instagram.com/{handle}/",
        scope="local_public",
        workflow="akimat_negative",
    )


def media(handle: str, code: str, minutes_ago: int, caption: str = "Текст жалобы") -> dict:
    taken = NOW - timedelta(minutes=minutes_ago)
    return {
        "media_or_ad": {
            "code": code,
            "media_type": 1,
            "taken_at": int(taken.timestamp()),
            "user": {"username": handle},
            "caption": {"text": caption},
            "image_versions2": {"candidates": [{"url": f"https://cdn.test/{code}.jpg"}]},
        }
    }


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = "" if status_code == 200 else "blocked"

    def json(self) -> dict:
        return self._payload


class FakeSession:
    """Отдаёт заранее заготовленные страницы ленты вместо обращения к Instagram."""

    def __init__(self, pages: list[dict], status_code: int = 200) -> None:
        self.pages = pages
        self.status_code = status_code
        self.calls: list[dict] = []

    def post(self, url, headers=None, data=None, timeout=None):  # noqa: ANN001
        self.calls.append(dict(data or {}))
        if self.status_code != 200:
            return FakeResponse({}, self.status_code)
        index = min(len(self.calls) - 1, len(self.pages) - 1)
        return FakeResponse(self.pages[index])


def collector(session: FakeSession, monkeypatch, pages: int = 3) -> InstagramFeedCollector:
    monkeypatch.setenv("INSTAGRAM_USE_FEED", "true")
    monkeypatch.setenv("INSTAGRAM_FEED_PAGES", str(pages))
    instance = InstagramFeedCollector(Settings.from_env())
    instance._session = session
    return instance


@pytest.mark.asyncio
async def test_feed_splits_posts_between_publics(monkeypatch) -> None:
    session = FakeSession(
        [
            {
                "feed_items": [
                    media("pkzsk", "AAA", 40),
                    media("sko_kz", "BBB", 8),
                    {"suggested_users": {"any": "block"}},  # рекламная врезка
                ],
                "more_available": False,
            }
        ]
    )
    grouped, unknown = await collector(session, monkeypatch).collect(
        [public("pkzsk"), public("sko_kz")], NOW - timedelta(hours=24)
    )

    assert set(grouped) == {"instagram-pkzsk", "instagram-sko_kz"}
    post = grouped["instagram-pkzsk"][0]
    assert post.url == "https://www.instagram.com/p/AAA/"
    assert post.published_at == NOW - timedelta(minutes=40)
    assert post.media_urls == ["https://cdn.test/AAA.jpg"]
    assert post.metadata["via"] == "feed"
    assert unknown == []


@pytest.mark.asyncio
async def test_feed_keeps_fresh_posts_among_ranked_old_ones(monkeypatch) -> None:
    # Лента ранжированная: недельный пост лежит между свежими. Возраст поэтому
    # проверяется у каждого поста, а не служит поводом прекратить чтение.
    session = FakeSession(
        [
            {
                "feed_items": [
                    media("sko_kz", "OLD", 60 * 24 * 7),
                    media("sko_kz", "NEW", 5),
                ],
                "more_available": False,
            }
        ]
    )
    grouped, _ = await collector(session, monkeypatch).collect(
        [public("sko_kz")], NOW - timedelta(hours=24)
    )

    assert [post.metadata["shortcode"] for post in grouped["instagram-sko_kz"]] == ["NEW"]


@pytest.mark.asyncio
async def test_feed_reports_accounts_outside_registry(monkeypatch) -> None:
    session = FakeSession(
        [{"feed_items": [media("compshopsko", "CCC", 10)], "more_available": False}]
    )
    grouped, unknown = await collector(session, monkeypatch).collect(
        [public("sko_kz")], NOW - timedelta(hours=24)
    )

    assert grouped == {}
    assert unknown == ["compshopsko"]


@pytest.mark.asyncio
async def test_feed_walks_pages_and_skips_duplicates(monkeypatch) -> None:
    page = {
        "feed_items": [media("sko_kz", "AAA", 5), media("sko_kz", "BBB", 6)],
        "more_available": True,
        "next_max_id": "cursor-1",
    }
    last = {"feed_items": [media("sko_kz", "CCC", 7)], "more_available": False}
    session = FakeSession([page, last])
    grouped, _ = await collector(session, monkeypatch).collect(
        [public("sko_kz")], NOW - timedelta(hours=24)
    )

    assert [post.metadata["shortcode"] for post in grouped["instagram-sko_kz"]] == [
        "AAA",
        "BBB",
        "CCC",
    ]
    assert session.calls[1]["max_id"] == "cursor-1"


@pytest.mark.asyncio
async def test_feed_quotes_http_error_verbatim(monkeypatch) -> None:
    # 429 и 401 значат для оператора разное: заблокированный адрес против
    # протухшего входа. Код ответа обязан дойти до отчёта неизменным.
    session = FakeSession([], status_code=429)
    with pytest.raises(CollectorError, match="429"):
        await collector(session, monkeypatch).collect(
            [public("sko_kz")], NOW - timedelta(hours=24)
        )


@pytest.mark.asyncio
async def test_cloud_contour_drops_instagram_entirely(monkeypatch, tmp_path) -> None:
    # В GitHub Actions Instagram выключен целиком: 429 приходит на первый же
    # запрос, а показывать сохранённый вход с адреса дата-центра незачем.
    from sko_monitor.pipeline import MonitorPipeline

    monkeypatch.setenv("INSTAGRAM_ENABLED", "false")
    monkeypatch.setenv("STATE_DB", str(tmp_path / "state.sqlite3"))
    pipeline = MonitorPipeline(Settings.from_env())

    selected = pipeline._select_sources("negative")
    assert selected, "остальные источники обязаны остаться"
    assert not [source for source in selected if source.platform == "instagram"]
    assert pipeline._feed_sources("negative") == []


@pytest.mark.asyncio
async def test_mac_contour_feeds_every_public_and_sweeps_a_few(monkeypatch, tmp_path) -> None:
    from sko_monitor.pipeline import MonitorPipeline

    monkeypatch.setenv("INSTAGRAM_USE_FEED", "true")
    monkeypatch.setenv("INSTAGRAM_SWEEP_PROFILES", "2")
    monkeypatch.setenv("STATE_DB", str(tmp_path / "state.sqlite3"))
    pipeline = MonitorPipeline(Settings.from_env())

    # Лента обслуживает все паблики разом, а поштучный обход остаётся страховкой
    # на пару профилей за прогон — иначе Instagram увидит десятки запросов подряд.
    feed = pipeline._feed_sources("negative")
    swept = [s for s in pipeline._select_sources("negative") if s.platform == "instagram"]
    assert len(feed) == 23
    assert len(swept) == 2


def test_feed_takes_the_lightest_video_version() -> None:
    # Кадры нужны только чтобы прочитать текст, а тяжёлый реал упирается в
    # 30-мегабайтный предел загрузки и тогда не разбирается вовсе.
    from sko_monitor.collectors.instagram_feed import _media_urls

    urls = _media_urls(
        {
            "video_versions": [
                {"url": "https://cdn.test/big.mp4", "width": 1080, "height": 1920},
                {"url": "https://cdn.test/small.mp4", "width": 480, "height": 852},
            ],
            "image_versions2": {"candidates": [{"url": "https://cdn.test/cover.jpg"}]},
        }
    )

    assert urls[0] == "https://cdn.test/small.mp4"


@pytest.mark.asyncio
async def test_night_gap_widens_the_window_and_walks_deeper(monkeypatch, tmp_path) -> None:
    # Сбор идёт на Mac, а он ночью выключен. Утренний запуск обязан догнать
    # вечерние посты, иначе трёхчасовое окно их просто отбросит.
    from datetime import timedelta as _td

    from sko_monitor.models import SourceRun
    from sko_monitor.pipeline import MonitorPipeline, RunReport

    monkeypatch.setenv("INSTAGRAM_USE_FEED", "true")
    monkeypatch.setenv("STATE_DB", str(tmp_path / "state.sqlite3"))
    pipeline = MonitorPipeline(Settings.from_env())
    feed_sources = pipeline._feed_sources("negative")

    # Ноутбук молчал девять часов.
    stale = datetime.now(UTC) - _td(hours=9)
    for source in feed_sources:
        pipeline.state.record_source_run(
            SourceRun(source_id=source.id, ok=True, found=0, elapsed_ms=1, checked_at=stale)
        )

    gap = pipeline.state.hours_since_last_run([s.id for s in feed_sources])
    assert 8.5 < gap < 9.5

    captured: dict[str, int] = {}

    class Spy:
        def __init__(self, settings) -> None:  # noqa: ANN001
            pass

        async def collect(self, sources, cutoff, pages=None):  # noqa: ANN001
            captured["pages"] = pages
            return {}, []

    import sko_monitor.pipeline as pipeline_module

    monkeypatch.setattr(pipeline_module, "InstagramFeedCollector", Spy)
    await pipeline._merge_feed((), feed_sources, datetime.now(UTC), RunReport(), gap)

    # Три страницы по умолчанию превратились в глубокий догоняющий обход.
    assert captured["pages"] > 3
