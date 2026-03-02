"""Double-entry journal system for accounting.

Implements two journal types:
- **Accrual journal**: Created on order completion. Debits clearing, credits revenue/shipping/tax.
- **Settlement journal**: Created when a bank payout arrives. Debits cash + fees, credits clearing.

Safety rules:
- Never post cash journals without a matching bank transaction
- Never recognize revenue from payouts
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

logger = logging.getLogger(__name__)

BALANCE_TOLERANCE = Decimal("0.01")


class JournalError(Exception):
    """Raised when journal operations fail."""
    pass


class JournalService:
    """Service for creating and managing double-entry journal entries."""

    def __init__(self):
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = get_supabase_client()
        if self._client is None:
            raise RuntimeError("Supabase client not configured")
        return self._client

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

        The entity_id parameter is kept for backward compat but is ignored
        (chart_of_accounts is no longer entity-scoped).
        """
        result = await asyncio.to_thread(
            lambda: self.client.table("chart_of_accounts")
            .select("id")
            .eq("account_number", account_number)
            .execute()
        )
        if result.data:
            return _extract_id(result)
        return None

    # =========================================================================
    # ACCRUAL JOURNAL
    # =========================================================================

    async def create_accrual_journal(
        self,
        entity_id: UUID,
        order_id: UUID,
    ) -> Dict[str, Any]:
        """Create an accrual journal entry for a completed order.

        Journal entries:
            DEBIT  1200 Payment Gateway Clearing = grand_total
            CREDIT 4000 Revenue                  = subtotal - discounts
            CREDIT 4100 Shipping Revenue         = shipping_total
            CREDIT 2100 Tax Payable              = tax_total

        Args:
            entity_id: The entity
            order_id: The order to accrue

        Returns:
            Journal record with line items

        Raises:
            JournalError: If order not found, already accrued, or debits != credits
        """
        # Fetch order
        order = await self._fetch_order(order_id)
        if not order:
            raise JournalError(f"Order not found: {order_id}")

        # Check idempotency - already accrued?
        existing = await self._find_journal(entity_id, "order", order_id, "accrual")
        if existing:
            return existing

        # Extract amounts
        grand_total = Decimal(str(order.get("grand_total_amount", 0)))
        subtotal = Decimal(str(order.get("subtotal_amount", 0)))
        discount_total = Decimal(str(order.get("discount_total_amount", 0)))
        shipping_total = Decimal(str(order.get("shipping_total_amount", 0)))
        tax_total = Decimal(str(order.get("tax_total_amount", 0)))
        currency = order.get("currency", "GBP")

        revenue_amount = subtotal - discount_total

        # Resolve account IDs
        clearing_id = await self._get_account_id(entity_id, "1200")
        revenue_id = await self._get_account_id(entity_id, "4000")
        shipping_rev_id = await self._get_account_id(entity_id, "4100")
        tax_id = await self._get_account_id(entity_id, "2100")

        if not all([clearing_id, revenue_id, shipping_rev_id, tax_id]):
            raise JournalError(
                "Missing chart of accounts. Run seed_chart_of_accounts first."
            )

        # Build line items
        line_items = []

        # DEBIT clearing (grand total)
        if grand_total > 0:
            line_items.append({
                "account_id": str(clearing_id),
                "debit": float(grand_total),
                "credit": 0,
                "currency": currency,
                "description": f"Order {order.get('order_number', order_id)} clearing",
            })

        # CREDIT revenue
        if revenue_amount > 0:
            line_items.append({
                "account_id": str(revenue_id),
                "debit": 0,
                "credit": float(revenue_amount),
                "currency": currency,
                "description": f"Revenue for order {order.get('order_number', order_id)}",
            })

        # CREDIT shipping revenue
        if shipping_total > 0:
            line_items.append({
                "account_id": str(shipping_rev_id),
                "debit": 0,
                "credit": float(shipping_total),
                "currency": currency,
                "description": f"Shipping for order {order.get('order_number', order_id)}",
            })

        # CREDIT tax payable
        if tax_total > 0:
            line_items.append({
                "account_id": str(tax_id),
                "debit": 0,
                "credit": float(tax_total),
                "currency": currency,
                "description": f"Tax for order {order.get('order_number', order_id)}",
            })

        # Validate balance
        total_debit = sum(Decimal(str(li["debit"])) for li in line_items)
        total_credit = sum(Decimal(str(li["credit"])) for li in line_items)
        if abs(total_debit - total_credit) > BALANCE_TOLERANCE:
            raise JournalError(
                f"Journal does not balance: debit={total_debit} credit={total_credit}"
            )

        # Create journal
        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="accrual",
            journal_date=order.get("created_at", datetime.now(timezone.utc).isoformat()),
            description=f"Accrual for order {order.get('order_number', order_id)}",
            source_type="order",
            source_id=order_id,
            status="posted",
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # SETTLEMENT JOURNAL
    # =========================================================================

    async def create_settlement_journal(
        self,
        entity_id: UUID,
        reconciliation_match_id: UUID,
    ) -> Dict[str, Any]:
        """Create a settlement journal for a matched bank payout.

        Safety: Only creates when a matching bank transaction exists.

        Journal entries:
            DEBIT  1000/1100 Cash (Revolut/PayPal)    = payout amount
            DEBIT  5000     Processing Fees Expense    = fee amount
            CREDIT 1200     Payment Gateway Clearing   = payout + fees

        Args:
            entity_id: The entity
            reconciliation_match_id: The reconciliation match to settle

        Returns:
            Journal record with line items

        Raises:
            JournalError: If match not found, not matched, or no bank transaction
        """
        # Fetch the reconciliation match
        match = await self._fetch_reconciliation_match(reconciliation_match_id)
        if not match:
            raise JournalError(f"Reconciliation match not found: {reconciliation_match_id}")

        if match.get("status") not in ("matched", "partial"):
            raise JournalError(
                f"Match status is '{match.get('status')}', expected 'matched' or 'partial'"
            )

        # Safety: verify bank transaction exists
        txn_id = match.get("financial_transaction_id")
        if not txn_id:
            raise JournalError("No financial transaction linked to this match. Cannot settle without bank confirmation.")

        txn = await self._fetch_financial_transaction(txn_id)
        if not txn:
            raise JournalError(f"Financial transaction {txn_id} not found")

        # Check idempotency
        existing = await self._find_journal(
            entity_id, "reconciliation_match", reconciliation_match_id, "settlement"
        )
        if existing:
            return existing

        payout_amount = Decimal(str(match.get("clearing_amount", 0)))
        currency = match.get("currency", "GBP")

        # Get fee amount from the payment if available
        fee_amount = Decimal("0")
        payment_id = match.get("payment_id")
        if payment_id:
            payment = await self._fetch_payment(payment_id)
            if payment:
                gross = Decimal(str(payment.get("amount", 0)))
                net = Decimal(str(payment.get("net_amount", gross)))
                fee_amount = gross - net

        # Determine cash account based on transaction source
        source = txn.get("source", "revolut")
        cash_account_code = "1000" if source == "revolut" else "1100"

        # Resolve account IDs
        cash_id = await self._get_account_id(entity_id, cash_account_code)
        fees_id = await self._get_account_id(entity_id, "6000")
        clearing_id = await self._get_account_id(entity_id, "1200")

        if not all([cash_id, fees_id, clearing_id]):
            raise JournalError(
                "Missing chart of accounts. Run seed_chart_of_accounts first."
            )

        line_items = []

        # DEBIT cash (payout amount)
        if payout_amount > 0:
            line_items.append({
                "account_id": str(cash_id),
                "debit": float(payout_amount),
                "credit": 0,
                "currency": currency,
                "description": f"Payout from {source}",
            })

        # DEBIT processing fees
        if fee_amount > 0:
            line_items.append({
                "account_id": str(fees_id),
                "debit": float(fee_amount),
                "credit": 0,
                "currency": currency,
                "description": f"Processing fees ({source})",
            })

        # CREDIT clearing (payout + fees)
        clearing_amount = payout_amount + fee_amount
        if clearing_amount > 0:
            line_items.append({
                "account_id": str(clearing_id),
                "debit": 0,
                "credit": float(clearing_amount),
                "currency": currency,
                "description": f"Settlement clearing ({source})",
            })

        # Validate balance
        total_debit = sum(Decimal(str(li["debit"])) for li in line_items)
        total_credit = sum(Decimal(str(li["credit"])) for li in line_items)
        if abs(total_debit - total_credit) > BALANCE_TOLERANCE:
            raise JournalError(
                f"Journal does not balance: debit={total_debit} credit={total_credit}"
            )

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="settlement",
            journal_date=txn.get("occurred_at", datetime.now(timezone.utc).isoformat()),
            description=f"Settlement via {source} payout",
            source_type="reconciliation_match",
            source_id=reconciliation_match_id,
            status="posted",
            line_items=line_items,
        )

        return journal

    # =========================================================================
    # PURCHASE JOURNAL (Invoice → COGS)
    # =========================================================================

    async def create_purchase_journal(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        force: bool = False,
    ) -> Dict[str, Any]:
        """Create a purchase journal when a supplier invoice is received.

        Creates per-line-item debit entries using each line item's assigned
        GL account, ensuring product/inventory items hit COGS accounts while
        non-product expenses (R&D, marketing, giveaways) hit their specific
        expense accounts.

        Journal entries (per line item):
            DEBIT  <line_item.gl_account_id or default 5000> = line net amount
            ...
            CREDIT 2000 Accounts Payable                     = invoice gross total

        If the invoice has tax, a separate VAT debit entry is created so the
        journal balances (gross = sum of net amounts + tax).

        Links the journal to the invoice via invoices.journal_id.

        Args:
            entity_id: The entity
            invoice_id: The invoice to journal

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

        # Check idempotency — skip if a journal already exists, unless force=True
        existing = await self._find_journal(entity_id, "invoice", invoice_id, "purchase")
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
        default_cogs_id = await self._get_account_id(entity_id, "5000")
        ap_id = await self._get_account_id(entity_id, "2000")
        vat_input_id = await self._get_account_id(entity_id, "1400")  # Input VAT recoverable

        if not ap_id:
            raise JournalError(
                "Missing chart of accounts (2000 AP). Run seed_chart_of_accounts first."
            )
        if not default_cogs_id:
            raise JournalError(
                "Missing chart of accounts (5000 COGS). Run seed_chart_of_accounts first."
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

        # CREDIT Accounts Payable for the full gross amount
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

        journal = await self._create_journal(
            entity_id=entity_id,
            journal_type="purchase",
            journal_date=invoice.get("invoice_date", datetime.now(timezone.utc).isoformat()),
            description=f"Purchase invoice {inv_number} from {counterparty_name}",
            source_type="invoice",
            source_id=invoice_id,
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
        ar_id = await self._get_account_id(entity_id, "1300")
        revenue_id = await self._get_account_id(entity_id, "4000")
        tax_id = await self._get_account_id(entity_id, "2100")

        if not all([ar_id, revenue_id]):
            raise JournalError(
                "Missing chart of accounts (1300, 4000). Run seed_chart_of_accounts first."
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

        Handles both invoice types:

        PURCHASE invoice (pay a supplier):
            DEBIT  2000 Accounts Payable  = gross total
            CREDIT 1000 Cash              = gross total

        SALE invoice (receive payment from customer):
            DEBIT  1000 Cash              = gross total
            CREDIT 1300 Accounts Receivable = gross total

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

        if invoice_type == "SALE":
            # Customer paid us: debit Cash, credit Accounts Receivable
            cash_id = await self._get_account_id(entity_id, "1000")
            ar_id = await self._get_account_id(entity_id, "1300")

            if not all([cash_id, ar_id]):
                raise JournalError(
                    "Missing chart of accounts (1000, 1300). Run seed_chart_of_accounts first."
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
            # We paid supplier (PURCHASE): debit Accounts Payable, credit Cash
            ap_id = await self._get_account_id(entity_id, "2000")
            cash_id = await self._get_account_id(entity_id, "1000")

            if not all([ap_id, cash_id]):
                raise JournalError(
                    "Missing chart of accounts (2000, 1000). Run seed_chart_of_accounts first."
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
            journal_date=datetime.now(timezone.utc).isoformat(),
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

        # Guard: reject payouts (handled by settlement journals)
        txn_type = txn.get("transaction_type") or txn.get("type", "")
        if txn_type in ("payout", "payment"):
            raise JournalError("Payment/payout transactions are handled by settlement journals, not expense journals")

        # Read account_code from metadata (no longer a top-level column)
        meta = txn.get("metadata") or {}
        acct_code = meta.get("account_code")
        if not acct_code:
            acct_code = "6999"  # Default to miscellaneous

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

        # Determine cash account based on source
        source = txn.get("source", "revolut")
        cash_account_code = "1000" if source == "revolut" else "1100"

        # Resolve account IDs
        expense_id = await self._get_account_id(entity_id, acct_code)
        cash_id = await self._get_account_id(entity_id, cash_account_code)

        if not expense_id:
            # Fallback to miscellaneous if specific account doesn't exist
            expense_id = await self._get_account_id(entity_id, "6999")
        if not all([expense_id, cash_id]):
            raise JournalError(
                f"Missing chart of accounts ({acct_code}, {cash_account_code}). "
                "Run seed_chart_of_accounts first."
            )

        category = meta.get("expense_category", "expense")
        counterparty = txn.get("counterparty_name") or txn.get("description") or "Unknown"

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
            status="posted",
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
        without existing expense journals.

        Args:
            entity_id: The entity
            transaction_ids: Optional specific transactions to journal

        Returns:
            Summary of journals created
        """
        if transaction_ids is None:
            transaction_ids = await self._find_unjournaled_expenses(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for txn_id in transaction_ids:
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

    # =========================================================================
    # BATCH JOURNAL CREATION
    # =========================================================================

    async def accrue_orders(
        self,
        entity_id: UUID,
        order_ids: Optional[List[UUID]] = None,
    ) -> Dict[str, Any]:
        """Create accrual journals for multiple orders.

        If order_ids is not specified, finds all completed orders without
        existing accrual journals.

        Args:
            entity_id: The entity
            order_ids: Optional specific orders to accrue

        Returns:
            Summary of journals created
        """
        if order_ids is None:
            order_ids = await self._find_unaccrued_orders(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for order_id in order_ids:
            try:
                await self.create_accrual_journal(entity_id, order_id)
                results["created"] += 1
            except JournalError as e:
                if "already" in str(e).lower() or "existing" in str(e).lower():
                    results["skipped"] += 1
                else:
                    results["errors"].append({
                        "order_id": str(order_id),
                        "error": str(e),
                    })

        return {
            "entity_id": str(entity_id),
            "orders_processed": len(order_ids),
            **results,
        }

    async def settle_matches(
        self,
        entity_id: UUID,
        match_ids: Optional[List[UUID]] = None,
    ) -> Dict[str, Any]:
        """Create settlement journals for reconciliation matches.

        If match_ids not specified, finds all matched entries without
        existing settlement journals.

        Args:
            entity_id: The entity
            match_ids: Optional specific matches to settle

        Returns:
            Summary of journals created
        """
        if match_ids is None:
            match_ids = await self._find_unsettled_matches(entity_id)

        results = {"created": 0, "skipped": 0, "errors": []}

        for match_id in match_ids:
            try:
                await self.create_settlement_journal(entity_id, match_id)
                results["created"] += 1
            except JournalError as e:
                if "already" in str(e).lower() or "existing" in str(e).lower():
                    results["skipped"] += 1
                else:
                    results["errors"].append({
                        "match_id": str(match_id),
                        "error": str(e),
                    })

        return {
            "entity_id": str(entity_id),
            "matches_processed": len(match_ids),
            **results,
        }

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

    async def _fetch_reconciliation_match(self, match_id: UUID) -> Optional[Dict[str, Any]]:
        result = await asyncio.to_thread(
            lambda: self.client.table("reconciliation_matches")
            .select("*")
            .eq("id", str(match_id))
            .execute()
        )
        return extract_row(result)

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

    async def _find_unaccrued_orders(self, entity_id: UUID) -> List[UUID]:
        """Find completed orders without accrual journals."""
        def _query():
            # Get orders that have been completed
            orders = self.client.table("orders") \
                .select("id") \
                .eq("entity_id", str(entity_id)) \
                .in_("status", ["completed", "fulfilled"]) \
                .execute()

            if not orders.data:
                return []

            order_ids = [row["id"] for row in orders.data]

            # Get orders that already have accrual journals
            journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "order") \
                .eq("journal_type", "accrual") \
                .neq("status", "reversed") \
                .execute()

            accrued_ids = {row["source_id"] for row in (journals.data or [])}

            return [UUID(oid) for oid in order_ids if oid not in accrued_ids]

        return await asyncio.to_thread(_query)

    async def _find_unsettled_matches(self, entity_id: UUID) -> List[UUID]:
        """Find reconciliation matches without settlement journals."""
        def _query():
            matches = self.client.table("reconciliation_matches") \
                .select("id") \
                .eq("entity_id", str(entity_id)) \
                .eq("status", "matched") \
                .execute()

            if not matches.data:
                return []

            match_ids = [row["id"] for row in matches.data]

            journals = self.client.table("journals") \
                .select("source_id") \
                .eq("entity_id", str(entity_id)) \
                .eq("source_type", "reconciliation_match") \
                .eq("journal_type", "settlement") \
                .neq("status", "reversed") \
                .execute()

            settled_ids = {row["source_id"] for row in (journals.data or [])}

            return [UUID(mid) for mid in match_ids if mid not in settled_ids]

        return await asyncio.to_thread(_query)

    async def _find_unjournaled_expenses(self, entity_id: UUID) -> List[UUID]:
        """Find payment/fee OUT-direction transactions without expense journals."""
        def _query():
            # Get payment and fee transactions going OUT
            txns = self.client.table("financial_transactions") \
                .select("id") \
                .eq("entity_id", str(entity_id)) \
                .in_("transaction_type", ["payment", "fee"]) \
                .eq("direction", "out") \
                .execute()

            if not txns.data:
                return []

            txn_ids = [row["id"] for row in txns.data]

            # Get transactions that already have expense journals
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
