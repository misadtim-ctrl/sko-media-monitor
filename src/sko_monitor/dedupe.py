from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .models import Publication

TRACKING_KEYS = {
    "fbclid",
    "yclid",
    "gclid",
    "igsh",
    "igshid",
    "mibextid",
    "ref",
    "ref_src",
    "from",
    "source",
    "share",
    "_r",
    "_t",
    "_rdr",
}


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = parts.netloc.lower().removeprefix("www.")
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if host == "t.me" and path.startswith("/s/"):
        path = path[2:]
    if path != "/":
        path = path.rstrip("/")
    query = sorted(
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_KEYS
    )
    return urlunsplit(("https", host, path, urlencode(query), ""))


def normalized_title(title: str, limit: int = 12) -> str:
    title = re.sub(r"\s*[-–—]\s*[^-–—]{2,45}\s*$", " ", title.lower())
    title = re.sub(r"\d{1,2}[./]\d{1,2}[./]\d{2,4}", " ", title)
    words = re.findall(r"[0-9a-zа-яёәғқңөұүһі]+", title, flags=re.IGNORECASE)
    return " ".join(words[:limit])


def source_identity(publication: Publication) -> str:
    host = urlsplit(publication.url).netloc.lower().removeprefix("www.")
    if host.startswith("news.google.") or not host:
        return re.sub(r"\W+", "_", publication.source_name.lower()).strip("_")
    return host


def dedupe_keys(publication: Publication) -> tuple[str, ...]:
    url_key = "url:" + canonical_url(publication.url)
    title = normalized_title(publication.title)
    if not title:
        return (url_key,)
    # Deliberately source-scoped. The same event from another media outlet
    # remains a separate result, as required by the newsroom workflow.
    title_key = f"title:{source_identity(publication)}:{title}"
    return (url_key, title_key)


def payload_id(publication: Publication) -> str:
    raw = f"{publication.workflow}\0{canonical_url(publication.url)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
