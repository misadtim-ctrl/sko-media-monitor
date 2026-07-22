from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx

from .analyzers import MediaAnalyzer, PublicationAnalyzer
from .analyzers.semantic import SemanticScorer
from .collectors import (
    Collector,
    InstagramCollector,
    SocialPageCollector,
    TelegramCollector,
    WebsiteCollector,
    YouTubeCollector,
)
from .config import Settings, load_sources
from .dedupe import dedupe_keys, payload_id
from .delivery import SheetsDelivery, TelegramDelivery
from .exporter import export_latest
from .models import AnalyzedPublication, Publication, Source, SourceRun
from .state import StateStore

LOGGER = logging.getLogger("sko_monitor")


@dataclass(slots=True)
class RunReport:
    sources_total: int = 0
    sources_ok: int = 0
    sources_failed: int = 0
    collected: int = 0
    unseen: int = 0
    relevant: int = 0
    needs_review: int = 0
    queued: int = 0
    sent: int = 0
    errors: list[str] = field(default_factory=list)
    results: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "sources_total": self.sources_total,
            "sources_ok": self.sources_ok,
            "sources_failed": self.sources_failed,
            "collected": self.collected,
            "unseen": self.unseen,
            "relevant": self.relevant,
            "needs_review": self.needs_review,
            "queued": self.queued,
            "sent": self.sent,
            "errors": self.errors,
        }


class MonitorPipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state = StateStore(settings.state_path)
        self.semantic = SemanticScorer(settings.semantic_model, settings.enable_semantic)
        self.analyzer = PublicationAnalyzer(self.semantic)

    async def run(self, mode: str, lookback_hours: int = 72) -> RunReport:
        sources = self._select_sources(mode)
        report = RunReport(sources_total=len(sources))
        run_seen: set[str] = set()
        pending_memory: list[tuple[tuple[str, ...], str, bool]] = []
        timeout = httpx.Timeout(self.settings.request_timeout)
        limits = httpx.Limits(max_connections=self.settings.concurrency * 2, max_keepalive_connections=10)
        headers = {"User-Agent": self.settings.user_agent, "Accept-Language": "ru,kk;q=0.9,en;q=0.5"}
        async with httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            headers=headers,
            follow_redirects=True,
        ) as client:
            collectors: list[Collector] = [
                WebsiteCollector(client),
                TelegramCollector(client),
                YouTubeCollector(client),
                InstagramCollector(client, self.settings),
                SocialPageCollector(client),
            ]
            collector_by_platform = {
                platform: collector for collector in collectors for platform in collector.platforms
            }
            media = MediaAnalyzer(client, self.settings)
            telegram = TelegramDelivery(client, self.settings)
            sheets = SheetsDelivery(client, self.settings)
            semaphore = asyncio.Semaphore(self.settings.concurrency)

            async def collect_source(source: Source) -> tuple[Source, list[Publication], str, int]:
                started = time.monotonic()
                collector = collector_by_platform.get(source.platform)
                if not collector:
                    return source, [], f"unsupported platform: {source.platform}", 0
                try:
                    async with semaphore:
                        publications = await collector.collect(source)
                    elapsed = round((time.monotonic() - started) * 1000)
                    return source, publications, "", elapsed
                except Exception as exc:
                    elapsed = round((time.monotonic() - started) * 1000)
                    return source, [], str(exc), elapsed

            batches = await asyncio.gather(*(collect_source(source) for source in sources))
            cutoff = datetime.now(UTC) - timedelta(hours=max(1, lookback_hours))

            for source, publications, error, elapsed in batches:
                ok = not error
                self.state.record_source_run(
                    SourceRun(
                        source_id=source.id,
                        ok=ok,
                        found=len(publications),
                        elapsed_ms=elapsed,
                        error=error,
                    )
                )
                if ok:
                    report.sources_ok += 1
                else:
                    report.sources_failed += 1
                    report.errors.append(f"{source.name}: {error}")
                    LOGGER.warning("Source failed: %s: %s", source.name, error)
                    continue

                report.collected += len(publications)
                for publication in publications:
                    if publication.published_at and publication.published_at < cutoff:
                        continue
                    keys = dedupe_keys(publication)
                    if run_seen.intersection(keys) or self.state.is_seen(keys):
                        continue
                    run_seen.update(keys)
                    report.unseen += 1

                    analysis = self.analyzer.analyze(publication)
                    if (
                        not analysis.relevant
                        and self.settings.enable_media_analysis
                        and publication.media_urls
                    ):
                        await media.enrich(publication)
                        analysis = self.analyzer.analyze(publication)

                    selected = analysis.relevant or (
                        publication.workflow == "akimat_negative" and analysis.needs_review
                    )
                    if not selected:
                        self.state.remember(keys, publication.source_id, ttl_days=14)
                        continue

                    analyzed = AnalyzedPublication(publication, analysis)
                    payload = analyzed.to_dict()
                    report.results.append(payload)
                    if analysis.relevant:
                        report.relevant += 1
                    if analysis.needs_review:
                        report.needs_review += 1
                    direct_delivery = telegram.configured_for(publication.workflow)
                    if direct_delivery and self.state.enqueue(
                        payload_id(publication), publication.workflow, payload
                    ):
                        report.queued += 1
                    pending_memory.append((keys, publication.source_id, direct_delivery))

            bridge_accepted = False
            if report.results:
                bridge_accepted = await sheets.publish(report.results)
                export_latest(report.results, self.settings.export_dir)
            for keys, source_id, direct_delivery in pending_memory:
                if bridge_accepted or direct_delivery:
                    self.state.remember(keys, source_id, ttl_days=365)
            report.sent = await self._flush_outbox(telegram)
            await sheets.heartbeat(report.to_dict())

        self.state.prune()
        return report

    async def _flush_outbox(self, telegram: TelegramDelivery) -> int:
        sent = 0
        for row in self.state.due_outbox(limit=25):
            payload = json.loads(row["payload"])
            result = await telegram.send(row["workflow"], payload)
            if result.ok:
                self.state.mark_sent(row["id"])
                sent += 1
                await asyncio.sleep(1.1)
                continue
            attempts = int(row["attempts"]) + 1
            delay = result.retry_after or min(6 * 60 * 60, (2 ** min(attempts, 6)) * 300)
            self.state.mark_retry(row["id"], attempts, delay, result.error)
            if result.retry_after:
                break
        return sent

    def _select_sources(self, mode: str) -> list[Source]:
        sources = [source for source in load_sources(self.settings.registry_path) if source.enabled]
        if mode == "main":
            return [source for source in sources if source.workflow == "sko_mentions"]
        if mode == "negative":
            return [source for source in sources if source.workflow == "akimat_negative"]
        if mode == "regional":
            return [source for source in sources if source.workflow == "regional_news"]
        if mode == "all":
            return sources
        raise ValueError(f"Unknown mode: {mode}")
