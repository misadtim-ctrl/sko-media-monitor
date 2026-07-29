from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx

from .analyzers import MediaAnalyzer, PublicationAnalyzer
from .analyzers.semantic import SemanticScorer
from .collectors import (
    Collector,
    InstagramCollector,
    InstagramFeedCollector,
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
    bridge_attempted: bool = False
    bridge_delivered: bool = False
    bridge_error: str = ""
    feed_posts: int = 0
    feed_unknown: list[str] = field(default_factory=list)
    lookback_hours: float = 0.0
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
            "bridge_attempted": self.bridge_attempted,
            "bridge_delivered": self.bridge_delivered,
            "bridge_error": self.bridge_error,
            "feed_posts": self.feed_posts,
            "feed_unknown": self.feed_unknown,
            "lookback_hours": self.lookback_hours,
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
        # Лента подписок отдаёт свежие посты всех пабликов одним запросом, поэтому
        # она обслуживает весь список Instagram, а обход по профилям остаётся лишь
        # маленькой ротацией-страховкой внутри `sources`.
        feed_sources = self._feed_sources(mode)
        counted = {source.id for source in sources} | {source.id for source in feed_sources}
        report = RunReport(sources_total=len(counted))
        run_seen: set[str] = set()
        pending_memory: list[tuple[tuple[str, ...], str, bool, bool]] = []
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

            # Сбор Instagram идёт на Mac, а он ночью выключен. После простоя
            # окно расширяется на весь пропуск, иначе утренний запуск потеряет
            # всё, что паблики опубликовали вечером. Повторов это не создаёт:
            # отправленное помнят и локальная база, и таблица Apps Script.
            gap = self.state.hours_since_last_run([source.id for source in feed_sources])
            effective_lookback = min(24.0, max(float(max(1, lookback_hours)), gap + 1.0))
            report.lookback_hours = round(effective_lookback, 1)
            cutoff = datetime.now(UTC) - timedelta(hours=effective_lookback)
            batches = await asyncio.gather(*(collect_source(source) for source in sources))
            batches = await self._merge_feed(batches, feed_sources, cutoff, report, gap)

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
                    allow_python_main = self.settings.enable_python_main_delivery or (
                        publication.workflow != "sko_mentions"
                    )
                    direct_delivery = (
                        self.settings.enable_delivery
                        and allow_python_main
                        and analysis.relevant
                        and telegram.configured_for(publication.workflow)
                    )
                    if direct_delivery and self.state.enqueue(
                        payload_id(publication), publication.workflow, payload
                    ):
                        report.queued += 1
                    pending_memory.append(
                        (keys, publication.source_id, direct_delivery, allow_python_main)
                    )

            bridge_accepted = False
            bridge_items = [
                item
                for item in report.results
                if item["publication"]["workflow"] != "sko_mentions"
                or self.settings.enable_python_main_delivery
            ]
            if bridge_items and self.settings.enable_delivery:
                report.bridge_attempted = True
                bridge_accepted = await sheets.publish(bridge_items)
                report.bridge_delivered = bridge_accepted
                if not bridge_accepted:
                    report.bridge_error = (
                        getattr(sheets, "last_error", "") or "Apps Script did not accept items"
                    )
                    report.errors.append(f"Apps Script bridge: {report.bridge_error}")
            if report.results:
                export_latest(report.results, self.settings.export_dir)
            for keys, source_id, direct_delivery, bridge_delivery in pending_memory:
                if direct_delivery or (bridge_delivery and bridge_accepted):
                    self.state.remember(keys, source_id, ttl_days=365)
            if self.settings.enable_delivery:
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

    async def _merge_feed(
        self,
        batches: tuple[tuple[Source, list[Publication], str, int], ...],
        feed_sources: list[Source],
        cutoff: datetime,
        report: RunReport,
        gap_hours: float = 0.0,
    ) -> list[tuple[Source, list[Publication], str, int]]:
        """Добавляет посты из ленты подписок к результатам обычного обхода."""
        merged: dict[str, list] = {
            source.id: [source, list(publications), error, elapsed]
            for source, publications, error, elapsed in batches
        }
        if not feed_sources:
            return [tuple(row) for row in merged.values()]
        started = time.monotonic()
        try:
            # Обычно хватает трёх страниц, но после ночного простоя лента
            # содержит гораздо больше, и её надо пролистать глубже.
            pages = self.settings.instagram_feed_pages
            if gap_hours > 1.0:
                pages = min(self.settings.instagram_feed_catchup_pages, pages + int(gap_hours) * 2)
            grouped, unknown = await InstagramFeedCollector(self.settings).collect(
                feed_sources, cutoff, pages=pages
            )
        except Exception as exc:
            # Причину пишем один раз подробно, а паблики помечаем непроверенными:
            # 26 несобранных источников — это честная картина, её и показываем.
            LOGGER.warning("Instagram feed failed: %s", exc)
            report.errors.append(f"Лента Instagram: {exc}")
            elapsed = round((time.monotonic() - started) * 1000)
            for source in feed_sources:
                merged.setdefault(source.id, [source, [], "лента Instagram недоступна", elapsed])
            return [tuple(row) for row in merged.values()]
        elapsed = round((time.monotonic() - started) * 1000)
        for source in feed_sources:
            publications = grouped.get(source.id, [])
            row = merged.get(source.id)
            if row is None:
                merged[source.id] = [source, publications, "", elapsed]
            else:
                row[1].extend(publications)
        report.feed_posts = sum(len(items) for items in grouped.values())
        # Паблик может быть в реестре, но в другом потоке — например, редакции
        # вроде pkzsk собираются как региональные СМИ. Незнакомыми считаем лишь
        # тех, кого реестр не знает вовсе.
        known = {
            urlsplit(source.url).path.strip("/").split("/", 1)[0].lower()
            for source in load_sources(self.settings.registry_path)
            if source.platform == "instagram"
        }
        report.feed_unknown = sorted(set(unknown) - known)
        if report.feed_unknown:
            # Аккаунт подписан на паблики, которых нет в реестре. Это не ошибка,
            # но именно такое расхождение когда-то оставило мониторинг без части
            # источников, поэтому список виден в отчёте.
            LOGGER.info("Подписки вне реестра: %s", ", ".join(sorted(unknown)))
        return [tuple(row) for row in merged.values()]

    def _feed_sources(self, mode: str) -> list[Source]:
        if not self.settings.instagram_use_feed:
            return []
        return [source for source in self._mode_sources(mode) if source.platform == "instagram"]

    def _mode_sources(self, mode: str) -> list[Source]:
        sources = [source for source in load_sources(self.settings.registry_path) if source.enabled]
        if not self.settings.instagram_enabled:
            sources = [source for source in sources if source.platform != "instagram"]
        if mode == "main":
            return [source for source in sources if source.workflow == "sko_mentions"]
        if mode == "negative":
            return [source for source in sources if source.workflow == "akimat_negative"]
        if mode == "regional":
            return [source for source in sources if source.workflow == "regional_news"]
        if mode == "all":
            return sources
        raise ValueError(f"Unknown mode: {mode}")

    def _select_sources(self, mode: str) -> list[Source]:
        sources = self._mode_sources(mode)
        if mode != "negative":
            return sources
        if self.settings.meta_access_token and self.settings.meta_ig_user_id:
            return sources
        instagram_sources = [source for source in sources if source.platform == "instagram"]
        # При работающей ленте обход по профилям нужен только как страховка от
        # её ранжирования, поэтому за прогон берём пару профилей, а не тридцать.
        quota = (
            self.settings.instagram_sweep_profiles
            if self.settings.instagram_use_feed
            else self.settings.instagram_profiles_per_run
        )
        selected_ids = set(
            self.state.oldest_source_ids([source.id for source in instagram_sources], quota)
        )
        return [
            source
            for source in sources
            if source.platform != "instagram" or source.id in selected_ids
        ]
