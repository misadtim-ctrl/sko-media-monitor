from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

Workflow = Literal["sko_mentions", "regional_news", "akimat_negative"]


@dataclass(slots=True, frozen=True)
class Source:
    id: str
    name: str
    platform: str
    url: str
    scope: str
    workflow: Workflow
    owners: tuple[str, ...] = ()
    enabled: bool = True
    notes: str = ""


@dataclass(slots=True)
class Publication:
    source_id: str
    source_name: str
    platform: str
    workflow: Workflow
    url: str
    title: str
    text: str = ""
    published_at: datetime | None = None
    media_urls: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def searchable_text(self) -> str:
        parts = [self.title, self.text]
        parts.extend(str(self.metadata.get(key, "")) for key in ("ocr_text", "transcript"))
        return "\n".join(part.strip() for part in parts if part and part.strip())

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if self.published_at:
            payload["published_at"] = self.published_at.astimezone(UTC).isoformat()
        return payload


@dataclass(slots=True)
class Analysis:
    relevant: bool
    confidence: float
    category: str
    tone: str
    summary: str
    matched: list[str] = field(default_factory=list)
    places: list[str] = field(default_factory=list)
    needs_review: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class AnalyzedPublication:
    publication: Publication
    analysis: Analysis

    def to_dict(self) -> dict[str, Any]:
        return {
            "publication": self.publication.to_dict(),
            "analysis": self.analysis.to_dict(),
        }


@dataclass(slots=True)
class SourceRun:
    source_id: str
    ok: bool
    found: int
    elapsed_ms: int
    error: str = ""
    checked_at: datetime = field(default_factory=lambda: datetime.now(UTC))
