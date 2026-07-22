from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import date
from pathlib import Path

import httpx

from .config import Settings, load_sources
from .delivery import SheetsDelivery
from .exporter import export_historical
from .historical import HistoricalSearcher
from .instagram_auth import create_session
from .pipeline import MonitorPipeline
from .state import StateStore


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sko-monitor",
        description="Мониторинг СМИ и городских пабликов СКО",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Запустить один цикл мониторинга")
    run.add_argument("--mode", choices=("main", "negative", "regional", "all"), default="main")
    run.add_argument("--lookback-hours", type=int, default=72)

    sub.add_parser("doctor", help="Проверить конфигурацию без запуска обхода")
    sub.add_parser("stats", help="Показать размер технической памяти и очереди")
    sub.add_parser("prune", help="Удалить просроченную техническую память")
    instagram = sub.add_parser("instagram-login", help="Один раз сохранить вход в существующий Instagram")
    instagram.add_argument("--username", required=True)
    instagram.add_argument("--output", default="data/instagram-session")
    search = sub.add_parser("search", help="Смысловой поиск за период без накопления архива")
    search.add_argument("--query", required=True)
    search.add_argument("--from-date", required=True, type=date.fromisoformat)
    search.add_argument("--to-date", required=True, type=date.fromisoformat)
    search.add_argument("--scope", choices=("regional", "republican", "all"), default="regional")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = Settings.from_env()

    if args.command == "doctor":
        sources = load_sources(settings.registry_path)
        report = {
            "registry": str(settings.registry_path),
            "sources": len(sources),
            "enabled": sum(source.enabled for source in sources),
            "telegram_main": bool(settings.telegram_bot_token and settings.telegram_main_chat_id),
            "telegram_negative": bool(settings.telegram_bot_token and settings.telegram_negative_chat_id),
            "google_sheets": bool(settings.apps_script_webhook_url and settings.webhook_secret),
            "semantic": settings.enable_semantic,
            "media_analysis": settings.enable_media_analysis,
            "video_analysis": settings.enable_video_analysis,
            "instagram_official": bool(settings.meta_access_token and settings.meta_ig_user_id),
            "instagram_session": bool(settings.instagram_session_file),
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    if args.command in {"stats", "prune"}:
        store = StateStore(settings.state_path)
        payload = store.prune() if args.command == "prune" else store.stats()
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    if args.command == "instagram-login":
        path = create_session(args.username, Path(args.output).expanduser().resolve())
        print(f"Instagram session saved: {path}")
        return

    if args.command == "search":
        if args.from_date > args.to_date:
            raise SystemExit("--from-date must be earlier than --to-date")

        async def run_search() -> list[dict]:
            hits = await HistoricalSearcher(settings).search(
                args.query,
                args.from_date,
                args.to_date,
                args.scope,
            )
            payload = [hit.to_dict() for hit in hits]
            export_historical(payload, settings.export_dir)
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                await SheetsDelivery(client, settings).publish_historical(
                    args.query,
                    args.from_date.isoformat(),
                    args.to_date.isoformat(),
                    payload,
                )
            return payload

        results = asyncio.run(run_search())
        print(json.dumps({"found": len(results)}, ensure_ascii=False, indent=2))
        return

    pipeline = MonitorPipeline(settings)
    report = asyncio.run(pipeline.run(args.mode, args.lookback_hours))
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    if report.sources_total and report.sources_failed == report.sources_total:
        sys.exit(2)
