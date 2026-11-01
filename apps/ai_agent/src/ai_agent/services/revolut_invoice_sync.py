"""Write Revolut Merchant payment requests into the invoice register.

The pure mapping is in ``integrations/revolut/merchant.py``; this module does the I/O, one
order at a time, so the Inngest sync (``revolut_merchant_sync``) can retry in small steps:

1. The customer becomes a contact (by name, as uploads do).
2. The invoice is upserted on ``(entity_id, origin, external_id)``. Revolut owns everything
   but the notes, which are left alone.
3. Lines are replaced only when Revolut's differ from the stored ones, so an account a person
   chose for a line survives a re-sync.
4. A paid order is linked to the inbound "Merchant payment" that brought the money in,
   through ``InvoiceService.link_payment`` (``matched_by = 'sync'``).
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from ..integrations.revolut.merchant import (
    MATCH_AFTER,
    MATCH_BEFORE,
    ORIGIN,
    PROVIDER,
    invoice_row,
    line_rows,
    pick_transaction,
    same_lines,
    taken_payments,
)
from ..normalization.utils import extract_row, extract_rows
from .invoice_rules import InvoiceRuleError
from .invoice_service import ExtractedContact, invoice_service

logger = logging.getLogger(__name__)

# Statuses whose money has arrived and so should be linked to a bank transaction.
SETTLED = frozenset({"PAID", "PARTIALLY_PAID"})


def _client():
    return invoice_service.client


async def merchant_source_for(parent_source_id: str) -> Optional[Dict[str, Any]]:
    """The Merchant key's integration row for this Revolut integration, if a key was added."""
    return extract_row(
        await asyncio.to_thread(
            lambda: _client()
            .table("external_sources")
            .select("*")
            .eq("provider", PROVIDER)
            .eq("external_account_id", str(parent_source_id))
            .limit(1)
            .execute()
        )
    )


async def _contact_id(entity_id: UUID, order: Dict[str, Any]) -> Optional[str]:
    customer = order.get("customer") or {}
    name = customer.get("full_name") or customer.get("email")
    if not name:
        return None
    contact = await invoice_service.upsert_contact(
        entity_id,
        ExtractedContact(
            name=str(name),
            company_name=None,
            email=customer.get("email"),
            phone=customer.get("phone"),
        ),
        "customer",
    )
    return str(contact["id"])


async def store_payment_request(
    entity_id: UUID, order: Dict[str, Any]
) -> Dict[str, Any]:
    """Upsert one payment request as an invoice. Returns ``{invoice, created, needs_link}``.

    ``needs_link`` is true for a paid invoice with no payment linked yet: the caller then
    reads the full order (the list has no payments) and calls :func:`link_order_payments`.
    """
    client = _client()
    contact_id = await _contact_id(entity_id, order)
    row = invoice_row(str(entity_id), order, contact_id)

    existing = extract_row(
        await asyncio.to_thread(
            lambda: client.table("invoices")
            .select("id, invoice_line_items(description, quantity, unit_cost)")
            .eq("entity_id", str(entity_id))
            .eq("origin", ORIGIN)
            .eq("external_id", row["external_id"])
            .execute()
        )
    )

    if existing:
        invoice_id = existing["id"]
        changes = {
            k: v
            for k, v in row.items()
            if k not in {"entity_id", "origin", "external_id"}
        }
        invoice = extract_row(
            await asyncio.to_thread(
                lambda: client.table("invoices")
                .update(changes)
                .eq("id", invoice_id)
                .execute()
            )
        )
        stored_lines = existing.get("invoice_line_items") or []
    else:
        invoice = extract_row(
            await asyncio.to_thread(
                lambda: client.table("invoices").insert(row).execute()
            )
        )
        if not invoice:
            raise ValueError(f"Could not store Revolut invoice {row['invoice_number']}")
        invoice_id = invoice["id"]
        stored_lines = []

    fresh = line_rows(order)
    if not existing or not same_lines(stored_lines, fresh):
        await asyncio.to_thread(
            lambda: client.table("invoice_line_items")
            .delete()
            .eq("invoice_id", invoice_id)
            .execute()
        )
        if fresh:
            await asyncio.to_thread(
                lambda: client.table("invoice_line_items")
                .insert([{**line, "invoice_id": invoice_id} for line in fresh])
                .execute()
            )

    needs_link = row["status"] in SETTLED and not await invoice_service.list_payments(
        UUID(invoice_id)
    )
    return {"invoice": invoice, "created": not existing, "needs_link": needs_link}


async def _candidates(entity_id: UUID, currency: str, taken_at: datetime) -> List[Dict]:
    """Inbound transactions in the match window, each marked ``linked`` if it already
    pays an invoice."""
    client = _client()
    rows = extract_rows(
        await asyncio.to_thread(
            lambda: client.table("financial_transactions")
            .select("id, direction, amount, currency_code, occurred_at")
            .eq("entity_id", str(entity_id))
            .eq("direction", "in")
            .eq("currency_code", currency)
            .is_("excluded_reason", "null")
            .gte("occurred_at", (taken_at - MATCH_BEFORE).isoformat())
            .lte("occurred_at", (taken_at + MATCH_AFTER).isoformat())
            .execute()
        )
    )
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    taken = {
        r["financial_transaction_id"]
        for r in extract_rows(
            await asyncio.to_thread(
                lambda: client.table("invoice_payments")
                .select("financial_transaction_id")
                .in_("financial_transaction_id", ids)
                .execute()
            )
        )
    }
    return [{**r, "linked": r["id"] in taken} for r in rows]


async def link_order_payments(
    entity_id: UUID, invoice_id: UUID, order: Dict[str, Any]
) -> int:
    """Link each payment on a full order to its bank transaction. Returns how many linked.

    A payment whose transaction has not been synced from the Business API yet is left for
    the next run.
    """
    linked = 0
    for payment in taken_payments(order):
        txn = pick_transaction(
            payment, await _candidates(entity_id, payment.currency, payment.taken_at)
        )
        if not txn:
            logger.info(
                "No bank transaction yet for Revolut payment %s", payment.payment_id
            )
            continue
        try:
            await invoice_service.link_payment(
                entity_id, invoice_id, UUID(txn["id"]), "sync"
            )
            linked += 1
        except (InvoiceRuleError, ValueError) as exc:
            logger.warning(
                "Revolut payment %s not linked to %s: %s",
                payment.payment_id,
                txn["id"],
                exc,
            )
    return linked
