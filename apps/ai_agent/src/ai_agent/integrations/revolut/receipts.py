"""Revolut receipts, kept as attachments on the transactions they belong to.

Revolut stores receipts on expenses, not transactions: an expense names its ``transaction_id``
and lists ``receipt_ids``. That covers card receipts, the bills attached to transfers, and
Revolut's own invoices for its fees. The sync (``revolut_sync_receipts``) lists recent expenses,
works out which receipts are new with :func:`receipts_to_fetch`, then downloads each one and
:func:`store_receipt` copies it into the private ``transaction-attachments`` bucket and records it
in ``transaction_attachments`` (see the migration of the same name).
"""

import asyncio
import mimetypes
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Set

from supabase import Client

BUCKET = "transaction-attachments"
SOURCE = "revolut"


@dataclass(frozen=True)
class ReceiptRef:
    """One receipt to fetch: the expense it is on and the transaction it belongs to."""

    expense_id: str
    receipt_id: str
    transaction_id: str


def receipts_to_fetch(
    expenses: Iterable[Dict[str, Any]], known_receipt_ids: Set[str]
) -> List[ReceiptRef]:
    """The receipts on these expenses that are not stored yet.

    An expense without a ``transaction_id`` has nothing to attach to, so it is skipped. A
    receipt listed twice (the same expense on two pages) is fetched once.
    """
    seen = set(known_receipt_ids)
    refs: List[ReceiptRef] = []
    for expense in expenses:
        expense_id = expense.get("id")
        transaction_id = expense.get("transaction_id")
        if not expense_id or not transaction_id:
            continue
        for receipt_id in expense.get("receipt_ids") or []:
            if not isinstance(receipt_id, str) or receipt_id in seen:
                continue
            seen.add(receipt_id)
            refs.append(ReceiptRef(str(expense_id), receipt_id, str(transaction_id)))
    return refs


def _extension(content_type: str) -> str:
    # mimetypes gives ".jpe" for image/jpeg on some platforms.
    if content_type == "image/jpeg":
        return ".jpg"
    return mimetypes.guess_extension(content_type) or ""


def storage_path(entity_id: str, ref: ReceiptRef, content_type: str) -> str:
    """Where the file goes in the bucket: one folder per business, then per transaction."""
    return (
        f"{entity_id}/{SOURCE}/{ref.transaction_id}/{ref.receipt_id}"
        f"{_extension(content_type)}"
    )


def file_name(ref: ReceiptRef, content_type: str) -> str:
    """The name shown in the drawer and used for a download. Revolut gives no file name."""
    return f"Receipt {ref.receipt_id[:8]}{_extension(content_type)}"


async def known_receipt_ids(client: Client, entity_id: str) -> Set[str]:
    """Receipt ids already stored for the business."""
    result = await asyncio.to_thread(
        lambda: client.table("transaction_attachments")
        .select("external_id")
        .eq("entity_id", entity_id)
        .eq("source", SOURCE)
        .execute()
    )
    rows: List[Dict[str, Any]] = result.data or []  # type: ignore[assignment]
    return {str(r["external_id"]) for r in rows}


async def store_receipt(
    client: Client,
    entity_id: str,
    ref: ReceiptRef,
    content: bytes,
    content_type: str,
) -> None:
    """Copy the file into the bucket and record it. Safe to repeat: both steps upsert."""
    path = storage_path(entity_id, ref, content_type)
    await asyncio.to_thread(
        lambda: client.storage.from_(BUCKET).upload(
            path, content, {"content-type": content_type, "upsert": "true"}
        )
    )
    await asyncio.to_thread(
        lambda: client.table("transaction_attachments")
        .upsert(
            {
                "entity_id": entity_id,
                "source": SOURCE,
                "external_transaction_id": ref.transaction_id,
                "external_id": ref.receipt_id,
                "external_parent_id": ref.expense_id,
                "file_path": path,
                "file_name": file_name(ref, content_type),
                "content_type": content_type,
                "size_bytes": len(content),
            },
            on_conflict="source,external_id",
        )
        .execute()
    )
