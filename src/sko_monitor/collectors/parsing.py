from __future__ import annotations

import email.utils
from datetime import UTC, datetime
from typing import Any

from dateutil import parser as date_parser


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        result = value
    else:
        raw = str(value).strip()
        try:
            result = date_parser.parse(raw)
        except (ValueError, TypeError, OverflowError):
            try:
                parsed = email.utils.parsedate_to_datetime(raw)
                result = parsed
            except (ValueError, TypeError, OverflowError):
                return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=UTC)
    return result.astimezone(UTC)


def compact_title(text: str, limit: int = 180) -> str:
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    shortened = clean[:limit].rsplit(" ", 1)[0].rstrip()
    return (shortened or clean[:limit]).rstrip(".,;:!?") + "…"
