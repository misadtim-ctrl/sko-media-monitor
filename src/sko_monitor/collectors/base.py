from __future__ import annotations

from abc import ABC, abstractmethod

import httpx

from ..models import Publication, Source


class CollectorError(RuntimeError):
    pass


class Collector(ABC):
    platforms: frozenset[str]

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    @abstractmethod
    async def collect(self, source: Source) -> list[Publication]:
        raise NotImplementedError

    async def fetch_text(self, url: str) -> str:
        try:
            response = await self.client.get(url, follow_redirects=True)
            response.raise_for_status()
            return response.text
        except httpx.HTTPError as exc:
            raise CollectorError(f"{url}: {exc}") from exc
