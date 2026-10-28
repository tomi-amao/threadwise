"""Revolut receipts: which to fetch, where they go, and paging through expenses."""

import asyncio
from typing import Any, Dict, List

import httpx

from ai_agent.integrations.revolut import EXPENSES_URL, RevolutAdapter
from ai_agent.integrations.revolut.receipts import (
    ReceiptRef,
    file_name,
    receipts_to_fetch,
    storage_path,
)

RECEIPT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
RECEIPT_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def expense(id: str, transaction_id: Any, receipt_ids: List[str]) -> Dict[str, Any]:
    return {"id": id, "transaction_id": transaction_id, "receipt_ids": receipt_ids}


class TestReceiptsToFetch:
    def test_new_receipts_with_their_transaction(self):
        refs = receipts_to_fetch(
            [expense("exp-1", "txn-1", [RECEIPT_A]), expense("exp-2", "txn-2", [])],
            known_receipt_ids=set(),
        )
        assert refs == [ReceiptRef("exp-1", RECEIPT_A, "txn-1")]

    def test_skips_receipts_already_stored(self):
        refs = receipts_to_fetch(
            [expense("exp-1", "txn-1", [RECEIPT_A, RECEIPT_B])],
            known_receipt_ids={RECEIPT_A},
        )
        assert refs == [ReceiptRef("exp-1", RECEIPT_B, "txn-1")]

    def test_skips_expenses_with_no_transaction(self):
        assert receipts_to_fetch([expense("exp-1", None, [RECEIPT_A])], set()) == []

    def test_a_receipt_listed_twice_is_fetched_once(self):
        # The same expense can come back on two pages: paging is by date, inclusive.
        twice = [expense("exp-1", "txn-1", [RECEIPT_A])] * 2
        assert len(receipts_to_fetch(twice, set())) == 1


class TestNaming:
    ref = ReceiptRef("exp-1", RECEIPT_A, "txn-1")

    def test_storage_path_is_per_business_and_transaction(self):
        assert (
            storage_path("ent-1", self.ref, "application/pdf")
            == f"ent-1/revolut/txn-1/{RECEIPT_A}.pdf"
        )

    def test_jpeg_gets_jpg(self):
        assert storage_path("ent-1", self.ref, "image/jpeg").endswith(".jpg")
        assert file_name(self.ref, "image/jpeg") == "Receipt 11111111.jpg"

    def test_unknown_type_has_no_extension(self):
        assert file_name(self.ref, "application/x-unknown") == "Receipt 11111111"


class TestRevolutAdapterExpenses:
    def test_list_expenses_pages_back_by_expense_date(self, monkeypatch):
        pages = [
            [
                {"id": "e1", "expense_date": "2026-10-03T00:00:00Z"},
                {"id": "e2", "expense_date": "2026-10-02T00:00:00Z"},
            ],
            [{"id": "e3", "expense_date": "2026-10-01T00:00:00Z"}],
        ]
        calls: List[Dict[str, Any]] = []

        async def fake_request(url: str, params: Dict[str, Any]) -> Any:
            assert url == EXPENSES_URL
            calls.append(dict(params))
            return pages[len(calls) - 1]

        adapter = RevolutAdapter(api_key="k", page_size=2)
        monkeypatch.setattr(adapter, "_make_request", fake_request)

        async def collect() -> List[str]:
            return [e["id"] async for e in adapter.list_expenses()]

        ids = asyncio.run(collect())

        assert ids == ["e1", "e2", "e3"]
        assert "to" not in calls[0]
        assert calls[1]["to"] == "2026-10-02T00:00:00Z"

    def test_download_receipt_returns_bytes_and_type(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path.endswith(
                f"/expenses/exp-1/receipts/{RECEIPT_A}/content"
            )
            assert request.headers["authorization"] == "Bearer k"
            return httpx.Response(
                200,
                content=b"%PDF-1.4",
                headers={"content-type": "application/pdf; x=1"},
            )

        real_client = httpx.AsyncClient

        def client_with_mock(**kwargs: Any) -> httpx.AsyncClient:
            return real_client(transport=httpx.MockTransport(handler), **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", client_with_mock)

        content, content_type = asyncio.run(
            RevolutAdapter(api_key="k").download_receipt("exp-1", RECEIPT_A)
        )

        assert content == b"%PDF-1.4"
        assert content_type == "application/pdf"
