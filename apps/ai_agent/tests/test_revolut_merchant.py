"""Tests for turning Revolut Merchant payment requests into invoices (no network, no DB).

The orders are shaped like real ``GET /api/orders`` and ``GET /api/orders/{id}`` responses
(API version 2024-09-01), with made-up names and amounts.
"""

import asyncio
from decimal import Decimal

import pytest

from ai_agent.integrations.revolut import merchant
from ai_agent.integrations.revolut.merchant import (
    MerchantAdapter,
    TakenPayment,
    invoice_number,
    invoice_row,
    invoice_status,
    is_invoice,
    line_rows,
    pick_transaction,
    same_lines,
    taken_payments,
    to_major,
)


def order(**overrides):
    base = {
        "id": "6ae0b403-557a-afb1-8715-976d5f770f95",
        "type": "payment_request",
        "state": "completed",
        "created_at": "2026-10-27T14:24:03.827877Z",
        "amount": 140789,
        "currency": "GBP",
        "outstanding_amount": 0,
        "description": "Northgate",
        "customer": {"full_name": "Northgate Boutique", "email": "a@example.com"},
        "merchant_order_data": {"reference": "INV-5"},
        "line_items": [
            {
                "name": "Trousers",
                "unit_price_amount": 78864,
                "quantity": {"value": 1, "unit": "UNIT"},
                "total_amount": 78864,
            },
            {
                "name": "Cap",
                "unit_price_amount": 31925,
                "quantity": {"value": 2, "unit": "UNIT"},
                "total_amount": 63850,
            },
        ],
    }
    return {**base, **overrides}


def payment(**overrides):
    base = {
        "id": "6ae271dd-9883-ae4c-b8b1-c0036c38dbbd",
        "state": "captured",
        "created_at": "2026-10-28T22:06:21.246684Z",
        "amount": 140789,
        "currency": "GBP",
        "settled_amount": 139361,
        "fees": [{"type": "acquiring", "amount": 1428, "currency": "GBP"}],
    }
    return {**base, **overrides}


class TestMapping:
    def test_amounts_are_minor_units(self):
        assert to_major(140789, "GBP") == Decimal("1407.89")
        assert to_major(3540000, "ZAR") == Decimal("35400")
        assert to_major(5000, "JPY") == Decimal("5000")  # no minor unit

    def test_only_payment_requests_are_invoices(self):
        assert is_invoice(order())
        assert not is_invoice(order(type="payment"))
        assert not is_invoice(order(type="refund"))

    def test_the_number_is_the_reference_or_a_short_order_id(self):
        assert invoice_number(order()) == "INV-5"
        assert invoice_number(order(merchant_order_data=None)) == "RVL-6ae0b403"

    @pytest.mark.parametrize(
        "state,outstanding,expected",
        [
            ("pending", 125841, "OPEN"),
            ("processing", 125841, "OPEN"),
            ("authorised", 125841, "OPEN"),
            ("completed", 0, "PAID"),
            ("completed", 500, "PARTIALLY_PAID"),
            ("cancelled", 100, "CANCELLED"),
            ("failed", 100, "CANCELLED"),
        ],
    )
    def test_status_follows_revolut(self, state, outstanding, expected):
        o = order(state=state, outstanding_amount=outstanding)
        assert invoice_status(o) == expected

    def test_the_row_is_a_sale_from_revolut_with_the_order_amount_as_total(self):
        row = invoice_row("e-1", order(), "c-1")
        assert row["origin"] == "revolut_merchant"
        assert row["external_id"] == "6ae0b403-557a-afb1-8715-976d5f770f95"
        assert row["invoice_type"] == "SALE" and row["status"] == "PAID"
        assert row["gross_amount"] == 1407.89 and row["tax_amount"] == 0
        assert row["counterparty_id"] == "c-1"
        assert row["invoice_date"] == "2026-10-27T14:24:03.827877Z"

    def test_the_total_wins_when_the_lines_do_not_add_up(self):
        # A deposit request: 119 caps at 700 listed, 35,400 asked for.
        deposit = order(
            amount=3540000,
            currency="ZAR",
            line_items=[
                {
                    "name": "Cap wholesale",
                    "unit_price_amount": 70000,
                    "quantity": {"value": 119, "unit": "UNIT"},
                }
            ],
        )
        assert invoice_row("e", deposit, None)["gross_amount"] == 35400
        (line,) = line_rows(deposit)
        assert line["quantity"] == 119 and line["unit_cost"] == 700

    def test_lines_carry_quantity_and_unit_price_without_vat(self):
        assert line_rows(order()) == [
            {
                "description": "Trousers",
                "quantity": 1.0,
                "unit_cost": 788.64,
                "vat_rate": 0,
                "tax_code": "NON_VAT",
            },
            {
                "description": "Cap",
                "quantity": 2.0,
                "unit_cost": 319.25,
                "vat_rate": 0,
                "tax_code": "NON_VAT",
            },
        ]

    def test_stored_lines_that_match_are_left_alone(self):
        stored = [
            {"description": "Cap", "quantity": "2.0", "unit_cost": "319.2500"},
            {"description": "Trousers", "quantity": 1, "unit_cost": 788.64},
        ]
        assert same_lines(stored, line_rows(order()))
        assert not same_lines(stored[:1], line_rows(order()))


class TestPaymentMatching:
    def test_only_payments_that_took_money_count(self):
        full = order(
            payments=[
                payment(),
                payment(id="p2", state="declined"),
                payment(id="p3", state="pending"),
            ]
        )
        (taken,) = taken_payments(full)
        assert taken.amount == Decimal("1407.89") and taken.currency == "GBP"

    def _txn(self, **overrides):
        base = {
            "id": "t1",
            "direction": "in",
            "amount": "1407.8900",
            "currency_code": "GBP",
            "occurred_at": "2026-10-28T22:06:24.148681+00:00",
            "linked": False,
        }
        return {**base, **overrides}

    def _payment(self):
        return taken_payments(order(payments=[payment()]))[0]

    def test_the_merchant_payment_seconds_later_is_the_one(self):
        assert pick_transaction(self._payment(), [self._txn()])["id"] == "t1"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"amount": "1393.6100"},  # the settled (net) amount is a different line
            {"currency_code": "EUR"},
            {"direction": "out"},
            {"linked": True},
            {"occurred_at": "2026-10-31T22:06:24+00:00"},  # too long after
            {"occurred_at": "2026-10-28T21:00:00+00:00"},  # before the payment
        ],
    )
    def test_anything_else_is_not(self, overrides):
        assert pick_transaction(self._payment(), [self._txn(**overrides)]) is None

    def test_the_closest_in_time_wins(self):
        later = self._txn(id="later", occurred_at="2026-10-29T09:00:00+00:00")
        assert pick_transaction(self._payment(), [later, self._txn()])["id"] == "t1"

    def test_a_payment_dataclass_is_plain_data(self):
        assert isinstance(self._payment(), TakenPayment)


class TestListOrders:
    def test_pages_backwards_until_nothing_new(self, monkeypatch):
        pages = [
            [{"id": "c", "created_at": "3"}, {"id": "b", "created_at": "2"}],
            # `to` is inclusive here: the oldest of the last page comes back again.
            [{"id": "b", "created_at": "2"}, {"id": "a", "created_at": "1"}],
            [{"id": "a", "created_at": "1"}],
        ]
        calls = []

        async def fake_get(self, path, params=None):
            calls.append(dict(params or {}))
            return {"orders": pages[len(calls) - 1]}

        monkeypatch.setattr(MerchantAdapter, "_get", fake_get)

        async def collect():
            return [
                o["id"] async for o in MerchantAdapter("k").list_orders(page_size=2)
            ]

        assert asyncio.run(collect()) == ["c", "b", "a"]
        assert calls[0] == {"limit": 2}
        assert calls[1] == {"limit": 2, "to": "2"}

    def test_a_short_page_is_the_last(self, monkeypatch):
        calls = []

        async def fake_get(self, path, params=None):
            calls.append(params)
            return {"orders": [{"id": "only", "created_at": "1"}]}

        monkeypatch.setattr(MerchantAdapter, "_get", fake_get)

        async def collect():
            return [o async for o in MerchantAdapter("k").list_orders(page_size=100)]

        assert len(asyncio.run(collect())) == 1 and len(calls) == 1

    def test_requests_carry_the_pinned_api_version(self):
        headers = MerchantAdapter("secret")._headers
        assert headers["Revolut-Api-Version"] == merchant.API_VERSION
        assert headers["Authorization"] == "Bearer secret"
