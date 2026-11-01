"""Read Revolut receipts, and put the supplier invoices among them in the invoice register.

The receipts sync (``integrations/revolut/receipts.py``) copies every file Revolut keeps on an
expense onto its transaction as a ``transaction_attachments`` row. Most are card or till
receipts; some are a supplier's invoice or bill, or Revolut's own invoice for its fees. This
module reads each stored file once (the Inngest function ``revolut_read_receipts`` calls
:func:`read_attachment` in small batches):

1. Wait for the transaction. A receipt can be stored before its transaction is normalised; it
   is left unread until the transaction is there, since an invoice is filed against it.
2. Classify the file (:class:`ReceiptReading`): ``invoice``, ``receipt`` or ``other``. Only
   invoices go further.
3. An invoice on money going out becomes a PURCHASE invoice with ``origin = 'revolut_expense'``,
   ``external_id`` the receipt id and ``attachment_id`` the file. It is read with the same
   extraction as an upload, is ``PAID`` (the transaction it is on paid it) and is linked to that
   transaction (``matched_by = 'sync'``). Nothing is posted: the transaction is journaled on its
   own.
4. If the transaction already pays an invoice (someone uploaded it, or another file on the same
   expense was read first), no second invoice is made; the file is attached to that invoice if
   it has no document yet.

A failed read is recorded on the row and tried again on a later run, up to ``MAX_ATTEMPTS``.
Deleting an invoice made here does not bring it back: the file is already marked read.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Set
from uuid import UUID

from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

from ..core.config import Settings
from ..normalization.utils import extract_row, extract_rows
from .invoice_rules import InvoiceRuleError
from .invoice_service import ExtractedInvoice, document_part, invoice_service
from .journal_service import journal_service

logger = logging.getLogger(__name__)

settings = Settings()

BUCKET = "transaction-attachments"
ORIGIN = "revolut_expense"
SOURCE = "revolut"
MAX_ATTEMPTS = 3

Outcome = Literal[
    "waiting",  # the transaction is not normalised yet: read on a later run
    "receipt",
    "other",
    "invoice_created",
    "invoice_attached",  # the transaction already pays an invoice: the file was added to it
    "invoice_skipped",  # an invoice, but on money coming in, or already in the register
    "failed",
]


class ReceiptReading(BaseModel):
    """What a file on an expense is."""

    kind: Literal["invoice", "receipt", "other"] = Field(
        ...,
        description=(
            "invoice: an invoice or bill FROM a supplier TO our business: it names the "
            "seller, usually has an invoice or bill number, and lists what was bought. "
            "Revolut's own invoices for its fees count. "
            "receipt: proof that a payment was made that is not an invoice: a card or till "
            "receipt, an order or payment confirmation, a screenshot of a checkout. "
            "other: anything else (a photo of goods, a contract, a statement, unreadable)."
        ),
    )
    reason: str = Field(..., description="One short sentence saying why")


def is_readable(content_type: str) -> bool:
    """PDFs and images can be read; anything else is filed as ``other`` unread."""
    return content_type == "application/pdf" or content_type.startswith("image/")


def describe_transaction(txn: Dict[str, Any]) -> str:
    """The transaction as context for the model: what, who, how much, when."""
    parts = [
        f"{'Money out' if txn.get('direction') == 'out' else 'Money in'}: "
        f"{abs(float(txn.get('amount') or 0)):.2f} {txn.get('currency_code') or ''}".strip(),
        f"on {str(txn.get('occurred_at') or '')[:10]}",
    ]
    who = txn.get("counterparty_name") or txn.get("description")
    if who:
        parts.append(f"to/from '{who}'")
    return ", ".join(parts)


def complete_extraction(
    extracted: ExtractedInvoice, txn: Dict[str, Any], receipt_id: str
) -> ExtractedInvoice:
    """Fill what the document did not say from the transaction it is on.

    The register needs a number and a date (both required), and a total: an invoice with no
    readable amounts takes the transaction's. It is always a purchase: the file is on money
    going out.
    """
    filled = extracted.model_copy(deep=True)
    filled.invoice_type = "PURCHASE"
    if not filled.invoice_number:
        filled.invoice_number = f"RCPT-{receipt_id[:8]}"
    if not filled.invoice_date:
        filled.invoice_date = str(txn.get("occurred_at") or "")[:10] or None
    no_amounts = (
        filled.gross_amount is None
        and filled.net_amount is None
        and filled.tax_amount is None
    )
    if no_amounts:
        filled.gross_amount = abs(float(txn.get("amount") or 0))
        filled.currency = str(txn.get("currency_code") or filled.currency)
    return filled


def _client():
    return invoice_service.client


# How many unread rows to look through for ones whose transaction is in.
UNREAD_SCAN = 1000


def with_transactions(
    rows: List[Dict[str, Any]], transaction_ids: Set[str], limit: int
) -> List[Dict[str, Any]]:
    """The first ``limit`` rows whose transaction has been normalised. The rest wait, so a
    file whose transaction never arrives cannot hold up the ones behind it."""
    return [r for r in rows if r["external_transaction_id"] in transaction_ids][:limit]


async def unread_attachments(entity_id: str, limit: int) -> List[Dict[str, Any]]:
    """Files ready to read (not read yet, not given up on, their transaction is in), oldest
    first."""
    client = _client()
    rows = extract_rows(
        await asyncio.to_thread(
            lambda: client.table("transaction_attachments")
            .select(
                "id, entity_id, source, external_transaction_id, external_id, "
                "file_path, file_name, content_type, read_attempts"
            )
            .eq("entity_id", entity_id)
            .eq("source", SOURCE)
            .is_("read_at", "null")
            .lt("read_attempts", MAX_ATTEMPTS)
            .order("created_at")
            .limit(UNREAD_SCAN)
            .execute()
        )
    )
    wanted = sorted({str(r["external_transaction_id"]) for r in rows})
    present: Set[str] = set()
    for start in range(0, len(wanted), 200):  # keep the URL short
        ids = wanted[start : start + 200]
        present |= {
            str(t["external_transaction_id"])
            for t in extract_rows(
                await asyncio.to_thread(
                    lambda: client.table("financial_transactions")
                    .select("external_transaction_id")
                    .eq("entity_id", entity_id)
                    .eq("source", SOURCE)
                    .in_("external_transaction_id", ids)
                    .execute()
                )
            )
        }
    return with_transactions(rows, present, limit)


async def _transaction(entity_id: str, external_id: str) -> Optional[Dict[str, Any]]:
    return extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("financial_transactions")
            .select(
                "id, direction, amount, currency_code, occurred_at, description, "
                "counterparty_name"
            )
            .eq("entity_id", entity_id)
            .eq("source", SOURCE)
            .eq("external_transaction_id", external_id)
            .limit(1)
            .execute()
        )
    )


async def _mark(attachment_id: str, **fields: Any) -> None:
    await asyncio.to_thread(
        lambda: _client()
        .table("transaction_attachments")
        .update(fields)
        .eq("id", attachment_id)
        .execute()
    )


async def _mark_read(attachment_id: str, kind: str) -> None:
    await _mark(
        attachment_id,
        document_kind=kind,
        read_at=datetime.now(timezone.utc).isoformat(),
        read_error=None,
    )


async def classify(
    content: bytes, content_type: str, entity_name: str, txn: Dict[str, Any]
) -> ReceiptReading:
    """Ask the model what the file is."""
    model = init_chat_model(settings.default_chat_model).with_structured_output(
        ReceiptReading
    )
    prompt = (
        f"This file is attached to a bank transaction of the business '{entity_name}' "
        f"({describe_transaction(txn)}). Say what kind of document it is."
    )
    message = {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            document_part(content, content_type),
        ],
    }
    result = await asyncio.to_thread(lambda: model.invoke([message]))
    return result  # type: ignore[return-value]


async def _invoice_paid_by(transaction_id: str) -> Optional[Dict[str, Any]]:
    """The invoice this transaction already pays, if any."""
    link = extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoice_payments")
            .select("invoices(id, file_path, attachment_id)")
            .eq("financial_transaction_id", transaction_id)
            .limit(1)
            .execute()
        )
    )
    return (link or {}).get("invoices")


async def _already_filed(entity_id: str, receipt_id: str) -> bool:
    row = extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("invoices")
            .select("id")
            .eq("entity_id", entity_id)
            .eq("origin", ORIGIN)
            .eq("external_id", receipt_id)
            .limit(1)
            .execute()
        )
    )
    return row is not None


def _entity_name(entity: Optional[Dict[str, Any]]) -> str:
    return (
        (entity.get("name") or entity.get("legal_name")) if entity else None
    ) or "our business"


async def _file_invoice(
    entity_id: UUID,
    entity: Optional[Dict[str, Any]],
    attachment: Dict[str, Any],
    txn: Dict[str, Any],
    content: bytes,
) -> Dict[str, Any]:
    """Extract the invoice, store it as paid and link it to its transaction."""
    try:
        coa = await journal_service.get_chart_of_accounts(entity_id)
    except Exception as exc:
        logger.warning("No chart of accounts for receipt extraction: %s", exc)
        coa = []

    extracted = complete_extraction(
        await invoice_service.extract_invoice_data(
            content,
            attachment["content_type"],
            file_name=attachment["file_name"],
            entity_name=_entity_name(entity),
            entity_details=entity,
            chart_of_accounts=coa,
            invoice_type_hint="PURCHASE",
        ),
        txn,
        attachment["external_id"],
    )
    contact = await invoice_service.upsert_contact(
        entity_id, extracted.counterparty, "supplier"
    )
    invoice = await invoice_service.create_invoice(
        entity_id,
        extracted,
        UUID(contact["id"]),
        source=SOURCE,
        status="PAID",
        origin=ORIGIN,
        external_id=attachment["external_id"],
        attachment_id=attachment["id"],
    )
    await invoice_service.create_line_items(
        UUID(invoice["id"]),
        extracted.line_items,
        chart_of_accounts=coa,
        invoice_type="PURCHASE",
        entity_id=entity_id,
    )
    try:
        await invoice_service.link_payment(
            entity_id, UUID(invoice["id"]), UUID(txn["id"]), "sync"
        )
    except (InvoiceRuleError, ValueError) as exc:
        # Left out of the books (an excluded transaction): the invoice still says it is paid.
        logger.info("Receipt invoice %s not linked: %s", invoice["id"], exc)
    return invoice


async def read_attachment(
    entity_id: UUID, attachment: Dict[str, Any]
) -> Dict[str, Any]:
    """Read one stored file. Returns ``{outcome, invoice_id}``; never raises for a bad file.

    A failure is recorded on the row (``read_attempts``, ``read_error``) so the batch goes on
    and the file is tried again next run.
    """
    entity = str(entity_id)
    attachment_id = str(attachment["id"])
    txn = await _transaction(entity, str(attachment["external_transaction_id"]))
    if not txn:
        return {"outcome": "waiting", "invoice_id": None}

    if not is_readable(str(attachment.get("content_type") or "")):
        await _mark_read(attachment_id, "other")
        return {"outcome": "other", "invoice_id": None}

    try:
        content: bytes = await asyncio.to_thread(
            lambda: _client().storage.from_(BUCKET).download(attachment["file_path"])
        )
        entity_row = await invoice_service._fetch_entity(entity_id)
        reading = await classify(
            content, attachment["content_type"], _entity_name(entity_row), txn
        )
        if reading.kind != "invoice":
            await _mark_read(attachment_id, reading.kind)
            return {"outcome": reading.kind, "invoice_id": None}

        if txn.get("direction") != "out" or await _already_filed(
            entity, str(attachment["external_id"])
        ):
            await _mark_read(attachment_id, "invoice")
            return {"outcome": "invoice_skipped", "invoice_id": None}

        paid = await _invoice_paid_by(str(txn["id"]))
        if paid:
            if not paid.get("file_path") and not paid.get("attachment_id"):
                await asyncio.to_thread(
                    lambda: _client()
                    .table("invoices")
                    .update({"attachment_id": attachment_id})
                    .eq("id", paid["id"])
                    .execute()
                )
            await _mark_read(attachment_id, "invoice")
            return {"outcome": "invoice_attached", "invoice_id": paid["id"]}

        invoice = await _file_invoice(entity_id, entity_row, attachment, txn, content)
        await _mark_read(attachment_id, "invoice")
        return {"outcome": "invoice_created", "invoice_id": invoice["id"]}
    except Exception as exc:  # one unreadable file must not stop the rest
        logger.warning("Could not read attachment %s: %s", attachment_id, exc)
        await _mark(
            attachment_id,
            read_attempts=int(attachment.get("read_attempts") or 0) + 1,
            read_error=str(exc)[:500],
        )
        return {"outcome": "failed", "invoice_id": None}
