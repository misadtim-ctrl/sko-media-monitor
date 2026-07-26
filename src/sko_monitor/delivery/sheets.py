from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from ..config import Settings

LOGGER = logging.getLogger("sko_monitor.delivery.sheets")


class SheetsDelivery:
    def __init__(self, client: httpx.AsyncClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings
        self.last_error = ""

    @property
    def configured(self) -> bool:
        return bool(self.settings.apps_script_webhook_url and self.settings.webhook_secret)

    async def publish(self, items: list[dict[str, Any]]) -> bool:
        if not self.configured or not items:
            return False
        for start in range(0, len(items), 50):
            if not await self._post(
                {
                    "action": "ingest",
                    "secret": self.settings.webhook_secret,
                    "items": items[start : start + 50],
                }
            ):
                return False
        return True

    async def heartbeat(self, report: dict[str, Any]) -> bool:
        if not self.configured:
            return False
        return await self._post(
            {
                "action": "heartbeat",
                "secret": self.settings.webhook_secret,
                "report": report,
            },
            attempts=2,
        )

    async def publish_historical(
        self,
        query: str,
        date_from: str,
        date_to: str,
        items: list[dict[str, Any]],
    ) -> bool:
        if not self.configured:
            return False
        batches = [items[index : index + 50] for index in range(0, len(items), 50)] or [[]]
        for index, batch in enumerate(batches):
            if not await self._post(
                {
                    "action": "historical",
                    "secret": self.settings.webhook_secret,
                    "query": query,
                    "date_from": date_from,
                    "date_to": date_to,
                    "replace": index == 0,
                    "items": batch,
                }
            ):
                return False
        return True

    async def _post(self, payload: dict[str, Any], attempts: int = 4) -> bool:
        action = str(payload.get("action") or "unknown")
        self.last_error = ""
        for attempt in range(attempts):
            retry_after = 0.0
            try:
                response = await self.client.post(
                    self.settings.apps_script_webhook_url,
                    json=payload,
                    follow_redirects=True,
                )
                retry_after = float(response.headers.get("Retry-After", "0") or 0)
                if response.is_success:
                    try:
                        body = response.json()
                    except ValueError as exc:
                        self.last_error = f"{action}: invalid JSON response: {exc}"
                    else:
                        if body.get("ok"):
                            self.last_error = ""
                            return True
                        detail = str(body.get("error") or body.get("message") or "ok=false")
                        self.last_error = f"{action}: Apps Script rejected request: {detail[:300]}"
                else:
                    self.last_error = f"{action}: HTTP {response.status_code}: {response.text[:300]}"
            except httpx.HTTPError as exc:
                self.last_error = f"{action}: {type(exc).__name__}: {exc}"
            except ValueError as exc:
                self.last_error = f"{action}: invalid Retry-After header: {exc}"
            if attempt + 1 < attempts:
                await asyncio.sleep(max(retry_after, min(8.0, 2.0**attempt)))
        LOGGER.warning("Apps Script bridge failed after %d attempts: %s", attempts, self.last_error)
        return False
