"""Storing raw events: a changed record is queued again without touching the others."""

import asyncio
from typing import Any, Dict, List, Tuple

from ai_agent.services.external_sync_service import ExternalSyncService


class RecordingTable:
    def __init__(self, calls: List[List[Dict[str, Any]]]):
        self.calls = calls
        self.rows: List[Dict[str, Any]] = []

    def upsert(self, rows, on_conflict=None):
        self.rows = rows
        return self

    def execute(self):
        self.calls.append(self.rows)
        return type("Result", (), {"data": self.rows})()


class RecordingClient:
    def __init__(self):
        self.calls: List[List[Dict[str, Any]]] = []

    def table(self, name: str) -> RecordingTable:
        assert name == "external_raw_events"
        return RecordingTable(self.calls)


def event(external_id: str, payload: Dict[str, Any], entity_type: str = "product"):
    return {
        "entity_type": entity_type,
        "external_id": external_id,
        "payload": payload,
        "occurred_at": None,
    }


def store(existing: Dict[Tuple[str, str], Dict[str, Any]], events):
    service = ExternalSyncService()
    client = RecordingClient()
    service._client = client

    async def fake_existing(provider, evs):
        return existing

    service._get_existing_payloads = fake_existing  # type: ignore[method-assign]
    stored = asyncio.run(service.store_raw_events_batch("src", "shopify", events))
    return stored, client.calls


class TestStoreRawEventsBatch:
    def test_rows_that_reset_their_status_are_stored_apart_from_the_rest(self):
        # One record changed at the source, one did not, one is new. A bulk upsert gives a
        # column missing from a row NULL, which would wipe the status of the unchanged
        # record and leave the new one with none.
        existing = {
            ("product", "changed"): {
                "processing_status": "completed",
                "payload": {"v": 1},
            },
            ("product", "same"): {
                "processing_status": "completed",
                "payload": {"v": 1},
            },
        }
        stored, calls = store(
            existing,
            [
                event("changed", {"v": 2}),
                event("same", {"v": 1}),
                event("new", {"v": 1}),
            ],
        )

        assert stored == 3
        assert len(calls) == 2
        for rows in calls:
            assert len({frozenset(row) for row in rows}) == 1
        by_id = {row["external_id"]: row for rows in calls for row in rows}
        assert by_id["changed"]["processing_status"] == "pending"
        assert "processing_status" not in by_id["same"]
        assert "processing_status" not in by_id["new"]

    def test_inventory_levels_are_always_queued_again(self):
        _, calls = store({}, [event("a_1", {"available": 3}, "inventory_item")])
        assert calls[0][0]["processing_status"] == "pending"

    def test_one_call_when_every_row_is_alike(self):
        _, calls = store({}, [event("a", {}), event("b", {})])
        assert len(calls) == 1
