from unittest.mock import AsyncMock

import httpx
import pytest
import respx

import sko_monitor.delivery.sheets as sheets_module
from sko_monitor.config import Settings
from sko_monitor.delivery.sheets import SheetsDelivery


@pytest.mark.asyncio
async def test_sheets_delivery_retries_temporary_failure(monkeypatch) -> None:
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_URL", "https://script.google.test/bridge")
    monkeypatch.setenv("MONITOR_WEBHOOK_SECRET", "test-secret")
    sleep = AsyncMock()
    monkeypatch.setattr(sheets_module.asyncio, "sleep", sleep)

    with respx.mock(assert_all_called=True) as router:
        route = router.post("https://script.google.test/bridge").mock(
            side_effect=[
                httpx.Response(503),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        async with httpx.AsyncClient() as client:
            delivery = SheetsDelivery(client, Settings.from_env())
            delivered = await delivery.publish([{"id": "one"}])

    assert delivered
    assert delivery.last_error == ""
    assert route.call_count == 2
    sleep.assert_awaited_once()


@pytest.mark.asyncio
async def test_sheets_delivery_exposes_final_error(monkeypatch, caplog) -> None:
    monkeypatch.setenv("APPS_SCRIPT_WEBHOOK_URL", "https://script.google.test/bridge")
    monkeypatch.setenv("MONITOR_WEBHOOK_SECRET", "test-secret")
    sleep = AsyncMock()
    monkeypatch.setattr(sheets_module.asyncio, "sleep", sleep)

    with respx.mock(assert_all_called=True) as router:
        router.post("https://script.google.test/bridge").mock(
            return_value=httpx.Response(403, json={"ok": False, "error": "unauthorized"})
        )
        async with httpx.AsyncClient() as client:
            delivery = SheetsDelivery(client, Settings.from_env())
            delivered = await delivery.publish([{"id": "one"}])

    assert not delivered
    assert "HTTP 403" in delivery.last_error
    assert "bridge failed" in caplog.text
