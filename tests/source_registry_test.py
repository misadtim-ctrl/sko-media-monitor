#!/usr/bin/env python3

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
registry = json.loads((ROOT / "config" / "sources.json").read_text(encoding="utf-8"))
sources = registry["sources"]

assert registry["source_count"] == 158
assert len(sources) == 158
assert len({source["id"] for source in sources}) == len(sources)
assert len({source["url"].lower().rstrip("/") for source in sources}) == len(sources)

platforms = Counter(source["platform"] for source in sources)
assert platforms == {
    "website": 42,
    "instagram": 40,
    "telegram": 41,
    "youtube": 9,
    "threads": 9,
    "vk": 6,
    "facebook": 6,
    "tiktok": 5,
}

assert sum(
    source["platform"] == "instagram" and source["workflow"] == "akimat_negative"
    for source in sources
) == 32
assert sum(
    source["platform"] == "telegram" and source["workflow"] == "sko_mentions"
    for source in sources
) == 41
assert sum(source["enabled"] is False for source in sources) == 3

print("Source registry tests: OK")
