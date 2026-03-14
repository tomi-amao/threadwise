"""Double-entry journal system for accounting.

Journal types:
- **Accrual journal**: Created from a captured *payment* record. Debits clearing
  (net_amount) + bank charges (fee), credits revenue/shipping/tax from the linked order.
- **Settlement journal**: Created from an inbound gateway transfer (Stripe/PayPal
  payout into Revolut). Debits cash, credits clearing.  No fee entry — fees are
  captured at accrual time.
- **Expense journal**: Created from an outbound financial transaction. Debits the
  resolved expense account, credits cash.
- **Purchase / Sale / Payment journals**: Created from invoices.

Safety rules:
- Always validate: total debits == total credits (within tolerance)
- Accrual journals are reversible via reverse_journal()
"""

import asyncio
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_id as _extract_id, extract_row, extract_rows
from . import account_mapping as accts

logger = logging.getLogger(__name__)

BALANCE_TOLERANCE = Decimal("0.01")


class JournalError(Exception):
    """Raised when journal operations fail."""
    pass


class JournalService:
    """Service for creating and managing double-entry journal entries."""

    # How many items to process before refreshing the Supabase HTTP/2 connection.
    # Supabase drops connections after ~20 000 streams; each journal creation
    # uses ~6-8 API calls, so 200 items ≈ 1 600 streams — well within limits.
    BATCH_SIZE = 200

    def __init__(self):
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

    def _refresh_connection(self):
        """Force a new Supabase client to avoid HTTP/2 stream exhaustion."""
        get_supabase_client.cache_clear()
        self._client = None
        logger.debug("Supabase connection refreshed")

    # =========================================================================
    # CHART OF ACCOUNTS
    # =========================================================================

    async def get_chart_of_accounts(
        self,
        entity_id: Optional[UUID] = None,
    ) -> List[Dict[str, Any]]:
        """Get all accounts in the chart of accounts.

        The chart_of_accounts table is no longer entity-scoped.
        The entity_id parameter is kept for backward compat but is ignored.
        """
        result = await asyncio.to_thread(
            lambda: self.client.table("chart_of_accounts")
            .select("*")
            .order("account_number")
            .execute()
        )
        return extract_rows(result)

    async def seed_chart_of_accounts(self, entity_id: Optional[UUID] = None) -> Dict[str, Any]:
        """Seed the standard chart of accounts.

        Calls the seed_chart_of_accounts SQL function (no longer entity-scoped).
        The entity_id parameter is kept for backward compat but is ignored.
        """
        result = await asyncio.to_thread(
            lambda: self.client.rpc(
                "seed_chart_of_accounts",
                {},
            ).execute()
        )
        # Verify accounts were created
        accounts = await self.get_chart_of_accounts()
        return {
            "accounts_created": len(accounts),
            "accounts": [{"account_number": a["account_number"], "name": a["name"]} for a in accounts],
        }

    async def _get_account_id(
        self,
        entity_id: UUID,
        account_number: str,
    ) -> Optional[UUID]:
        """Get account UUID by account_number.

        Delegates to account_mapping.get_account_id which validates that the
        account is not a header.  The entity_id parameter is kept for backward
        compat but is ignored (chart_of_accounts is no longer entity-scoped).
        """
        try:
            return await accts.get_account_id(account_number)
        except ValueError as e:
            logger.error("Cannot post to account %s: %s", account_number, e)
            return None

    # =========================================================================
    # ACCRUAL JOURNAL (Payment-based)
    # =========================================================================

    async def create_accrual_journal(
        self,
        entity_id: UUID,
        payment_id: UUID,
    ) -> Dict[str, Any]:
        """Create an accrual journal entry for a captured payment.

        Uses both the *payments* and *orders* tables:
        - **payment.net_amount** → clearing debit (what we will receive)
        - **payment_fees.net_fee** → bank charges debit (gateway fee)
        - **order** amounts → revenue, shipping revenue, and VAT credits

        Journal entries:
            DEBIT  1012 Payment Gateway Clearing = net_amount
            DEBIT  8020 Bank Charges             = fee_amount
            CREDIT 4020 Revenue                  = subtotal - discounts
            CREDIT 4020 Shipping Revenue         = shipping_total
            CREDIT 2030 Tax Payable              = tax_total

        Raises:
            JournalError: If payment/order not found, or debits != credits
        """
        # Fetch payment with fees
        payment = await self._fetch_payment_with_fees(str(payment_id))
        if not payment:
            raise JournalError(f"Payment not found: {payment_id}")

        # Check idempotency
        existing = await self._find_journal(entity_id, "payment", payment_id, "accrual")
        if existing:
            return existing

        net_amount = Decimal(str(payment.get("net_amount", 0)))
        fee_amount = Decimal(str(payment.get("_fee_amount", 0)))
        currency = payment.get("currency", "GBP")

        # Fetch linked order for revenue breakdown
        order_id = payment.get("order_id")
        order = await self._fetch_order(UUID(order_id)) if order_id else None

        if order:
            subtotal = Decimal(str(order.get("subtotal_amount", 0)))
            discount_total = Decimal(str(order.get("discount_total_amount", 0)))
            shipping_total = Decimal(str(order.get("shipping_total_amount", 0)))
            tax_total = Decimal(str(order.get("tax_total_amount", 0)))
            revenue_amount = subtotal - discount_total
        else:
            # Fallback: no order linked — entire amount is revenue
            revenue_amount = net_amount + fee_amount
            shipping_total = Decimal("0")
            tax_total = Decimal("0")

        # Resolve account IDs
        clearing_id = await self._get_account_id(entity_id, accts.MERCHANT_CLEARING)
        fees_id = await self._get_account_id(entity_id, accts.BANK_CHARGES)
        revenue_id = await self._get_account_id(entity_id, accts.REVENUE_ECOMMERCE)
        shipping_rev_id = await self._get_account_id(entity_id, accts.SHIPPING_REVENUE)
        tax_id = await self._get_account_id(entity_id, accts.VAT_PAYABLE)

        missing = []
        if not clearing_id:
            missing.append(accts.MERCHANT_CLEARING)
        if not fees_id:
            missing.append(accts.BANK_CHARGES)
        if not revenue_id:
            missing.append(accts.REVENUE_ECOMMERCE)
        if not shipping_rev_id:
            missing.append(accts.SHIPPING_REVENUE)
        if not tax_id:
            missing.append(accts.VAT_PAYABLE)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        order_ref = order.get("order_number", order_id) if order else payment_id

        # Build line items
        line_items: List[Dict[str, Any]] = []

        # DEBIT clearing (net amount — what we will receive from gateway)
        if net_amount > 0:
            line_items.append({
                "account_id": str(clearing_id),
                "debit": float(net_amount),
                "credit": 0,
                "currency": currency,
                "description": f"Clearing for payment on order {order_ref}",
            })

        # DEBIT bank charges (gateway processing fee)
        if fee_amount > 0:
            line_items.append({
                "account_id": str(fees_id),
                "debit": float(fee_amount),
                "credit": 0,
                "currency": currency,
                "description": f"Processing fee for payment on order {order_ref}",
            })

        # CREDIT revenue (subtotal - discounts)
        if revenue_amount > 0:
            line_items.append({
                "account_id": str(revenue_id),
                "debit": 0,
                "credit": float(revenue_amount),
                "currency": currency,
                "description": f"Revenue for order {order_ref}",
            })

        # CREDIT shipping revenue (separate account for reporting)
        if shipping_total > 0:
            line_items.append({
                "account_id": str(shipping_rev_id),
                "debit": 0,
                "credit": float(shipping_total),
                "currency": currency,
                "description": f"Shipping revenue for order {order_ref}",
            })

        # CREDIT tax payable
        if tax_total > 0:
            line_items.append({
                "account_id": str(tax_id),
                "debit": 0,
                "credit": float(tax_total),
                "currency": currency,
                "description": f"Tax for order {order_ref}",
            })

        # Validate balance
        total_debit = sum(Decimal(str(li["debit"])) for li in line_items)
        total_credit = sum(Decimal(str(li["credit"])) for li in line_items)
        if abs(total_debit - total_credit) > BALANCE_TOLERANCE:
            raise JournalError(
                f"Accrual journal does not balance: debit={total_debit} credit={total_credit}"
            )

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="accrual",
            journal_date=payment.get("paid_on", datetime.now(timezone.utc).isoformat()),
            description=f"Accrual for payment on order {order_ref}",
            source_type="payment",
            source_id=payment_id,
            status="posted",
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # SETTLEMENT JOURNAL (Gateway payout → Cash)
    # =========================================================================

    async def create_settlement_journal(
        self,
        entity_id: UUID,
        financial_transaction_id: UUID,
    ) -> Dict[str, Any]:
        """Create a settlement journal for an inbound gateway transfer.

        Records the arrival of funds from a payment gateway (Stripe/PayPal)
        into the bank account (Revolut).  No fee entry is needed because fees
        are already captured at accrual time on the payment record.

        Journal entries:
            DEBIT  1014/1015/1016 Cash (Revolut)     = transfer amount
            CREDIT 1012 Payment Gateway Clearing      = transfer amount

        Raises:
            JournalError: If transaction not found or not a settlement-eligible transfer
        """
        txn = await self._fetch_financial_transaction(str(financial_transaction_id))
        if not txn:
            raise JournalError(f"Financial transaction not found: {financial_transaction_id}")

        # Guard: only inbound transfers from gateways
        direction = txn.get("direction", "")
        txn_type = txn.get("transaction_type", "")
        if direction != "in" or txn_type != "transfer":
            raise JournalError(
                f"Expected inbound transfer, got direction={direction} type={txn_type}"
            )

        # Check idempotency
        existing = await self._find_journal(
            entity_id, "financial_transaction", financial_transaction_id, "settlement"
        )
        if existing:
            return existing

        amount = Decimal(str(abs(txn.get("amount", 0))))
        currency = txn.get("currency_code") or txn.get("currency", "GBP")

        if amount <= 0:
            raise JournalError(f"Transaction amount must be positive, got {amount}")

        # Determine gateway from description
        desc = (txn.get("description") or "").lower()
        gateway = "STRIPE" if "stripe" in desc else "PAYPAL" if "paypal" in desc else "GATEWAY"

        # Cash account based on currency
        source = txn.get("source", "revolut")
        cash_account_code = accts.resolve_cash_account(source, currency)

        # Resolve account IDs
        cash_id = await self._get_account_id(entity_id, cash_account_code)
        clearing_id = await self._get_account_id(entity_id, accts.MERCHANT_CLEARING)

        missing = []
        if not cash_id:
            missing.append(cash_account_code)
        if not clearing_id:
            missing.append(accts.MERCHANT_CLEARING)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        line_items = [
            {
                "account_id": str(cash_id),
                "debit": float(amount),
                "credit": 0,
                "currency": currency,
                "description": f"Payout received from {gateway}",
            },
            {
                "account_id": str(clearing_id),
                "debit": 0,
                "credit": float(amount),
                "currency": currency,
                "description": f"Settlement clearing ({gateway})",
            },
        ]

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="settlement",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=f"Settlement via {gateway} payout",
            source_type="financial_transaction",
            source_id=financial_transaction_id,
            status="posted",
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # FUNDING JOURNAL (Personal / external funding into bank account)
    # =========================================================================

    async def create_funding_journal(
        self,
        entity_id: UUID,
        financial_transaction_id: UUID,
    ) -> Dict[str, Any]:
        """Create a funding journal for an inbound personal or external transfer.

        Covers:
        - Owner putting personal funds into the business
        - Third-party merchant payments (e.g. wholesale buyer transfers)

        Owner funding:
            DEBIT  1014/1019/... Cash    = amount
            CREDIT 2230 Director's Loan Account (DLA)  = amount

        Merchant / third-party funding:
            DEBIT  1014/1019/... Cash    = amount
            CREDIT 4020 Revenue          = amount  (general sales receipt)
        """
        txn = await self._fetch_financial_transaction(str(financial_transaction_id))
        if not txn:
            raise JournalError(f"Financial transaction not found: {financial_transaction_id}")

        # Idempotency
        existing = await self._find_journal(
            entity_id, "financial_transaction", financial_transaction_id, "funding"
        )
        if existing:
            return existing

        amount = Decimal(str(abs(txn.get("amount", 0))))
        currency = txn.get("currency_code") or txn.get("currency", "GBP")

        if amount <= 0:
            raise JournalError(f"Transaction amount must be positive, got {amount}")

        source = txn.get("source", "revolut")
        cash_code = accts.resolve_cash_account(source, currency)
        cash_id = await self._get_account_id(entity_id, cash_code)

        description_text = txn.get("description") or ""
        counterparty = txn.get("counterparty_name") or ""

        # Detect personal funding vs. merchant/third-party
        is_personal = self._is_personal_funding(description_text, counterparty, txn)
        if is_personal:
            credit_code = accts.DIRECTORS_LOAN
            credit_label = "Director's loan — personal funds introduced"
            journal_desc = f"Personal funding: {description_text}"
        else:
            credit_code = accts.REVENUE_ECOMMERCE
            credit_label = f"Revenue from {counterparty or description_text}"
            journal_desc = f"Funding received: {counterparty or description_text}"

        credit_id = await self._get_account_id(entity_id, credit_code)

        missing = []
        if not cash_id:
            missing.append(cash_code)
        if not credit_id:
            missing.append(credit_code)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        line_items = [
            {
                "account_id": str(cash_id),
                "debit": float(amount),
                "credit": 0,
                "currency": currency,
                "description": f"Cash received: {description_text}",
            },
            {
                "account_id": str(credit_id),
                "debit": 0,
                "credit": float(amount),
                "currency": currency,
                "description": credit_label,
            },
        ]

        return await self._create_journal(
            entity_id=entity_id,
            journal_type="funding",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=journal_desc,
            source_type="financial_transaction",
            source_id=financial_transaction_id,
            status="posted",
            line_items=line_items,
        )

    # =========================================================================
    # SALES RECEIPT JOURNAL (Direct PayPal / card sales)
    # =========================================================================

    async def create_sales_receipt_journal(
        self,
        entity_id: UUID,
        financial_transaction_id: UUID,
    ) -> Dict[str, Any]:
        """Create a sales receipt journal for a direct PayPal sale.

        Covers T0006 and T0011 PayPal inbound transactions where a customer
        paid directly via PayPal invoice or card.

            DEBIT  1019 PayPal Account   = gross amount
            DEBIT  8020 Bank Charges     = fee amount  (if any)
            CREDIT 4020 Revenue          = gross amount + fee
        """
        txn = await self._fetch_financial_transaction(str(financial_transaction_id))
        if not txn:
            raise JournalError(f"Financial transaction not found: {financial_transaction_id}")

        existing = await self._find_journal(
            entity_id, "financial_transaction", financial_transaction_id, "sales_receipt"
        )
        if existing:
            return existing

        amount = Decimal(str(abs(txn.get("amount", 0))))
        currency = txn.get("currency_code") or "GBP"
        meta = txn.get("metadata") or {}

        if amount <= 0:
            raise JournalError(f"Transaction amount must be positive, got {amount}")

        source = txn.get("source", "paypal")
        cash_code = accts.resolve_cash_account(source, currency)
        cash_id = await self._get_account_id(entity_id, cash_code)
        revenue_id = await self._get_account_id(entity_id, accts.REVENUE_ECOMMERCE)
        fees_id = await self._get_account_id(entity_id, accts.BANK_CHARGES)

        missing = []
        if not cash_id:
            missing.append(cash_code)
        if not revenue_id:
            missing.append(accts.REVENUE_ECOMMERCE)
        if not fees_id:
            missing.append(accts.BANK_CHARGES)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        description_text = txn.get("description") or ""
        counterparty = txn.get("counterparty_name") or ""
        # Extract fee from metadata
        fee_info = meta.get("fee_amount") or {}
        fee_amount = abs(Decimal(str(fee_info.get("value", "0")))) if fee_info else Decimal("0")

        gross_revenue = amount + fee_amount

        line_items: List[Dict[str, Any]] = [
            {
                "account_id": str(cash_id),
                "debit": float(amount),
                "credit": 0,
                "currency": currency,
                "description": f"PayPal receipt: {counterparty or description_text}",
            },
        ]

        if fee_amount > 0:
            line_items.append({
                "account_id": str(fees_id),
                "debit": float(fee_amount),
                "credit": 0,
                "currency": currency,
                "description": f"PayPal fee: {counterparty or description_text}",
            })

        line_items.append({
            "account_id": str(revenue_id),
            "debit": 0,
            "credit": float(gross_revenue),
            "currency": currency,
            "description": f"Sales revenue: {counterparty or description_text}",
        })

        return await self._create_journal(
            entity_id=entity_id,
            journal_type="sales_receipt",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=f"PayPal sale: {counterparty or description_text}",
            source_type="financial_transaction",
            source_id=financial_transaction_id,
            status="posted",
            line_items=line_items,
        )

    # =========================================================================
    # REFUND JOURNAL (Inbound refund → reverse expense)
    # =========================================================================

    async def create_refund_journal(
        self,
        entity_id: UUID,
        financial_transaction_id: UUID,
    ) -> Dict[str, Any]:
        """Create a refund journal for an inbound refund transaction.

            DEBIT  1014/... Cash        = refund amount
            CREDIT 6xxx/... Expense     = refund amount  (resolved from counterparty)
        """
        txn = await self._fetch_financial_transaction(str(financial_transaction_id))
        if not txn:
            raise JournalError(f"Financial transaction not found: {financial_transaction_id}")

        existing = await self._find_journal(
            entity_id, "financial_transaction", financial_transaction_id, "refund"
        )
        if existing:
            return existing

        amount = Decimal(str(abs(txn.get("amount", 0))))
        currency = txn.get("currency_code") or "GBP"
        source = txn.get("source", "revolut")

        if amount <= 0:
            raise JournalError(f"Transaction amount must be positive, got {amount}")

        cash_code = accts.resolve_cash_account(source, currency)
        cash_id = await self._get_account_id(entity_id, cash_code)

        # Resolve the expense account being refunded
        meta = txn.get("metadata") or {}
        description_text = txn.get("description") or ""
        counterparty = txn.get("counterparty_name") or ""
        expense_code = accts.resolve_expense_account(
            metadata=meta,
            description=description_text,
            counterparty=counterparty,
            transaction_type="refund",
            amount=float(amount),
        )
        expense_id = await self._get_account_id(entity_id, expense_code)

        missing = []
        if not cash_id:
            missing.append(cash_code)
        if not expense_id:
            missing.append(expense_code)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        category = accts.ACCOUNT_LABEL.get(expense_code, "expense")
        line_items = [
            {
                "account_id": str(cash_id),
                "debit": float(amount),
                "credit": 0,
                "currency": currency,
                "description": f"Refund received: {counterparty or description_text}",
            },
            {
                "account_id": str(expense_id),
                "debit": 0,
                "credit": float(amount),
                "currency": currency,
                "description": f"Refund credit ({category}): {counterparty or description_text}",
            },
        ]

        return await self._create_journal(
            entity_id=entity_id,
            journal_type="refund",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=f"Refund from {counterparty or description_text}",
            source_type="financial_transaction",
            source_id=financial_transaction_id,
            status="posted",
            line_items=line_items,
        )

    # =========================================================================
    # FX CONVERSION JOURNAL
    # =========================================================================

    async def create_fx_conversion_journal(
        self,
        entity_id: UUID,
        financial_transaction_id: UUID,
    ) -> Dict[str, Any]:
        """Create an FX conversion journal.

        Records the currency exchange between two Revolut accounts.

            DEBIT  1014/1015/1016 Target Cash  = converted amount
            CREDIT 1014/1015/1016 Source Cash   = base amount
            DEBIT/CREDIT 8030 FX Loss/Gain      = difference  (if fee)
        """
        txn = await self._fetch_financial_transaction(str(financial_transaction_id))
        if not txn:
            raise JournalError(f"Financial transaction not found: {financial_transaction_id}")

        existing = await self._find_journal(
            entity_id, "financial_transaction", financial_transaction_id, "fx_conversion"
        )
        if existing:
            return existing

        amount = Decimal(str(abs(txn.get("amount", 0))))
        currency = txn.get("currency_code") or "GBP"
        meta = txn.get("metadata") or {}

        if amount <= 0:
            raise JournalError(f"Transaction amount must be positive, got {amount}")

        # Target cash account (the currency we received)
        target_code = accts.resolve_cash_account("revolut", currency)
        target_id = await self._get_account_id(entity_id, target_code)

        # Source cash account — try to determine from description
        desc = (txn.get("description") or "").lower()
        source_currency = "EUR" if "eur" in desc else "USD" if "usd" in desc else "GBP"
        if source_currency == currency:
            # Guess from the event; if direction=in and currency=GBP, source is likely EUR/USD
            source_currency = "EUR" if currency != "EUR" else "GBP"
        source_code = accts.resolve_cash_account("revolut", source_currency)
        source_id = await self._get_account_id(entity_id, source_code)

        fx_loss_id = await self._get_account_id(entity_id, accts.FX_LOSS)

        missing = []
        if not target_id:
            missing.append(target_code)
        if not source_id:
            missing.append(source_code)
        if not fx_loss_id:
            missing.append(accts.FX_LOSS)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        fee = Decimal(str(meta.get("fee", 0)))
        source_amount = amount + fee  # What we gave up from the source account

        line_items: List[Dict[str, Any]] = [
            {
                "account_id": str(target_id),
                "debit": float(amount),
                "credit": 0,
                "currency": currency,
                "description": f"FX conversion received: {currency}",
            },
        ]

        if fee > 0:
            line_items.append({
                "account_id": str(fx_loss_id),
                "debit": float(fee),
                "credit": 0,
                "currency": source_currency,
                "description": f"FX conversion fee",
            })

        line_items.append({
            "account_id": str(source_id),
            "debit": 0,
            "credit": float(source_amount),
            "currency": source_currency,
            "description": f"FX conversion source: {source_currency}",
        })

        return await self._create_journal(
            entity_id=entity_id,
            journal_type="fx_conversion",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=f"FX conversion: {source_currency} → {currency}",
            source_type="financial_transaction",
            source_id=financial_transaction_id,
            status="posted",
            line_items=line_items,
        )

    # =========================================================================
    # PURCHASE JOURNAL (Invoice → COGS)
    # =========================================================================

    async def create_purchase_journal(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        force: bool = False,
        financial_transaction_id: Optional[UUID] = None,
    ) -> Dict[str, Any]:
        """Create a purchase journal when a supplier invoice is received.

        When ``financial_transaction_id`` is provided the financial transaction
        is used as the journal source (single source of truth).  The invoice
        line items still drive the debit descriptions and amounts; the credit
        goes to the actual cash / clearing account derived from the transaction
        rather than Accounts Payable.  This prevents double-journaling the same
        transaction as both a purchase journal and an expense journal.

        When no transaction is given (legacy / manual path) the journal is
        sourced against the invoice and credits Accounts Payable.

        Journal entries (per line item):
            DEBIT  <line_item.gl_account_id or default 5000> = line net amount
            ...
            CREDIT <cash account from txn> OR 2000 AP       = invoice gross total

        Args:
            entity_id: The entity
            invoice_id: The invoice to journal
            force: Re-create even if a journal already exists
            financial_transaction_id: Optional — when the payment was observed
                as a financial transaction, use it as the journal source.

        Returns:
            Journal record with line items
        """
        invoice = await self._fetch_invoice(invoice_id)
        if not invoice:
            raise JournalError(f"Invoice not found: {invoice_id}")

        if invoice.get("invoice_type") not in ("PURCHASE", None):
            raise JournalError(
                f"Expected PURCHASE invoice but got type '{invoice.get('invoice_type')}'. "
                "Use create_sale_journal for SALE invoices."
            )

        # Determine the journal source — transaction wins over invoice
        if financial_transaction_id:
            # Single source of truth: source is the financial transaction
            j_source_type = "financial_transaction"
            j_source_id: UUID = financial_transaction_id
        else:
            j_source_type = "invoice"
            j_source_id = invoice_id

        # Check idempotency — skip if a journal already exists, unless force=True
        existing = await self._find_journal(entity_id, j_source_type, j_source_id, "purchase")
        if existing and not force:
            return existing

        total = Decimal(str(invoice.get("gross_amount") or invoice.get("net_amount") or 0))
        tax_total = Decimal(str(invoice.get("tax_amount") or 0))
        currency = invoice.get("currency", "GBP")

        if total <= 0:
            raise JournalError(f"Invoice total must be positive, got {total}")

        # Resolve counterparty name
        counterparty_name = await self._get_contact_name(invoice.get("counterparty_id"))
        inv_number = invoice.get("invoice_number", str(invoice_id))

        # Resolve default account IDs
        default_cogs_id = await self._get_account_id(entity_id, accts.COGS_DEFAULT)
        vat_input_id = await self._get_account_id(entity_id, accts.VAT_RECEIVABLE)

        if not default_cogs_id:
            raise JournalError(
                f"Missing chart of accounts ({accts.COGS_DEFAULT} COGS). "
                "Check that this account number exists and is not a header."
            )

        # Fetch invoice line items for per-line debit entries
        inv_line_items = await self._fetch_invoice_line_items(invoice_id)

        line_items: List[Dict[str, Any]] = []

        if inv_line_items:
            # Create a debit entry per invoice line item using its assigned GL account
            for li in inv_line_items:
                # Compute the line's net amount (quantity × unit_cost or fall back)
                qty = Decimal(str(li.get("quantity") or 1))
                unit = Decimal(str(li.get("unit_cost") or 0))
                line_net = qty * unit

                if line_net <= 0:
                    continue

                # Use the line item's assigned GL account; fall back to default COGS
                debit_account_id = li.get("gl_account_id") or str(default_cogs_id)
                description = li.get("description", "Purchase item")

                line_items.append({
                    "account_id": debit_account_id,
                    "debit": float(line_net),
                    "credit": 0,
                    "currency": currency,
                    "description": f"{description} — {counterparty_name} (inv {inv_number})",
                })

            # If there's tax, add a VAT input debit (or lump it into the last COGS entry)
            if tax_total > 0:
                tax_account = str(vat_input_id) if vat_input_id else str(default_cogs_id)
                line_items.append({
                    "account_id": tax_account,
                    "debit": float(tax_total),
                    "credit": 0,
                    "currency": currency,
                    "description": f"Input VAT — {counterparty_name} (inv {inv_number})",
                })
        else:
            # No line items — fall back to single COGS debit for gross total
            line_items.append({
                "account_id": str(default_cogs_id),
                "debit": float(total),
                "credit": 0,
                "currency": currency,
                "description": f"Purchase from {counterparty_name} (inv {inv_number})",
            })

        # CREDIT Accounts Payable — invoices always create an AP obligation.
        # The matching bank transaction clears the AP via create_invoice_payment_journal.
        ap_id = await self._get_account_id(entity_id, accts.ACCOUNTS_PAYABLE)
        if not ap_id:
            raise JournalError(
                f"Missing chart of accounts ({accts.ACCOUNTS_PAYABLE} AP). "
                "Check that this account number exists and is not a header."
            )

        line_items.append({
            "account_id": str(ap_id),
            "debit": 0,
            "credit": float(total),
            "currency": currency,
            "description": f"AP for {counterparty_name} (inv {inv_number})",
        })

        # Validate balance
        total_debit = sum(Decimal(str(li["debit"])) for li in line_items)
        total_credit = sum(Decimal(str(li["credit"])) for li in line_items)
        if abs(total_debit - total_credit) > BALANCE_TOLERANCE:
            # Adjust last debit entry to absorb rounding differences
            diff = float(total_credit - total_debit)
            logger.debug(
                f"Purchase journal rounding adjustment: {diff} on inv {inv_number}"
            )
            # Find the last debit entry and adjust it
            for li in reversed(line_items):
                if li["debit"] > 0:
                    li["debit"] = float(Decimal(str(li["debit"])) + Decimal(str(diff)))
                    break

        journal_date = invoice.get("invoice_date", datetime.now(timezone.utc).isoformat())

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="purchase",
            journal_date=journal_date,
            description=f"Purchase invoice {inv_number} from {counterparty_name}",
            source_type=j_source_type,
            source_id=j_source_id,
            status="posted",
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # INVOICE PAYMENT JOURNAL
    # =========================================================================

    # =========================================================================
    # SALE JOURNAL (Invoice → Accounts Receivable + Revenue)
    # =========================================================================

    async def create_sale_journal(
        self,
        entity_id: UUID,
        invoice_id: UUID,
    ) -> Dict[str, Any]:
        """Create a sale journal when a customer invoice is issued.

        Journal entries:
            DEBIT  1300 Accounts Receivable  = gross_amount
            CREDIT 4000 Revenue              = net_amount
            CREDIT 2100 Tax Payable          = tax_amount

        Args:
            entity_id: The entity
            invoice_id: The SALE invoice UUID

        Returns:
            Journal record with line items

        Raises:
            JournalError: If invoice not found, wrong type, or accounts missing
        """
        invoice = await self._fetch_invoice(invoice_id)
        if not invoice:
            raise JournalError(f"Invoice not found: {invoice_id}")

        if invoice.get("invoice_type") != "SALE":
            raise JournalError(
                f"Expected SALE invoice but got type '{invoice.get('invoice_type')}'. "
                "Use create_purchase_journal for PURCHASE invoices."
            )

        # Check idempotency
        existing = await self._find_journal(entity_id, "invoice", invoice_id, "accrual")
        if existing:
            return existing

        gross = Decimal(str(invoice.get("gross_amount") or 0))
        net = Decimal(str(invoice.get("net_amount") or gross))
        tax = Decimal(str(invoice.get("tax_amount") or 0))
        currency = invoice.get("currency", "GBP")

        if gross <= 0:
            raise JournalError(f"Invoice gross amount must be positive, got {gross}")

        counterparty_name = await self._get_contact_name(invoice.get("counterparty_id"))
        inv_number = invoice.get("invoice_number", str(invoice_id))

        # Resolve account IDs
        ar_id = await self._get_account_id(entity_id, accts.ACCOUNTS_RECEIVABLE)
        revenue_id = await self._get_account_id(entity_id, accts.REVENUE_ECOMMERCE)
        tax_id = await self._get_account_id(entity_id, accts.VAT_PAYABLE)

        if not all([ar_id, revenue_id]):
            raise JournalError(
                f"Missing chart of accounts ({accts.ACCOUNTS_RECEIVABLE}, {accts.REVENUE_ECOMMERCE}). "
                "Check that these account numbers exist and are not header accounts."
            )

        line_items: List[Dict[str, Any]] = [
            {
                "account_id": str(ar_id),
                "debit": float(gross),
                "credit": 0,
                "currency": currency,
                "description": f"Receivable from {counterparty_name} (inv {inv_number})",
            },
            {
                "account_id": str(revenue_id),
                "debit": 0,
                "credit": float(net),
                "currency": currency,
                "description": f"Revenue for {counterparty_name} (inv {inv_number})",
            },
        ]

        if tax > 0 and tax_id:
            line_items.append({
                "account_id": str(tax_id),
                "debit": 0,
                "credit": float(tax),
                "currency": currency,
                "description": f"VAT/Tax for inv {inv_number}",
            })

        # Validate balance
        total_debit = sum(Decimal(str(li["debit"])) for li in line_items)
        total_credit = sum(Decimal(str(li["credit"])) for li in line_items)
        if abs(total_debit - total_credit) > BALANCE_TOLERANCE:
            raise JournalError(
                f"Sale journal does not balance: debit={total_debit} credit={total_credit}"
            )

        return await self._create_journal(
            entity_id=entity_id,
            journal_type="accrual",
            journal_date=invoice.get("invoice_date", datetime.now(timezone.utc).isoformat()),
            description=f"Sale invoice {inv_number} to {counterparty_name}",
            source_type="invoice",
            source_id=invoice_id,
            status="posted",
            line_items=line_items,
        )

    async def create_invoice_payment_journal(
        self,
        entity_id: UUID,
        invoice_id: UUID,
    ) -> Dict[str, Any]:
        """Create a payment settlement journal when an invoice is marked PAID.

        Finds the matching financial transaction to determine the actual cash
        account used for payment.  Falls back to generic Cash & Cash Equivalents
        if no matching transaction is found.

        PURCHASE invoice (pay a supplier):
            DEBIT  2010 Accounts Payable  = gross total
            CREDIT 1014/1019/... Cash     = gross total  (resolved from transaction)

        SALE invoice (receive payment from customer):
            DEBIT  1010/... Cash          = gross total
            CREDIT 1020 Accounts Receivable = gross total

        Args:
            entity_id: The entity
            invoice_id: The invoice that was paid (status must be PAID)

        Returns:
            Journal record with line items
        """
        invoice = await self._fetch_invoice(invoice_id)
        if not invoice:
            raise JournalError(f"Invoice not found: {invoice_id}")

        if invoice.get("status") not in ("PAID", "paid"):
            raise JournalError(
                f"Invoice status is '{invoice.get('status')}', expected 'PAID'"
            )

        # Check idempotency
        existing = await self._find_journal(entity_id, "invoice", invoice_id, "payment")
        if existing:
            return existing

        total = Decimal(
            str(invoice.get("gross_amount") or invoice.get("net_amount") or 0)
        )
        currency = invoice.get("currency", "GBP")
        invoice_type = invoice.get("invoice_type", "PURCHASE")

        counterparty_name = await self._get_contact_name(invoice.get("counterparty_id"))
        inv_number = invoice.get("invoice_number", str(invoice_id))

        # Try to find the matching financial transaction for accurate cash account
        matched_txn = None
        matched_txn_id = await self._find_transaction_for_invoice(entity_id, inv_number)
        if matched_txn_id:
            matched_txn = await self._fetch_financial_transaction(str(matched_txn_id))

        journal_date = datetime.now(timezone.utc).isoformat()
        if matched_txn and matched_txn.get("occurred_at"):
            journal_date = matched_txn["occurred_at"]

        if invoice_type == "SALE":
            # Customer paid us: debit Cash, credit Accounts Receivable
            cash_code = accts.CASH_AND_EQUIVALENTS
            if matched_txn:
                cash_code = accts.resolve_cash_account(
                    matched_txn.get("source", "revolut"),
                    matched_txn.get("currency_code") or currency,
                )

            cash_id = await self._get_account_id(entity_id, cash_code)
            ar_id = await self._get_account_id(entity_id, accts.ACCOUNTS_RECEIVABLE)

            if not all([cash_id, ar_id]):
                raise JournalError(
                    f"Missing chart of accounts ({cash_code}, {accts.ACCOUNTS_RECEIVABLE}). "
                    "Check that these account numbers exist and are not header accounts."
                )

            line_items = [
                {
                    "account_id": str(cash_id),
                    "debit": float(total),
                    "credit": 0,
                    "currency": currency,
                    "description": f"Cash received from {counterparty_name} (inv {inv_number})",
                },
                {
                    "account_id": str(ar_id),
                    "debit": 0,
                    "credit": float(total),
                    "currency": currency,
                    "description": f"AR cleared for {counterparty_name} (inv {inv_number})",
                },
            ]
            description = f"Payment received for invoice {inv_number} from {counterparty_name}"
        else:
            # We paid supplier (PURCHASE): debit AP, credit Cash
            ap_id = await self._get_account_id(entity_id, accts.ACCOUNTS_PAYABLE)

            cash_code = accts.CASH_AND_EQUIVALENTS
            if matched_txn:
                cash_code = accts.resolve_cash_account(
                    matched_txn.get("source", "revolut"),
                    matched_txn.get("currency_code") or currency,
                )

            cash_id = await self._get_account_id(entity_id, cash_code)

            if not all([ap_id, cash_id]):
                raise JournalError(
                    f"Missing chart of accounts ({accts.ACCOUNTS_PAYABLE}, {cash_code}). "
                    "Check that these account numbers exist and are not header accounts."
                )

            line_items = [
                {
                    "account_id": str(ap_id),
                    "debit": float(total),
                    "credit": 0,
                    "currency": currency,
                    "description": f"AP cleared for {counterparty_name} (inv {inv_number})",
                },
                {
                    "account_id": str(cash_id),
                    "debit": 0,
                    "credit": float(total),
                    "currency": currency,
                    "description": f"Cash paid to {counterparty_name} (inv {inv_number})",
                },
            ]
            description = f"Payment for invoice {inv_number} to {counterparty_name}"

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="payment",
            journal_date=journal_date,
            description=description,
            source_type="invoice",
            source_id=invoice_id,
            status="posted",
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # EXPENSE JOURNAL (Bank transaction → Expense)
    # =========================================================================

    async def create_expense_journal(
        self,
        entity_id: UUID,
        financial_transaction_id: UUID,
    ) -> Dict[str, Any]:
        """Create an expense journal from a categorized bank transaction.

        Uses the account_code from the financial transaction to determine
        which expense account to debit.

        Journal entries:
            DEBIT  6xxx Expense account (from account_code)  = amount
            CREDIT 1000/1100 Cash (Revolut/PayPal)           = amount

        Guards:
            - Rejects payout transactions (already handled by settlement)
            - Requires account_code to be set on the transaction

        Args:
            entity_id: The entity
            financial_transaction_id: The financial transaction to journal

        Returns:
            Journal record with line items
        """
        txn = await self._fetch_financial_transaction(str(financial_transaction_id))
        if not txn:
            raise JournalError(f"Financial transaction not found: {financial_transaction_id}")

        # Guard: reject inbound payment transactions (handled by settlement journals)
        txn_type = txn.get("transaction_type") or txn.get("type", "")
        direction = txn.get("direction", "out")
        if txn_type in ("payout",):
            raise JournalError("Payout transactions are handled by settlement journals, not expense journals")
        if txn_type == "payment" and direction == "in":
            raise JournalError("Inbound payment transactions are handled by settlement journals, not expense journals")
        if txn_type in ("fx_conversion", "reserve_hold", "reserve_release"):
            raise JournalError(f"Transaction type '{txn_type}' is not an expensable transaction")

        # Smart account resolution — never default to 6999
        meta = txn.get("metadata") or {}
        description = txn.get("description") or ""
        counterparty = txn.get("counterparty_name") or ""
        raw_amount = abs(float(txn.get("amount", 0)))
        acct_code = accts.resolve_expense_account(
            metadata=meta,
            description=description,
            counterparty=counterparty,
            transaction_type=txn_type,
            amount=raw_amount,
        )

        # Check idempotency
        existing = await self._find_journal(
            entity_id, "financial_transaction", financial_transaction_id, "expense"
        )
        if existing:
            return existing

        amount = Decimal(str(abs(txn.get("amount", 0))))
        currency = txn.get("currency_code") or txn.get("currency", "GBP")

        if amount <= 0:
            raise JournalError(f"Transaction amount must be positive, got {amount}")

        # Determine cash account based on source + currency
        source = txn.get("source", "revolut")
        cash_account_code = accts.resolve_cash_account(source, currency)

        # Mark as draft when the account fell back to the miscellaneous catch-all
        journal_status = "posted"
        if acct_code == accts.UNCATEGORISED_FALLBACK:
            journal_status = "draft"
            logger.warning(
                "Could not categorise transaction %s (%s / %s). "
                "Falling back to %s and marking as draft.",
                financial_transaction_id, description, counterparty, acct_code,
            )

        # Resolve account IDs
        expense_id = await self._get_account_id(entity_id, acct_code)
        cash_id = await self._get_account_id(entity_id, cash_account_code)

        missing = []
        if not expense_id:
            missing.append(acct_code)
        if not cash_id:
            missing.append(cash_account_code)
        if missing:
            raise JournalError(
                f"Missing chart of accounts ({', '.join(missing)}). "
                "Check that these account numbers exist and are not header accounts."
            )

        category = accts.ACCOUNT_LABEL.get(acct_code, meta.get("expense_category") or "expense")
        if not counterparty:
            counterparty = description or "Unknown"

        line_items = [
            {
                "account_id": str(expense_id),
                "debit": float(amount),
                "credit": 0,
                "currency": currency,
                "description": f"{category}: {counterparty}",
            },
            {
                "account_id": str(cash_id),
                "debit": 0,
                "credit": float(amount),
                "currency": currency,
                "description": f"Cash out: {counterparty}",
            },
        ]

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="expense",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=f"Expense: {category} - {counterparty}",
            source_type="financial_transaction",
            source_id=financial_transaction_id,
            status=journal_status,
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # BATCH EXPENSE JOURNALS
    # =========================================================================

    async def auto_journal_expenses(
        self,
        entity_id: UUID,
        transaction_ids: Optional[List[UUID]] = None,
    ) -> Dict[str, Any]:
        """Batch-create expense journals for un-journaled expense transactions.

        If transaction_ids is not specified, finds all expense/fee OUT transactions
        without existing expense journals.  Processes in batches to avoid HTTP/2
        connection exhaustion.

        Args:
            entity_id: The entity
            transaction_ids: Optional specific transactions to journal

        Returns:
            Summary of journals created
        """
        if transaction_ids is None:
            transaction_ids = await self._find_unjournaled_expenses(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for i, txn_id in enumerate(transaction_ids):
            # Refresh the Supabase connection every BATCH_SIZE items
            if i > 0 and i % self.BATCH_SIZE == 0:
                self._refresh_connection()
                await asyncio.sleep(0.5)
                logger.info(
                    "Expense progress: %d/%d processed (%d created, %d errors)",
                    i, len(transaction_ids), results["created"], len(results["errors"]),
                )

            try:
                await self.create_expense_journal(entity_id, txn_id)
                results["created"] += 1
            except JournalError as e:
                err_msg = str(e).lower()
                if "already" in err_msg or "existing" in err_msg or "payout" in err_msg:
                    results["skipped"] += 1
                else:
                    results["errors"].append({
                        "transaction_id": str(txn_id),
                        "error": str(e),
                    })

        return {
            "entity_id": str(entity_id),
            "transactions_processed": len(transaction_ids),
            **results,
        }

    # =========================================================================
    # GENERATE ALL JOURNALS (Full Pipeline)
    # =========================================================================

    async def generate_all_journals(
        self,
        entity_id: UUID,
        scope: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run the journal generation pipeline.

        Args:
            entity_id: Entity UUID
            scope: Which journals to create. One of:
                - ``"payments"`` — accrual journals from captured payments
                - ``"transactions"`` — expense + settlement + inbound journals from financial transactions
                - ``"invoices"`` — purchase / sale / payment journals from invoices
                - ``None`` or ``"all"`` — run every scope

        PayPal transaction cleaning, cross-provider duplicate detection,
        and invoice matching always run first (they are prerequisites, not
        journal-creating steps).
        """
        from ..services.reconciliation_service import reconciliation_service
        from ..services.paypal_cleaning_service import paypal_cleaning_service

        run_all = scope is None or scope == "all"
        pipeline_start = datetime.now(timezone.utc)
        steps: List[Dict[str, Any]] = []
        overall_errors: List[Dict[str, Any]] = []

        # ── Pre-step: PayPal transaction cleaning ─────────────────────────
        step = {
            "step": "paypal_cleaning",
            "title": "Clean PayPal Transactions",
            "status": "running",
        }
        try:
            clean_result = await paypal_cleaning_service.clean_paypal_transactions(entity_id)
            step.update({
                "status": "completed",
                "total_processed": clean_result.get("total_processed", 0),
                "total_excluded": clean_result.get("total_excluded", 0),
                "total_enriched": clean_result.get("total_enriched", 0),
                "patterns": clean_result.get("patterns", {}),
            })
        except Exception as e:
            logger.error("PayPal cleaning step failed: %s", e)
            step.update({"status": "error", "error": str(e)})
            overall_errors.append({"step": "paypal_cleaning", "error": str(e)})
        steps.append(step)

        # ── Pre-step: Cross-provider duplicate detection ──────────────────
        step = {
            "step": "duplicate_detection",
            "title": "Detect Cross-Provider Duplicates",
            "status": "running",
        }
        try:
            dup_result = await reconciliation_service.detect_cross_provider_duplicates(entity_id)
            step.update({
                "status": "completed",
                "duplicates_found": dup_result.get("duplicates_found", 0),
                "enriched": dup_result.get("enriched", 0),
                "invoices_updated": dup_result.get("invoices_updated", 0),
                "excluded_transactions": dup_result.get("excluded_transactions", 0),
                "internal_pairs_cancelled": dup_result.get("internal_pairs_cancelled", 0),
            })
        except Exception as e:
            logger.error("Duplicate detection step failed: %s", e)
            step.update({"status": "error", "error": str(e)})
            overall_errors.append({"step": "duplicate_detection", "error": str(e)})
        steps.append(step)

        # ── Pre-step: Invoice payment matching ──────────────────────────────
        step = {
            "step": "invoice_matching",
            "title": "Match Invoices to Payments",
            "status": "running",
        }
        try:
            inv_result = await reconciliation_service.reconcile_invoice_payments(entity_id)
            step.update({
                "status": "completed",
                "invoices_checked": inv_result.get("invoices_checked", 0),
                "invoices_matched": inv_result.get("invoices_matched", 0),
            })
        except Exception as e:
            logger.error("Invoice matching step failed: %s", e)
            step.update({"status": "error", "error": str(e)})
            overall_errors.append({"step": "invoice_matching", "error": str(e)})
        steps.append(step)

        # ── Scope: payments — accrual journals ──────────────────────────────
        if run_all or scope == "payments":
            step = {
                "step": "journal_payments",
                "title": "Accrue Payments (Revenue Recognition)",
                "status": "running",
            }
            try:
                pay_result = await self.auto_journal_payments(entity_id)
                step.update({
                    "status": "completed",
                    "payments_processed": pay_result.get("payments_processed", 0),
                    "created": pay_result.get("created", 0),
                    "skipped": pay_result.get("skipped", 0),
                    "errors": pay_result.get("errors", []),
                })
                if pay_result.get("errors"):
                    for err in pay_result["errors"]:
                        overall_errors.append({
                            "step": "journal_payments",
                            "source_id": err.get("payment_id"),
                            "error": err.get("error"),
                        })
            except Exception as e:
                logger.error("Journal payments step failed: %s", e)
                step.update({"status": "error", "error": str(e)})
                overall_errors.append({"step": "journal_payments", "error": str(e)})
            steps.append(step)

        # ── Scope: transactions — expenses + settlements ────────────────────
        if run_all or scope == "transactions":
            # Settlements (inbound gateway transfers)
            step = {
                "step": "journal_settlements",
                "title": "Settle Gateway Payouts",
                "status": "running",
            }
            try:
                settle_result = await self.auto_journal_settlements(entity_id)
                step.update({
                    "status": "completed",
                    "settlements_processed": settle_result.get("settlements_processed", 0),
                    "created": settle_result.get("created", 0),
                    "skipped": settle_result.get("skipped", 0),
                    "errors": settle_result.get("errors", []),
                })
                if settle_result.get("errors"):
                    for err in settle_result["errors"]:
                        overall_errors.append({
                            "step": "journal_settlements",
                            "source_id": err.get("transaction_id"),
                            "error": err.get("error"),
                        })
            except Exception as e:
                logger.error("Journal settlements step failed: %s", e)
                step.update({"status": "error", "error": str(e)})
                overall_errors.append({"step": "journal_settlements", "error": str(e)})
            steps.append(step)

            # Inbound non-settlement (funding, sales receipts, refunds, FX, merchants)
            step = {
                "step": "journal_inbound",
                "title": "Journal Inbound Transactions",
                "status": "running",
            }
            try:
                inbound_result = await self.auto_journal_inbound(entity_id)
                step.update({
                    "status": "completed",
                    "transactions_processed": inbound_result.get("transactions_processed", 0),
                    "created": inbound_result.get("created", 0),
                    "skipped": inbound_result.get("skipped", 0),
                    "passthrough": inbound_result.get("passthrough", {}),
                    "by_type": inbound_result.get("by_type", {}),
                    "errors": inbound_result.get("errors", []),
                })
                if inbound_result.get("errors"):
                    for err in inbound_result["errors"]:
                        overall_errors.append({
                            "step": "journal_inbound",
                            "source_id": err.get("transaction_id"),
                            "error": err.get("error"),
                        })
            except Exception as e:
                logger.error("Journal inbound step failed: %s", e)
                step.update({"status": "error", "error": str(e)})
                overall_errors.append({"step": "journal_inbound", "error": str(e)})
            steps.append(step)

            # Expenses (outbound transactions)
            step = {
                "step": "journal_expenses",
                "title": "Journal Expenses",
                "status": "running",
            }
            try:
                expense_result = await self.auto_journal_expenses(entity_id)
                step.update({
                    "status": "completed",
                    "transactions_processed": expense_result.get("transactions_processed", 0),
                    "created": expense_result.get("created", 0),
                    "skipped": expense_result.get("skipped", 0),
                    "errors": expense_result.get("errors", []),
                })
                if expense_result.get("errors"):
                    for err in expense_result["errors"]:
                        overall_errors.append({
                            "step": "journal_expenses",
                            "source_id": err.get("transaction_id"),
                            "error": err.get("error"),
                        })
            except Exception as e:
                logger.error("Journal expenses step failed: %s", e)
                step.update({"status": "error", "error": str(e)})
                overall_errors.append({"step": "journal_expenses", "error": str(e)})
            steps.append(step)

        # ── Scope: invoices — purchase / sale / payment journals ────────────
        if run_all or scope == "invoices":
            step = {
                "step": "journal_invoices",
                "title": "Journal Invoices",
                "status": "running",
            }
            try:
                inv_j_result = await self.auto_journal_invoices(entity_id)
                step.update({
                    "status": "completed",
                    "invoices_processed": inv_j_result.get("invoices_processed", 0),
                    "created": inv_j_result.get("created", 0),
                    "skipped": inv_j_result.get("skipped", 0),
                    "errors": inv_j_result.get("errors", []),
                })
                if inv_j_result.get("errors"):
                    for err in inv_j_result["errors"]:
                        overall_errors.append({
                            "step": "journal_invoices",
                            "source_id": err.get("invoice_id"),
                            "error": err.get("error"),
                        })
            except Exception as e:
                logger.error("Journal invoices step failed: %s", e)
                step.update({"status": "error", "error": str(e)})
                overall_errors.append({"step": "journal_invoices", "error": str(e)})
            steps.append(step)

        # ── Summary ─────────────────────────────────────────────────────────
        total_created = sum(s.get("created", 0) for s in steps if s.get("created"))
        total_skipped = sum(s.get("skipped", 0) for s in steps if s.get("skipped"))
        failed_steps = [s["step"] for s in steps if s["status"] == "error"]

        return {
            "entity_id": str(entity_id),
            "scope": scope or "all",
            "status": "completed" if not failed_steps else "completed_with_errors",
            "steps": steps,
            "summary": {
                "total_journals_created": total_created,
                "total_skipped": total_skipped,
                "total_errors": len(overall_errors),
                "failed_steps": failed_steps,
            },
            "errors": overall_errors,
            "started_at": pipeline_start.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }

    # =========================================================================
    # JOURNAL REVERSAL
    # =========================================================================

    async def reverse_journal(
        self,
        entity_id: UUID,
        journal_id: UUID,
    ) -> Dict[str, Any]:
        """Reverse a posted journal by creating a counter-journal.

        The original journal is marked as 'reversed' and linked to the reversal.

        Args:
            entity_id: The entity
            journal_id: The journal to reverse

        Returns:
            The reversal journal record
        """
        original = await self._fetch_journal(journal_id)
        if not original:
            raise JournalError(f"Journal not found: {journal_id}")

        if original.get("status") != "posted":
            raise JournalError(
                f"Cannot reverse journal with status '{original.get('status')}'"
            )

        # Check not already reversed
        if original.get("reversed_by_id"):
            raise JournalError(f"Journal already reversed by {original['reversed_by_id']}")

        # Get original line items
        original_lines = await self._fetch_journal_line_items(journal_id)

        # Build reversed line items (swap debits and credits)
        reversed_lines = [
            {
                "account_id": li["account_id"],
                "debit": li.get("credit", 0),
                "credit": li.get("debit", 0),
                "currency": li.get("currency"),
                "description": f"Reversal: {li.get('description', '')}",
            }
            for li in original_lines
        ]

        # Create reversal journal
        reversal = await self._create_journal(
            entity_id=entity_id,
            journal_type="reversal",
            journal_date=datetime.now(timezone.utc).isoformat(),
            description=f"Reversal of journal {journal_id}",
            source_type=original.get("source_type"),
            source_id=UUID(original["source_id"]) if original.get("source_id") else None,
            status="posted",
            line_items=reversed_lines,
        )

        # Mark original as reversed
        await asyncio.to_thread(
            lambda: self.client.table("journals")
            .update({
                "status": "reversed",
                "reversed_by_id": reversal["id"],
            })
            .eq("id", str(journal_id))
            .execute()
        )

        return reversal

    # =========================================================================
    # JOURNAL QUERIES
    # =========================================================================

    async def list_journals(
        self,
        entity_id: UUID,
        journal_type: Optional[str] = None,
        status_filter: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """List journals with line items.

        Args:
            entity_id: Entity to query
            journal_type: Optional filter (accrual, settlement, adjustment, reversal)
            status_filter: Optional filter (draft, posted, reversed)
            limit: Max results
        """
        def _query():
            query = self.client.table("journals") \
                .select("*, journal_line_items(*)") \
                .eq("entity_id", str(entity_id))

            if journal_type:
                query = query.eq("journal_type", journal_type)
            if status_filter:
                query = query.eq("status", status_filter)

            return query.order("journal_date", desc=True).limit(limit).execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def get_review_summary(
        self,
        entity_id: UUID,
    ) -> Dict[str, Any]:
        """Return items that need human review after journal generation.

        Aggregates:
          1. **Draft journals** — journals marked ``draft`` because the
             automation could not confidently categorise the transaction.
        """
        def _fetch_drafts():
            return self.client.table("journals") \
                .select("id, journal_type, journal_date, description, "
                        "source_type, source_id, journal_line_items(account_id, debit, credit, description)") \
                .eq("entity_id", str(entity_id)) \
                .eq("status", "draft") \
                .order("journal_date", desc=True) \
                .limit(100) \
                .execute()

        drafts_result = await asyncio.to_thread(_fetch_drafts)
        draft_journals = extract_rows(drafts_result)

        # Separate draft journals by type for actionability
        draft_by_type: Dict[str, List[Dict[str, Any]]] = {}
        for j in draft_journals:
            jtype = j.get("journal_type") or "unknown"
            draft_by_type.setdefault(jtype, []).append(j)

        return {
            "entity_id": str(entity_id),
            "summary": {
                "draft_journals_total": len(draft_journals),
                "needs_review": len(draft_journals) > 0,
            },
            "draft_journals": draft_journals,
            "draft_journals_by_type": {
                k: len(v) for k, v in draft_by_type.items()
            },
        }

    # =========================================================================
    # BATCH JOURNAL CREATION
    # =========================================================================

    async def auto_journal_payments(
        self,
        entity_id: UUID,
        payment_ids: Optional[List[UUID]] = None,
    ) -> Dict[str, Any]:
        """Batch-create accrual journals for captured payments.

        If payment_ids is not specified, finds all captured payments without
        existing accrual journals.
        """
        if payment_ids is None:
            payment_ids = await self._find_unjournaled_payments(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for i, pid in enumerate(payment_ids):
            if i > 0 and i % self.BATCH_SIZE == 0:
                self._refresh_connection()
                await asyncio.sleep(0.5)
                logger.info(
                    "Accrual progress: %d/%d processed (%d created, %d errors)",
                    i, len(payment_ids), results["created"], len(results["errors"]),
                )

            try:
                await self.create_accrual_journal(entity_id, pid)
                results["created"] += 1
            except JournalError as e:
                if "already" in str(e).lower() or "existing" in str(e).lower():
                    results["skipped"] += 1
                else:
                    results["errors"].append({
                        "payment_id": str(pid),
                        "error": str(e),
                    })

        return {
            "entity_id": str(entity_id),
            "payments_processed": len(payment_ids),
            **results,
        }

    async def auto_journal_settlements(
        self,
        entity_id: UUID,
        transaction_ids: Optional[List[UUID]] = None,
    ) -> Dict[str, Any]:
        """Batch-create settlement journals for inbound gateway transfers."""
        if transaction_ids is None:
            transaction_ids = await self._find_unjournaled_settlements(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for i, tid in enumerate(transaction_ids):
            if i > 0 and i % self.BATCH_SIZE == 0:
                self._refresh_connection()
                await asyncio.sleep(0.5)

            try:
                await self.create_settlement_journal(entity_id, tid)
                results["created"] += 1
            except JournalError as e:
                if "already" in str(e).lower() or "existing" in str(e).lower():
                    results["skipped"] += 1
                else:
                    results["errors"].append({
                        "transaction_id": str(tid),
                        "error": str(e),
                    })

        return {
            "entity_id": str(entity_id),
            "settlements_processed": len(transaction_ids),
            **results,
        }

    async def auto_journal_invoices(
        self,
        entity_id: UUID,
        invoice_ids: Optional[List[UUID]] = None,
    ) -> Dict[str, Any]:
        """Batch-create purchase / sale / payment journals for invoices.

        For each unjournaled invoice:
        - PURCHASE invoices → create_purchase_journal (always credits AP)
        - SALE invoices → create_sale_journal
        - If a matching financial transaction exists → auto-set invoice to PAID
          and create_invoice_payment_journal to clear the AP
        """
        if invoice_ids is None:
            invoice_ids = await self._find_unjournaled_invoices(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for i, inv_id in enumerate(invoice_ids):
            if i > 0 and i % self.BATCH_SIZE == 0:
                self._refresh_connection()
                await asyncio.sleep(0.5)

            try:
                invoice = await self._fetch_invoice(inv_id)
                if not invoice:
                    results["errors"].append({
                        "invoice_id": str(inv_id),
                        "error": "Invoice not found",
                    })
                    continue

                inv_type = invoice.get("invoice_type", "PURCHASE")
                inv_number = invoice.get("invoice_number", "")
                inv_status = invoice.get("status", "OPEN")

                # Create the accrual-side journal (purchase or sale)
                if inv_type == "SALE":
                    await self.create_sale_journal(entity_id, inv_id)
                else:
                    await self.create_purchase_journal(entity_id, inv_id)
                results["created"] += 1

                # Auto-pay: if a matching transaction exists, mark as PAID + clear AP
                if inv_status not in ("PAID", "paid"):
                    txn_id = await self._find_transaction_for_invoice(entity_id, inv_number)
                    if txn_id:
                        # Mark invoice as PAID in the database
                        await asyncio.to_thread(
                            lambda: self.client.table("invoices")
                            .update({"status": "PAID", "updated_at": datetime.now(timezone.utc).isoformat()})
                            .eq("id", str(inv_id))
                            .execute()
                        )
                        inv_status = "PAID"
                        logger.info(
                            "Auto-matched invoice %s to transaction %s — set to PAID",
                            inv_number, txn_id,
                        )

                # If paid, also create the payment journal (clears AP)
                if inv_status in ("PAID", "paid"):
                    try:
                        await self.create_invoice_payment_journal(entity_id, inv_id)
                        results["created"] += 1
                    except JournalError:
                        pass  # Already exists or other issue

            except JournalError as e:
                if "already" in str(e).lower() or "existing" in str(e).lower():
                    results["skipped"] += 1
                else:
                    results["errors"].append({
                        "invoice_id": str(inv_id),
                        "error": str(e),
                    })

        return {
            "entity_id": str(entity_id),
            "invoices_processed": len(invoice_ids),
            **results,
        }

    # =========================================================================
    # AUTO-JOURNAL INBOUND TRANSACTIONS (Non-settlement inflows)
    # =========================================================================

    async def auto_journal_inbound(
        self,
        entity_id: UUID,
    ) -> Dict[str, Any]:
        """Batch-create journals for all unjournaled inbound transactions.

        Steps:
        1. Detect PayPal passthrough pairs and classify the IN side.
        2. Find all unjournaled inbound transactions, classified by type.
        3. Route each to the appropriate journal creation method.
        """
        # Step 1: classify PayPal passthroughs first
        passthrough_result = await self._detect_paypal_passthroughs(entity_id)

        # Step 2: find and classify all unjournaled inbound
        classified = await self._find_unjournaled_inbound(entity_id)

        results: Dict[str, Any] = {
            "passthrough": passthrough_result,
            "created": 0,
            "skipped": 0,
            "errors": [],
            "by_type": {},
        }

        type_method_map = {
            "funding": self.create_funding_journal,
            "sales_receipt": self.create_sales_receipt_journal,
            "refund": self.create_refund_journal,
            "fx_conversion": self.create_fx_conversion_journal,
            "merchant": self.create_funding_journal,  # merchant receipts use funding (DR Cash, CR Revenue)
        }

        all_items = 0
        for category, txns in classified.items():
            cat_results = {"total": len(txns), "created": 0, "skipped": 0, "errors": []}
            method = type_method_map.get(category)
            if not method:
                continue

            for i, txn in enumerate(txns):
                all_items += 1
                if all_items > 0 and all_items % self.BATCH_SIZE == 0:
                    self._refresh_connection()
                    await asyncio.sleep(0.5)

                try:
                    await method(entity_id, UUID(txn["id"]))
                    cat_results["created"] += 1
                    results["created"] += 1
                except JournalError as e:
                    if "already" in str(e).lower() or "existing" in str(e).lower():
                        cat_results["skipped"] += 1
                        results["skipped"] += 1
                    else:
                        err = {"transaction_id": txn["id"], "error": str(e)}
                        cat_results["errors"].append(err)
                        results["errors"].append(err)

            results["by_type"][category] = cat_results

        results["transactions_processed"] = all_items
        results["entity_id"] = str(entity_id)
        return results

    # =========================================================================
    # INTERNAL HELPERS
    # =========================================================================

    async def _create_journal(
        self,
        entity_id: UUID,
        journal_type: str,
        journal_date: str,
        description: str,
        source_type: Optional[str],
        source_id: Optional[UUID],
        status: str,
        line_items: List[Dict[str, Any]],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a journal with line items."""
        journal_data = {
            "entity_id": str(entity_id),
            "journal_date": journal_date,
            "journal_type": journal_type,
            "description": description,
            "source_type": source_type,
            "source_id": str(source_id) if source_id else None,
            "status": status,
            "posted_at": datetime.now(timezone.utc).isoformat() if status == "posted" else None,
            "metadata": metadata or {},
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("journals")
            .upsert(
                journal_data,
                on_conflict="entity_id,source_type,source_id,journal_type",
            )
            .execute()
        )

        if not result.data:
            raise JournalError("Failed to create journal")

        journal_id = _extract_id(result)

        # Delete existing line items (for idempotency)
        await asyncio.to_thread(
            lambda: self.client.table("journal_line_items")
            .delete()
            .eq("journal_id", str(journal_id))
            .execute()
        )

        # Insert line items (include effective_date from journal for time-bound queries)
        if line_items:
            items_data = [
                {**li, "journal_id": str(journal_id), "effective_date": journal_date}
                for li in line_items
            ]
            await asyncio.to_thread(
                lambda: self.client.table("journal_line_items")
                .insert(items_data)
                .execute()
            )

        # Return full journal with line items
        return await self._fetch_journal(journal_id) or {"id": str(journal_id)}

    async def _fetch_order(self, order_id: UUID) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("orders")
            .select("*")
            .eq("id", str(order_id))
            .execute()
        )
        return extract_row(result)

    async def _fetch_payment(self, payment_id: str) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("payments")
            .select("*")
            .eq("id", payment_id)
            .execute()
        )
        return extract_row(result)

    async def _fetch_payment_with_fees(self, payment_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a payment with its gateway fees from payment_fees."""
        result = await asyncio.to_thread(
            lambda: self.client.table("payments")
            .select("*, payment_fees(net_fee)")
            .eq("id", payment_id)
            .execute()
        )
        row = extract_row(result)
        if not row:
            return None
        # Flatten fee data
        fees = row.pop("payment_fees", []) or []
        total_fee = sum(Decimal(str(f.get("net_fee", 0))) for f in fees)
        row["_fee_amount"] = float(total_fee)
        return row

    async def _fetch_invoice(self, invoice_id: UUID) -> Optional[Dict[str, Any]]:
        """Fetch an invoice by ID."""
        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .select("*")
            .eq("id", str(invoice_id))
            .execute()
        )
        return extract_row(result)

    async def _fetch_invoice_line_items(self, invoice_id: UUID) -> List[Dict[str, Any]]:
        """Fetch all line items for an invoice."""
        result = await asyncio.to_thread(
            lambda: self.client.table("invoice_line_items")
            .select("*")
            .eq("invoice_id", str(invoice_id))
            .execute()
        )
        return extract_rows(result)

    async def _get_contact_name(self, contact_id: Optional[str]) -> str:
        """Fetch a contact's display name by UUID."""
        if not contact_id:
            return "Unknown"
        try:
            result = await asyncio.to_thread(
                lambda: self.client.table("contacts")
                .select("name, company_name")
                .eq("id", contact_id)
                .limit(1)
                .execute()
            )
            if result.data:
                row = result.data[0]
                return row.get("company_name") or row.get("name") or "Unknown"
        except Exception:
            pass
        return "Unknown"

    async def _fetch_financial_transaction(self, txn_id: str) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("financial_transactions")
            .select("*")
            .eq("id", txn_id)
            .execute()
        )
        return extract_row(result)

    async def _find_transaction_for_invoice(
        self, entity_id: UUID, invoice_number: str
    ) -> Optional[UUID]:
        """Find a financial transaction whose metadata.invoice_id matches the invoice number.

        Returns the transaction UUID if found, or None.
        """
        if not invoice_number:
            return None

        def _query():
            return (
                self.client.table("financial_transactions")
                .select("id")
                .eq("entity_id", str(entity_id))
                .filter("metadata->>invoice_id", "eq", invoice_number)
                .is_("excluded_reason", "null")
                .limit(1)
                .execute()
            )

        result = await asyncio.to_thread(_query)
        rows = result.data or []
        return UUID(rows[0]["id"]) if rows else None

    async def _fetch_journal(self, journal_id: UUID) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("journals")
            .select("*, journal_line_items(*)")
            .eq("id", str(journal_id))
            .execute()
        )
        return extract_row(result)

    async def _fetch_journal_line_items(self, journal_id: UUID) -> List[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("journal_line_items")
            .select("*")
            .eq("journal_id", str(journal_id))
            .execute()
        )
        return extract_rows(result)

    async def _find_journal(
        self,
        entity_id: UUID,
        source_type: str,
        source_id: UUID,
        journal_type: str,
    ) -> Optional[Dict[str, Any]]:
        """Find an existing journal by natural key."""
        result = await asyncio.to_thread(
            lambda: self.client.table("journals")
            .select("*, journal_line_items(*)")
            .eq("entity_id", str(entity_id))
            .eq("source_type", source_type)
            .eq("source_id", str(source_id))
            .eq("journal_type", journal_type)
            .execute()
        )
        return extract_row(result)

    # ── Personal funding detection ──────────────────────────────────────

    _PERSONAL_PATTERNS = [
        "tobi amao", "amao t g a", "amao tga",
        "treadsoul", "starting up",
    ]

    def _is_personal_funding(
        self,
        description: str,
        counterparty: str,
        txn: Dict[str, Any],
    ) -> bool:
        """Return True if the transaction looks like personal owner funding."""
        combined = f"{description} {counterparty}".lower()
        for pat in self._PERSONAL_PATTERNS:
            if pat in combined:
                return True
        meta = txn.get("metadata") or {}
        if meta.get("passthrough_type") == "personal_funding":
            return True
        return False

    # ── PayPal passthrough pair detection ─────────────────────────────────

    async def _detect_paypal_passthroughs(self, entity_id: UUID) -> Dict[str, Any]:
        """Identify PayPal IN/OUT passthrough pairs and classify the IN side.

        A *passthrough* is two PayPal transactions (one IN, one OUT) that
        share the same occurred_at, absolute amount, currency and invoice_id.

        Classification rules (IN-side event code is the reliable signal):
        - **T0700 IN** (any OUT) → personal funding. T0700 = Revolut card topping
          up the PayPal balance to cover a supplier payment. This is the most common
          pattern (MailChimp, Wellsucceed GBP amounts, UPS, etc.).
        - **T0200 IN + T0006 OUT** → personal funding (Click & Drop shipping
          passthroughs where the owner pays from their personal card).
        - **T1105 IN** (any OUT) → personal funding (refund reversal passthrough).
        - Other IN event codes paired with T0003 OUT → eBay marketplace flows,
          not personal funding.

        Updates the IN transaction's ``metadata`` (passthrough_type) and
        ``description`` so downstream journal logic and UI are both clear.
        """
        def _query():
            return (
                self.client.table("financial_transactions")
                .select("id, direction, amount, currency_code, occurred_at, "
                        "description, metadata, transaction_type")
                .eq("entity_id", str(entity_id))
                .eq("source", "paypal")
                .is_("excluded_reason", "null")
                .execute()
            )

        result = await asyncio.to_thread(_query)
        rows = result.data or []

        # Bucket by (occurred_at, abs_amount, currency, invoice_id)
        from collections import defaultdict
        buckets: Dict[tuple, Dict[str, list]] = defaultdict(lambda: {"in": [], "out": []})
        for r in rows:
            meta = r.get("metadata") or {}
            key = (
                r.get("occurred_at"),
                str(abs(float(r.get("amount", 0)))),
                r.get("currency_code", ""),
                str(meta.get("invoice_id", "")),
            )
            direction = r.get("direction", "")
            if direction in ("in", "out"):
                buckets[key][direction].append(r)

        classified = 0
        already_done = 0
        skipped = 0
        for _key, sides in buckets.items():
            if not sides["in"] or not sides["out"]:
                continue
            in_txn = sides["in"][0]
            out_txn = sides["out"][0]

            # NOTE: PayPal stores the event code as "transaction_event_code" in
            # metadata, NOT "event_code".  Using the wrong key returns "" for
            # all rows which is why the old code never classified anything.
            in_meta = in_txn.get("metadata") or {}
            out_meta = out_txn.get("metadata") or {}
            in_event = str(in_meta.get("transaction_event_code", ""))
            out_event = str(out_meta.get("transaction_event_code", ""))

            if in_meta.get("passthrough_type"):
                already_done += 1
                continue  # Already classified in a previous run

            # Determine whether this IN transaction is personal owner funding:
            # T0700 IN = Revolut/bank card topping up PayPal balance (always personal)
            # T1105 IN = reversal passthrough (always personal)
            # T0200 IN + T0006 OUT = Click & Drop / other card passthrough
            is_personal = (
                in_event in ("T0700", "T1105")
                or (out_event == "T0006")
            )

            if is_personal:
                in_meta["passthrough_type"] = "personal_funding"

                # Update the description so it is clear in the UI and journals
                orig_desc = in_txn.get("description") or ""
                if " | Ref:" in orig_desc:
                    new_desc = orig_desc.replace(" | Ref:", " — Passthrough funding | Ref:", 1)
                elif orig_desc:
                    new_desc = orig_desc + " — Passthrough funding"
                else:
                    new_desc = f"{in_event} — Passthrough funding"

                await asyncio.to_thread(
                    lambda tid=in_txn["id"], m=in_meta, d=new_desc: (
                        self.client.table("financial_transactions")
                        .update({"metadata": m, "description": d})
                        .eq("id", tid)
                        .execute()
                    )
                )
                classified += 1
            else:
                # T0200 IN + T0003 OUT = eBay marketplace / subscription flow
                skipped += 1

        total_examined = classified + already_done + skipped
        return {
            "classified": classified,
            "already_classified": already_done,
            "skipped": skipped,
            "total_pairs_examined": total_examined,
        }

    async def _find_unjournaled_payments(self, entity_id: UUID) -> List[UUID]:
        """Find captured payments without accrual journals."""
        def _query():
            payments = self.client.table("payments") \
                .select("id") \
                .eq("entity_id", str(entity_id)) \
                .eq("status", "captured") \
                .execute()

            if not payments.data:
                return []

            payment_ids = [row["id"] for row in payments.data]

            journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "payment") \
                .eq("journal_type", "accrual") \
                .neq("status", "reversed") \
                .execute()

            accrued_ids = {row["source_id"] for row in (journals.data or [])}
            return [UUID(pid) for pid in payment_ids if pid not in accrued_ids]

        return await asyncio.to_thread(_query)

    async def _find_unjournaled_settlements(self, entity_id: UUID) -> List[UUID]:
        """Find inbound Stripe/PayPal transfers without settlement journals."""
        def _query():
            txns = self.client.table("financial_transactions") \
                .select("id, description, metadata") \
                .eq("entity_id", str(entity_id)) \
                .eq("source", "revolut") \
                .eq("direction", "in") \
                .eq("transaction_type", "transfer") \
                .execute()

            if not txns.data:
                return []

            # Filter to Stripe/PayPal payouts, exclude declined
            eligible = []
            for t in txns.data:
                desc = (t.get("description") or "").lower()
                meta = t.get("metadata") or {}
                if meta.get("state") == "declined":
                    continue
                if "stripe" in desc or "paypal" in desc:
                    eligible.append(t["id"])

            if not eligible:
                return []

            journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "financial_transaction") \
                .eq("journal_type", "settlement") \
                .neq("status", "reversed") \
                .execute()

            settled_ids = {row["source_id"] for row in (journals.data or [])}
            return [UUID(tid) for tid in eligible if tid not in settled_ids]

        return await asyncio.to_thread(_query)

    async def _find_unjournaled_inbound(
        self, entity_id: UUID
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Find inbound transactions that need journals, classified by type.

        Returns a dict with keys:
        - ``funding``       — personal owner funding (Revolut + PayPal passthrough)
        - ``sales_receipt``  — PayPal direct sales (T0006/T0011 IN)
        - ``refund``        — refund inflows
        - ``fx_conversion`` — currency conversion transactions
        - ``merchant``      — other business transfers / merchant payments

        Excludes:
        - Transactions already journaled for any inbound journal type
        - Declined transactions
        - Excluded transactions
        - Stripe/PayPal settlement transfers (handled by settlement journal)
        """
        INBOUND_JOURNAL_TYPES = (
            "funding", "sales_receipt", "refund", "fx_conversion", "receipt",
        )

        def _query():
            # ── Fetch ALL inbound transactions ──────────────────────────
            txns = self.client.table("financial_transactions") \
                .select("id, source, direction, amount, currency_code, "
                        "description, counterparty_name, transaction_type, "
                        "metadata, occurred_at") \
                .eq("entity_id", str(entity_id)) \
                .eq("direction", "in") \
                .is_("excluded_reason", "null") \
                .execute()

            if not txns.data:
                return {}

            # Filter out declined
            rows = [
                r for r in txns.data
                if (r.get("metadata") or {}).get("state") != "declined"
            ]
            if not rows:
                return {}

            # ── Fetch already-journaled inbound transaction IDs ─────────
            journaled_ids: set = set()
            for jt in INBOUND_JOURNAL_TYPES:
                j_result = self.client.table("journals") \
                    .select("source_id") \
                    .eq("entity_id", str(entity_id)) \
                    .eq("source_type", "financial_transaction") \
                    .eq("journal_type", jt) \
                    .neq("status", "reversed") \
                    .execute()
                journaled_ids.update(
                    row["source_id"] for row in (j_result.data or [])
                )

            # Also exclude settlement-journaled IDs
            s_result = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "financial_transaction") \
                .eq("journal_type", "settlement") \
                .neq("status", "reversed") \
                .execute()
            journaled_ids.update(
                row["source_id"] for row in (s_result.data or [])
            )

            eligible = [r for r in rows if r["id"] not in journaled_ids]
            return eligible

        raw_eligible = await asyncio.to_thread(_query)
        if not raw_eligible:
            return {"funding": [], "sales_receipt": [], "refund": [],
                    "fx_conversion": [], "merchant": []}

        classified: Dict[str, List[Dict[str, Any]]] = {
            "funding": [],
            "sales_receipt": [],
            "refund": [],
            "fx_conversion": [],
            "merchant": [],
        }

        for txn in raw_eligible:
            source = txn.get("source", "")
            ttype = txn.get("transaction_type", "")
            meta = txn.get("metadata") or {}
            desc = txn.get("description") or ""
            counterparty = txn.get("counterparty_name") or ""
            # NOTE: PayPal stores the event code as "transaction_event_code"
            event_code = str(meta.get("transaction_event_code", ""))

            # Skip Stripe/PayPal transfers — handled by settlement path
            if source == "revolut" and ttype == "transfer":
                desc_lower = desc.lower()
                if "stripe" in desc_lower or "paypal" in desc_lower:
                    continue

            # FX conversion
            if ttype == "fx_conversion":
                classified["fx_conversion"].append(txn)
                continue

            # Refund
            if ttype == "refund":
                classified["refund"].append(txn)
                continue

            # PayPal passthrough already classified as personal funding
            if meta.get("passthrough_type") == "personal_funding":
                classified["funding"].append(txn)
                continue

            # T0700/T1105 IN without a passthrough_type yet → still personal funding
            # (Handles cases where _detect_paypal_passthroughs hasn't run yet)
            if source == "paypal" and event_code in ("T0700", "T1105"):
                classified["funding"].append(txn)
                continue

            # PayPal direct sales (T0006 or T0011 inbound)
            if source == "paypal" and event_code in ("T0006", "T0011"):
                classified["sales_receipt"].append(txn)
                continue

            # Personal funding (Revolut owner transfers)
            if self._is_personal_funding(desc, counterparty, txn):
                classified["funding"].append(txn)
                continue

            # Everything else that is inbound = merchant / business receipt
            classified["merchant"].append(txn)

        return classified

    async def _find_unjournaled_invoices(self, entity_id: UUID) -> List[UUID]:
        """Find invoices without existing journal entries.

        Excludes invoices that have been journaled either directly (source_type=invoice)
        or via a matched financial transaction (source_type=financial_transaction,
        journal_type=purchase).
        """
        def _query():
            invoices = self.client.table("invoices") \
                .select("id, invoice_number") \
                .eq("entity_id", str(entity_id)) \
                .execute()

            if not invoices.data:
                return []

            invoice_number_by_id = {
                row["id"]: row.get("invoice_number", "")
                for row in invoices.data
            }

            # Invoices already journaled directly
            inv_journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "invoice") \
                .neq("status", "reversed") \
                .execute()
            journaled_by_invoice = {row["source_id"] for row in (inv_journals.data or [])}

            # Invoices already journaled via a matched financial transaction
            txn_journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "financial_transaction") \
                .eq("journal_type", "purchase") \
                .neq("status", "reversed") \
                .execute()
            journaled_txn_ids = {row["source_id"] for row in (txn_journals.data or [])}

            invoice_numbers_covered: set = set()
            if journaled_txn_ids:
                txn_rows = self.client.table("financial_transactions") \
                    .select("id, metadata") \
                    .in_("id", list(journaled_txn_ids)) \
                    .execute()
                invoice_numbers_covered = {
                    str((row.get("metadata") or {}).get("invoice_id", "")).strip()
                    for row in (txn_rows.data or [])
                }
                invoice_numbers_covered.discard("")

            unjournaled = []
            for iid, inv_num in invoice_number_by_id.items():
                if iid in journaled_by_invoice:
                    continue
                if inv_num and inv_num in invoice_numbers_covered:
                    continue
                unjournaled.append(UUID(iid))

            return unjournaled

        return await asyncio.to_thread(_query)

    async def _find_unjournaled_expenses(self, entity_id: UUID) -> List[UUID]:
        """Find OUT-direction transactions eligible for expense journals.

        Excludes:
        - fx_conversion, reserve_hold, reserve_release (not expenses)
        - Declined transactions (metadata.state == "declined")
        - Transactions already journaled as expenses
        - Transactions with excluded_reason set (cross-provider duplicates)
        - Transactions whose metadata.invoice_id matches a known invoice number
          (those are journaled via the invoice path with create_purchase_journal)
        """
        def _query():
            txns = self.client.table("financial_transactions") \
                .select("id, metadata") \
                .eq("entity_id", str(entity_id)) \
                .eq("direction", "out") \
                .is_("excluded_reason", "null") \
                .not_.in_("transaction_type", [
                    "fx_conversion", "reserve_hold", "reserve_release",
                ]) \
                .execute()

            if not txns.data:
                return []

            # Filter out declined transactions
            eligible_rows = [
                r for r in txns.data
                if (r.get("metadata") or {}).get("state") != "declined"
            ]

            if not eligible_rows:
                return []

            # Exclude transactions that are linked to known invoices
            # (those are handled exclusively by the invoice journaling path)
            invoice_rows = self.client.table("invoices") \
                .select("invoice_number") \
                .eq("entity_id", str(entity_id)) \
                .execute()
            invoice_number_set = {
                row["invoice_number"]
                for row in (invoice_rows.data or [])
                if row.get("invoice_number")
            }

            non_invoice_rows = [
                r for r in eligible_rows
                if str((r.get("metadata") or {}).get("invoice_id") or "").strip()
                not in invoice_number_set
            ]
            txn_ids = [row["id"] for row in non_invoice_rows]

            if not txn_ids:
                return []

            journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "financial_transaction") \
                .eq("journal_type", "expense") \
                .neq("status", "reversed") \
                .execute()

            journaled_ids = {row["source_id"] for row in (journals.data or [])}
            return [UUID(tid) for tid in txn_ids if tid not in journaled_ids]

        return await asyncio.to_thread(_query)


# Global service instance
journal_service = JournalService()
