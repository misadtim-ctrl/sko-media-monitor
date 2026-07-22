from sko_monitor.dedupe import canonical_url, dedupe_keys
from sko_monitor.models import Publication


def publication(source: str, url: str) -> Publication:
    return Publication(
        source_id=source,
        source_name=source,
        platform="website",
        workflow="sko_mentions",
        url=url,
        title="В СКО открыли новую школу",
    )


def test_tracking_parameters_do_not_change_url() -> None:
    assert canonical_url("https://www.example.kz/news/1?utm_source=x&fbclid=y") == (
        "https://example.kz/news/1"
    )


def test_same_title_is_scoped_to_media_site() -> None:
    site_a = dedupe_keys(publication("A", "https://site-a.kz/news/1"))
    site_a_again = dedupe_keys(publication("A", "https://site-a.kz/news/2"))
    site_b = dedupe_keys(publication("B", "https://site-b.kz/news/1"))
    assert site_a[1] == site_a_again[1]
    assert site_a[1] != site_b[1]


def test_same_telegram_link_variants_share_key() -> None:
    assert canonical_url("https://t.me/s/channel/123") == canonical_url("https://t.me/channel/123")
