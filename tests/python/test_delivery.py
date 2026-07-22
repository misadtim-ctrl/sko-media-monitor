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
            delivered = await SheetsDelivery(client, Settings.from_env()).publish([{"id": "one"}])

    assert delivered
    assert route.call_count == 2
    sleep.assert_awaited_once()
