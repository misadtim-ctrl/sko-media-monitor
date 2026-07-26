from sko_monitor.models import SourceRun
from sko_monitor.state import StateStore


def test_seen_and_outbox_are_bounded_technical_state(tmp_path) -> None:
    store = StateStore(tmp_path / "state.sqlite3")
    keys = ("url:https://example.kz/1", "title:example.kz:новость")
    assert not store.is_seen(keys)
    store.remember(keys, "source")
    assert store.is_seen(keys)

    payload = {"publication": {"url": "https://example.kz/1"}, "analysis": {}}
    assert store.enqueue("item-1", "sko_mentions", payload)
    assert not store.enqueue("item-1", "sko_mentions", payload)
    due = store.due_outbox()
    assert len(due) == 1
    store.mark_sent("item-1")
    assert store.stats()["sent_receipts"] == 1


def test_oldest_source_ids_prioritizes_unchecked_then_oldest(tmp_path) -> None:
    store = StateStore(tmp_path / "state.sqlite3")
    store.record_source_run(SourceRun("source-b", True, 0, 1))
    store.record_source_run(SourceRun("source-a", True, 0, 1))

    assert store.oldest_source_ids(["source-a", "source-b", "source-c"], 2) == [
        "source-c",
        "source-b",
    ]
