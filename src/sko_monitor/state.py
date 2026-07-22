from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .models import SourceRun


def _iso(value: datetime | None = None) -> str:
    return (value or datetime.now(UTC)).astimezone(UTC).isoformat()


class StateStore:
    """Bounded technical state. It intentionally is not a publication archive."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _migrate(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS seen_keys (
                    key TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    first_seen TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_seen_expires ON seen_keys(expires_at);

                CREATE TABLE IF NOT EXISTS outbox (
                    id TEXT PRIMARY KEY,
                    workflow TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_error TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_due
                    ON outbox(status, next_attempt);

                CREATE TABLE IF NOT EXISTS source_state (
                    source_id TEXT PRIMARY KEY,
                    last_checked TEXT NOT NULL,
                    last_success TEXT,
                    last_count INTEGER NOT NULL DEFAULT 0,
                    consecutive_failures INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    elapsed_ms INTEGER NOT NULL DEFAULT 0
                );
                """
            )

    def is_seen(self, keys: tuple[str, ...]) -> bool:
        if not keys:
            return False
        placeholders = ",".join("?" for _ in keys)
        with self.connect() as db:
            row = db.execute(
                f"SELECT 1 FROM seen_keys WHERE key IN ({placeholders}) AND expires_at > ? LIMIT 1",
                (*keys, _iso()),
            ).fetchone()
        return row is not None

    def remember(self, keys: tuple[str, ...], source_id: str, ttl_days: int = 45) -> None:
        now = datetime.now(UTC)
        expires = now + timedelta(days=ttl_days)
        with self.connect() as db:
            db.executemany(
                """
                INSERT INTO seen_keys(key, source_id, first_seen, expires_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at
                """,
                ((key, source_id, _iso(now), _iso(expires)) for key in keys),
            )

    def enqueue(self, item_id: str, workflow: str, payload: dict[str, Any]) -> bool:
        now = _iso()
        with self.connect() as db:
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO outbox(
                    id, workflow, payload, status, attempts, next_attempt,
                    created_at, updated_at, last_error
                ) VALUES(?, ?, ?, 'pending', 0, ?, ?, ?, '')
                """,
                (item_id, workflow, json.dumps(payload, ensure_ascii=False), now, now, now),
            )
        return cursor.rowcount == 1

    def due_outbox(self, limit: int = 25) -> list[sqlite3.Row]:
        with self.connect() as db:
            return list(
                db.execute(
                    """
                    SELECT * FROM outbox
                    WHERE status IN ('pending', 'retry') AND next_attempt <= ?
                    ORDER BY created_at ASC LIMIT ?
                    """,
                    (_iso(), limit),
                ).fetchall()
            )

    def mark_sent(self, item_id: str) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE outbox SET status='sent', updated_at=?, last_error='' WHERE id=?",
                (_iso(), item_id),
            )

    def mark_retry(self, item_id: str, attempts: int, delay_seconds: int, error: str) -> None:
        retry_at = datetime.now(UTC) + timedelta(seconds=max(30, delay_seconds))
        with self.connect() as db:
            db.execute(
                """
                UPDATE outbox SET status='retry', attempts=?, next_attempt=?,
                    updated_at=?, last_error=? WHERE id=?
                """,
                (attempts, _iso(retry_at), _iso(), error[:1000], item_id),
            )

    def record_source_run(self, run: SourceRun) -> None:
        checked = _iso(run.checked_at)
        with self.connect() as db:
            old = db.execute(
                "SELECT consecutive_failures, last_success FROM source_state WHERE source_id=?",
                (run.source_id,),
            ).fetchone()
            failures = 0 if run.ok else (int(old["consecutive_failures"]) + 1 if old else 1)
            last_success = checked if run.ok else (old["last_success"] if old else None)
            db.execute(
                """
                INSERT INTO source_state(
                    source_id, last_checked, last_success, last_count,
                    consecutive_failures, last_error, elapsed_ms
                ) VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_id) DO UPDATE SET
                    last_checked=excluded.last_checked,
                    last_success=excluded.last_success,
                    last_count=excluded.last_count,
                    consecutive_failures=excluded.consecutive_failures,
                    last_error=excluded.last_error,
                    elapsed_ms=excluded.elapsed_ms
                """,
                (
                    run.source_id,
                    checked,
                    last_success,
                    run.found,
                    failures,
                    run.error[:1000],
                    run.elapsed_ms,
                ),
            )

    def prune(self) -> dict[str, int]:
        now = datetime.now(UTC)
        sent_cutoff = now - timedelta(days=7)
        source_cutoff = now - timedelta(days=90)
        with self.connect() as db:
            seen = db.execute("DELETE FROM seen_keys WHERE expires_at <= ?", (_iso(now),)).rowcount
            outbox = db.execute(
                "DELETE FROM outbox WHERE status='sent' AND updated_at < ?",
                (_iso(sent_cutoff),),
            ).rowcount
            sources = db.execute(
                "DELETE FROM source_state WHERE last_checked < ?",
                (_iso(source_cutoff),),
            ).rowcount
        return {"seen": seen, "outbox": outbox, "source_state": sources}

    def stats(self) -> dict[str, int]:
        with self.connect() as db:
            return {
                "seen_keys": db.execute("SELECT COUNT(*) FROM seen_keys").fetchone()[0],
                "pending": db.execute(
                    "SELECT COUNT(*) FROM outbox WHERE status IN ('pending','retry')"
                ).fetchone()[0],
                "sent_receipts": db.execute("SELECT COUNT(*) FROM outbox WHERE status='sent'").fetchone()[0],
                "sources": db.execute("SELECT COUNT(*) FROM source_state").fetchone()[0],
            }
