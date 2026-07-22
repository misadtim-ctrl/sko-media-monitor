from __future__ import annotations

import html
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from ..config import Settings


@dataclass(slots=True, frozen=True)
class TelegramResult:
    ok: bool
    retry_after: int = 0
    error: str = ""


class TelegramDelivery:
    def __init__(self, client: httpx.AsyncClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    def configured_for(self, workflow: str) -> bool:
        return bool(self.settings.telegram_bot_token and self.chat_for(workflow))

    def chat_for(self, workflow: str) -> str:
        if workflow == "akimat_negative":
            return self.settings.telegram_negative_chat_id
        if workflow == "sko_mentions":
            return self.settings.telegram_main_chat_id
        return ""

    async def send(self, workflow: str, payload: dict[str, Any]) -> TelegramResult:
        chat = self.chat_for(workflow)
        token = self.settings.telegram_bot_token
        if not token or not chat:
            return TelegramResult(False, error=f"Telegram chat is not configured for {workflow}")
        message = self.format_message(payload)
        try:
            response = await self.client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": chat,
                    "text": message,
                    "parse_mode": "HTML",
                    "link_preview_options": {
                        "is_disabled": False,
                        "url": payload["publication"]["url"],
                        "prefer_large_media": True,
                    },
                },
            )
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            return TelegramResult(False, error=str(exc))
        if response.status_code == 200 and data.get("ok"):
            return TelegramResult(True)
        retry = int(data.get("parameters", {}).get("retry_after", 0) or 0)
        return TelegramResult(False, retry_after=retry, error=data.get("description", response.text)[:1000])

    @staticmethod
    def format_message(payload: dict[str, Any]) -> str:
        publication = payload["publication"]
        analysis = payload["analysis"]
        title = html.escape(publication.get("title") or "Публикация")
        source = html.escape(publication.get("source_name") or "Источник")
        url = html.escape(publication["url"], quote=True)
        published = publication.get("published_at")
        published_text = ""
        if published:
            try:
                moment = datetime.fromisoformat(published).astimezone(UTC)
                published_text = moment.strftime("%d.%m.%Y %H:%M UTC")
            except ValueError:
                published_text = str(published)
        confidence = round(float(analysis.get("confidence", 0)) * 100)
        category = html.escape(analysis.get("category", ""))
        summary = html.escape(analysis.get("summary", ""))
        review = "\nТребует проверки аналитиком" if analysis.get("needs_review") else ""
        return (
            f"<b>{title}</b>\n\n"
            f"Источник: {source}\n"
            + (f"Опубликовано: {published_text}\n" if published_text else "")
            + f"Категория: {category}\n"
            + f"Релевантность: {confidence}%"
            + review
            + (f"\n\n{summary}" if summary else "")
            + f'\n\n<a href="{url}">Открыть публикацию</a>'
        )
