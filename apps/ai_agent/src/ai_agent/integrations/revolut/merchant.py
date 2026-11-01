"""Revolut Merchant payment requests, kept as the business's sales invoices.

An invoice sent from Revolut Business is a Merchant API order of type ``payment_request``:
the invoice number is ``merchant_order_data.reference``, the customer is ``customer``, the
lines are ``line_items`` and the state says whether it has been paid. Revolut is the source
of truth, so the sync (``revolut_merchant_sync``) copies each one into ``invoices`` with
``origin = 'revolut_merchant'`` and ``external_id`` = the order id, and the app treats it as
read-only. Revolut offers no PDF, due date or tax breakdown for them.

Paid orders are linked to their bank transaction. Each payment reaches the Business API as an
inbound "Merchant payment" for the same gross amount a few seconds after the payment, with no
id in common, so :func:`pick_transaction` matches on amount, currency and time.

The Merchant API has its own secret key (Merchant, APIs in Revolut Business), separate from
the Business API token. Each integration row holds one Vault key, so the Merchant key has its
own row, provider ``revolut_merchant``, whose ``external_account_id`` is the id of the Revolut
integration it belongs to. The app shows the two as one Revolut integration, and
``payment_requests`` is one of its endpoints.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional

import httpx

MERCHANT_BASE_URL = os.environ.get(
    "REVOLUT_MERCHANT_API_URL", "https://merchant.revolut.com"
)
# Pinned: the response shape (an object wrapping "orders") depends on it.
API_VERSION = "2024-09-01"
ORIGIN = "revolut_merchant"
ORDER_TYPE = "payment_request"
# The Merchant key's integration row, a child of the Revolut one (see the module docstring).
PROVIDER = "revolut_merchant"
# The Revolut integration's endpoint for these invoices (sync state, "Sync one thing").
ENDPOINT = "payment_requests"

# ISO 4217 currencies without minor units; Revolut gives amounts in minor units.
ZERO_DECIMAL = frozenset(
    {"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG"}
)
ZERO_DECIMAL |= frozenset({"RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"})

# Order states, and what they make the invoice.
OPEN_STATES = frozenset({"pending", "processing", "authorised"})
CANCELLED_STATES = frozenset({"cancelled", "failed", "declined"})
# Payment states that mean the money was taken.
TAKEN_PAYMENT_STATES = frozenset({"captured", "completed", "settled"})

# How far from the payment the Business API's "Merchant payment" may be. Observed: 2 to 3
# seconds after; the window allows for a delayed capture.
MATCH_BEFORE = timedelta(minutes=10)
MATCH_AFTER = timedelta(days=2)


def to_major(amount: Any, currency: Optional[str]) -> Decimal:
    """Minor units (pence, cents) to the amount, e.g. 140789 GBP -> 1407.89."""
    value = Decimal(str(amount or 0))
    if (currency or "").upper() in ZERO_DECIMAL:
        return value
    return value / Decimal(100)


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def is_invoice(order: Dict[str, Any]) -> bool:
    """A payment request is an invoice; other orders (checkout, refunds) are not."""
    return order.get("type") == ORDER_TYPE


def invoice_number(order: Dict[str, Any]) -> str:
    """The reference the business gave it (INV-5), else a short form of the order id."""
    reference = (order.get("merchant_order_data") or {}).get("reference")
    return str(reference or f"RVL-{str(order.get('id', ''))[:8]}")


def invoice_status(order: Dict[str, Any]) -> str:
    """What Revolut's state makes the invoice.

    ``completed`` is paid, unless an amount is still outstanding (part paid). Cancelled and
    failed requests are cancelled. Everything else is open, waiting for payment.
    """
    state = (order.get("state") or "").lower()
    if state in CANCELLED_STATES:
        return "CANCELLED"
    if state == "completed":
        outstanding = Decimal(str(order.get("outstanding_amount") or 0))
        return "PARTIALLY_PAID" if outstanding > 0 else "PAID"
    return "OPEN"


def invoice_row(
    entity_id: str, order: Dict[str, Any], contact_id: Optional[str]
) -> Dict[str, Any]:
    """The ``invoices`` row for a payment request. The order amount is the total: the lines
    describe it but need not add up to it (a deposit request lists the whole order)."""
    currency = (order.get("currency") or "GBP").upper()
    total = to_major(order.get("amount"), currency)
    return {
        "entity_id": entity_id,
        "origin": ORIGIN,
        "external_id": str(order["id"]),
        "invoice_number": invoice_number(order),
        "invoice_type": "SALE",
        "status": invoice_status(order),
        "counterparty_id": contact_id,
        "currency": currency,
        # Revolut gives no tax breakdown (and the business is not VAT registered).
        "net_amount": float(total),
        "tax_amount": 0,
        "gross_amount": float(total),
        "invoice_date": order.get("created_at"),
        "source": "revolut",
    }


def line_rows(order: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The invoice's lines, without the invoice id (the caller adds it)."""
    currency = order.get("currency")
    rows = []
    for item in order.get("line_items") or []:
        quantity = Decimal(str((item.get("quantity") or {}).get("value") or 1))
        rows.append(
            {
                "description": str(item.get("name") or "Item"),
                "quantity": float(quantity),
                "unit_cost": float(to_major(item.get("unit_price_amount"), currency)),
                "vat_rate": 0,
                "tax_code": "NON_VAT",
            }
        )
    return rows


def same_lines(stored: Iterable[Dict[str, Any]], fresh: List[Dict[str, Any]]) -> bool:
    """Whether the stored lines already say what Revolut does, so they (and any account a
    person chose for them) can stay as they are."""

    def key(row: Dict[str, Any]):
        return (
            row.get("description"),
            Decimal(str(row.get("quantity") or 0)),
            Decimal(str(row.get("unit_cost") or 0)),
        )

    return sorted(map(key, stored)) == sorted(map(key, fresh))


@dataclass(frozen=True)
class TakenPayment:
    """A payment on an order that took the money, in the order's terms."""

    payment_id: str
    amount: Decimal
    currency: str
    taken_at: datetime


def taken_payments(order: Dict[str, Any]) -> List[TakenPayment]:
    """The payments that took money, from a full order (``GET /api/orders/{id}``)."""
    out = []
    for payment in order.get("payments") or []:
        if (payment.get("state") or "").lower() not in TAKEN_PAYMENT_STATES:
            continue
        taken_at = _parse(payment.get("created_at"))
        if not taken_at:
            continue
        currency = (payment.get("currency") or order.get("currency") or "").upper()
        out.append(
            TakenPayment(
                payment_id=str(payment.get("id")),
                amount=to_major(payment.get("amount"), currency),
                currency=currency,
                taken_at=taken_at,
            )
        )
    return out


def pick_transaction(
    payment: TakenPayment, candidates: Iterable[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """The inbound bank transaction that is this payment, or None.

    Same amount and currency, inbound, within the match window, not already paying an
    invoice (``linked`` set by the caller); the closest in time wins.
    """
    best: Optional[Dict[str, Any]] = None
    best_gap: Optional[timedelta] = None
    for txn in candidates:
        if txn.get("linked") or txn.get("direction") != "in":
            continue
        if (txn.get("currency_code") or "").upper() != payment.currency:
            continue
        if Decimal(str(txn.get("amount") or 0)) != payment.amount:
            continue
        occurred = _parse(txn.get("occurred_at"))
        if not occurred:
            continue
        gap = occurred - payment.taken_at
        if gap < -MATCH_BEFORE or gap > MATCH_AFTER:
            continue
        if best_gap is None or abs(gap) < best_gap:
            best, best_gap = txn, abs(gap)
    return best


class MerchantAdapter:
    """The Merchant API calls the sync needs: list orders, read one."""

    def __init__(self, api_key: str, timeout: float = 30.0):
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Revolut-Api-Version": API_VERSION,
            "Accept": "application/json",
            "User-Agent": "ThreadWise/1.0",
        }
        self.timeout = timeout

    async def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{MERCHANT_BASE_URL}{path}", headers=self._headers, params=params
            )
            response.raise_for_status()
            return response.json()

    async def list_orders(self, page_size: int = 100) -> AsyncIterator[Dict[str, Any]]:
        """Every order, newest first.

        The documented filters are ``from``/``to`` on the creation time and the paging is
        not described, so this pages backwards: each request asks for orders created up to
        the oldest one seen, skips ids already yielded (whether ``to`` is inclusive or not)
        and stops when a page brings nothing new.
        """
        seen: set = set()
        to: Optional[str] = None
        while True:
            params: Dict[str, Any] = {"limit": page_size}
            if to:
                params["to"] = to
            body = await self._get("/api/orders", params)
            orders = body.get("orders", []) if isinstance(body, dict) else body or []
            fresh = [o for o in orders if o.get("id") not in seen]
            for order in fresh:
                seen.add(order.get("id"))
                yield order
            if not fresh or len(orders) < page_size:
                return
            to = min(str(o.get("created_at") or "") for o in orders) or None
            if not to:
                return

    async def get_order(self, order_id: str) -> Dict[str, Any]:
        """One order with its payments (the list leaves them out)."""
        return dict(await self._get(f"/api/orders/{order_id}"))
