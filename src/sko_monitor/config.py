from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .models import Source


def project_root() -> Path:
    working_directory = Path.cwd().resolve()
    if (working_directory / "config" / "sources.json").is_file():
        return working_directory
    source_checkout = Path(__file__).resolve().parents[2]
    if (source_checkout / "config" / "sources.json").is_file():
        return source_checkout
    return working_directory


@dataclass(slots=True, frozen=True)
class Settings:
    registry_path: Path
    state_path: Path
    export_dir: Path
    concurrency: int
    request_timeout: float
    user_agent: str
    telegram_bot_token: str
    telegram_main_chat_id: str
    telegram_negative_chat_id: str
    apps_script_webhook_url: str
    webhook_secret: str
    semantic_model: str
    enable_semantic: bool
    enable_media_analysis: bool
    enable_video_analysis: bool
    instagram_username: str
    instagram_session_file: str
    meta_access_token: str
    meta_ig_user_id: str
    meta_graph_version: str

    @classmethod
    def from_env(cls, root: Path | None = None) -> Settings:
        root = root or project_root()
        return cls(
            registry_path=Path(os.getenv("SOURCE_REGISTRY", root / "config" / "sources.json")),
            state_path=Path(os.getenv("STATE_DB", root / "data" / "state.sqlite3")),
            export_dir=Path(os.getenv("EXPORT_DIR", root / "exports")),
            concurrency=max(1, int(os.getenv("CONCURRENCY", "8"))),
            request_timeout=float(os.getenv("REQUEST_TIMEOUT", "25")),
            user_agent=os.getenv(
                "USER_AGENT",
                "SKO-Media-Monitor/1.0 (+public media monitoring; respectful polling)",
            ),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_main_chat_id=os.getenv("TELEGRAM_MAIN_CHAT_ID", "").strip(),
            telegram_negative_chat_id=os.getenv("TELEGRAM_NEGATIVE_CHAT_ID", "").strip(),
            apps_script_webhook_url=os.getenv("APPS_SCRIPT_WEBHOOK_URL", "").strip(),
            webhook_secret=os.getenv("MONITOR_WEBHOOK_SECRET", "").strip(),
            semantic_model=os.getenv(
                "SEMANTIC_MODEL",
                "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            ),
            enable_semantic=_bool_env("ENABLE_SEMANTIC", False),
            enable_media_analysis=_bool_env("ENABLE_MEDIA_ANALYSIS", False),
            enable_video_analysis=_bool_env("ENABLE_VIDEO_ANALYSIS", False),
            instagram_username=os.getenv("INSTAGRAM_USERNAME", "").strip(),
            instagram_session_file=os.getenv("INSTAGRAM_SESSION_FILE", "").strip(),
            meta_access_token=os.getenv("META_ACCESS_TOKEN", "").strip(),
            meta_ig_user_id=os.getenv("META_IG_USER_ID", "").strip(),
            meta_graph_version=os.getenv("META_GRAPH_VERSION", "v22.0").strip(),
        )


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_sources(path: Path) -> list[Source]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result: list[Source] = []
    for row in payload.get("sources", []):
        result.append(
            Source(
                id=row["id"],
                name=row["name"],
                platform=row["platform"],
                url=row["url"],
                scope=row["scope"],
                workflow=row["workflow"],
                owners=tuple(row.get("owners", [])),
                enabled=bool(row.get("enabled", True)),
                notes=row.get("notes", ""),
            )
        )
    return result
