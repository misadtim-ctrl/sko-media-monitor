import json
from datetime import UTC, datetime

import pytest

from sko_monitor.collectors.website import WebsiteCollector
from sko_monitor.config import Settings
from sko_monitor.dedupe import dedupe_keys
from sko_monitor.delivery.sheets import SheetsDelivery
from sko_monitor.models import Publication
from sko_monitor.pipeline import MonitorPipeline


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("bridge_accepted", "allow_python_main", "expected_seen"),
    [(False, True, False), (True, True, True), (True, False, False)],
)
async def test_relevant_link_is_remembered_only_after_durable_delivery(
    tmp_path, monkeypatch, bridge_accepted, allow_python_main, expected_seen
) -> None:
    registry = tmp_path / "sources.json"
    registry.write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "id": "republican",
                        "name": "Republican",
                        "platform": "website",
                        "url": "https://republican.kz/",
                        "scope": "republican",
                        "workflow": "sko_mentions",
                        "enabled": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SOURCE_REGISTRY", str(registry))
    monkeypatch.setenv("STATE_DB", str(tmp_path / "state.sqlite3"))
    monkeypatch.setenv("EXPORT_DIR", str(tmp_path / "exports"))
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_URL", "https://script.google.test/bridge")
    monkeypatch.setenv("MONITOR_WEBHOOK_SECRET", "test-secret")
    if allow_python_main:
        monkeypatch.setenv("ENABLE_PYTHON_MAIN_DELIVERY", "true")
    else:
        monkeypatch.delenv("ENABLE_PYTHON_MAIN_DELIVERY", raising=False)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_MAIN_CHAT_ID", raising=False)

    publication = Publication(
        source_id="republican",
        source_name="Republican",
        platform="website",
        workflow="sko_mentions",
        url="https://republican.kz/news/1",
        title="Аким Северо-Казахстанской области посетил предприятие",
        text="Рабочая поездка прошла сегодня.",
        published_at=datetime.now(UTC),
    )

    async def collect(_collector, _source):
        return [publication]

    async def publish(_delivery, _items):
        return bridge_accepted

    async def heartbeat(_delivery, _report):
        return True

    monkeypatch.setattr(WebsiteCollector, "collect", collect)
    monkeypatch.setattr(SheetsDelivery, "publish", publish)
    monkeypatch.setattr(SheetsDelivery, "heartbeat", heartbeat)

    pipeline = MonitorPipeline(Settings.from_env())
    report = await pipeline.run("main", lookback_hours=72)

    assert report.relevant == 1
    assert pipeline.state.is_seen(dedupe_keys(publication)) is expected_seen
