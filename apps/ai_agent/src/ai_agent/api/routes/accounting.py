"""API routes for accounting operations.

Provides endpoints for:
- Chart of accounts management
- Clearing balance computation
- Reconciliation
- Journal creation (accrual + settlement)
- Journal listing and reversal
"""

import logging
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ...services.reconciliation_service import reconciliation_service
from ...services.journal_service import journal_service, JournalError

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE SCHEMAS
# =============================================================================


class SeedChartRequest(BaseModel):
    entity_id: str = Field(..., description="Entity ID to seed accounts for")


class ClearingBalanceRequest(BaseModel):
    entity_id: str
    currency: Optional[str] = None


class ReconcileRequest(BaseModel):
    entity_id: str
    currency: Optional[str] = None


class AccrueRequest(BaseModel):
    entity_id: str
    order_ids: Optional[List[str]] = Field(
        None, description="Specific order IDs. If omitted, finds all unaccrued completed orders."
    )


class SettleRequest(BaseModel):
    entity_id: str
    match_ids: Optional[List[str]] = Field(
        None, description="Specific match IDs. If omitted, finds all unsettled matches."
    )


class ReverseJournalRequest(BaseModel):
    entity_id: str


class DetectDuplicatesRequest(BaseModel):
    entity_id: str


class PurchaseInvoiceRequest(BaseModel):
    entity_id: str
    invoice_id: str = Field(..., description="Invoice UUID to create COGS journal for")
    create_payment: bool = Field(
        False,
        description="If true and invoice status is 'paid', also create a payment journal",
    )


class ExpenseJournalRequest(BaseModel):
    entity_id: str
    transaction_ids: Optional[List[str]] = Field(
        None,
        description="Specific financial transaction IDs. If omitted, finds all un-journaled expense/fee transactions.",
    )


# =============================================================================
# CHART OF ACCOUNTS
# =============================================================================


@router.get("/chart-of-accounts")
async def get_chart_of_accounts(entity_id: str):
    """List all accounts in the chart of accounts for an entity."""
    try:
        accounts = await journal_service.get_chart_of_accounts(UUID(entity_id))
        return {"entity_id": entity_id, "accounts": accounts}
    except Exception as e:
        logger.error(f"Error fetching chart of accounts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chart-of-accounts/seed")
async def seed_chart_of_accounts(request: SeedChartRequest):
    """Seed the standard chart of accounts for an entity."""
    try:
        result = await journal_service.seed_chart_of_accounts(UUID(request.entity_id))
        return result
    except Exception as e:
        logger.error(f"Error seeding chart of accounts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# CLEARING BALANCE
# =============================================================================


@router.get("/clearing-balance")
async def get_clearing_balance(entity_id: str, currency: Optional[str] = None):
    """Compute the clearing account balance.

    Returns the net balance of the Payment Gateway Clearing account (1200).
    A positive balance means expected but unsettled funds.
    """
    try:
        result = await reconciliation_service.compute_clearing_balance(
            UUID(entity_id), currency
        )
        return result
    except Exception as e:
        logger.error(f"Error computing clearing balance: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# RECONCILIATION
# =============================================================================


@router.post("/reconcile")
async def run_reconciliation(request: ReconcileRequest):
    """Run automated reconciliation matching.

    Matches bank payout transactions against payment records.
    """
    try:
        result = await reconciliation_service.run_reconciliation(
            UUID(request.entity_id), request.currency
        )
        return result
    except Exception as e:
        logger.error(f"Error running reconciliation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/reconciliation-matches")
async def list_reconciliation_matches(
    entity_id: str,
    status_filter: Optional[str] = None,
    limit: int = 100,
):
    """List reconciliation matches with optional status filter."""
    try:
        matches = await reconciliation_service.get_reconciliation_matches(
            UUID(entity_id), status_filter, limit
        )
        return {"entity_id": entity_id, "matches": matches, "count": len(matches)}
    except Exception as e:
        logger.error(f"Error listing reconciliation matches: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/detect-duplicates")
async def detect_duplicates(request: DetectDuplicatesRequest):
    """Detect cross-provider duplicate transactions.

    Finds transactions that appear in both Revolut and PayPal.
    """
    try:
        result = await reconciliation_service.detect_cross_provider_duplicates(
            UUID(request.entity_id)
        )
        return result
    except Exception as e:
        logger.error(f"Error detecting duplicates: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# JOURNALS
# =============================================================================


@router.post("/journals/accrue")
async def accrue_orders(request: AccrueRequest):
    """Generate accrual journals for completed orders.

    Each accrual journal:
    - DEBIT  Payment Gateway Clearing (1200) = grand_total
    - CREDIT Revenue (4000)                  = subtotal - discounts
    - CREDIT Shipping Revenue (4100)         = shipping_total
    - CREDIT Tax Payable (2100)              = tax_total
    """
    try:
        order_ids = [UUID(oid) for oid in request.order_ids] if request.order_ids else None
        result = await journal_service.accrue_orders(UUID(request.entity_id), order_ids)
        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating accrual journals: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/journals/settle")
async def settle_matches(request: SettleRequest):
    """Generate settlement journals for reconciled payouts.

    Each settlement journal:
    - DEBIT  Cash account (1000/1100)         = payout amount
    - DEBIT  Processing Fees Expense (5000)   = fee amount
    - CREDIT Payment Gateway Clearing (1200)  = payout + fees
    """
    try:
        match_ids = [UUID(mid) for mid in request.match_ids] if request.match_ids else None
        result = await journal_service.settle_matches(UUID(request.entity_id), match_ids)
        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating settlement journals: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/journals")
async def list_journals(
    entity_id: str,
    journal_type: Optional[str] = None,
    status_filter: Optional[str] = None,
    limit: int = 100,
):
    """List journals with line items."""
    try:
        journals = await journal_service.list_journals(
            UUID(entity_id), journal_type, status_filter, limit
        )
        return {"entity_id": entity_id, "journals": journals, "count": len(journals)}
    except Exception as e:
        logger.error(f"Error listing journals: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/journals/{journal_id}/reverse")
async def reverse_journal(journal_id: str, request: ReverseJournalRequest):
    """Reverse a posted journal.

    Creates a counter-journal that swaps all debits and credits.
    The original journal is marked as 'reversed'.
    """
    try:
        result = await journal_service.reverse_journal(
            UUID(request.entity_id), UUID(journal_id)
        )
        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error reversing journal: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# PURCHASE & EXPENSE JOURNALS
# =============================================================================


@router.post("/journals/purchase-invoice")
async def create_purchase_invoice_journal(request: PurchaseInvoiceRequest):
    """Create a COGS journal from a supplier invoice.

    Purchase journal:
    - DEBIT  5000 Product Purchase Cost  = invoice total
    - CREDIT 2000 Accounts Payable       = invoice total

    If create_payment=true and invoice status is 'paid', also creates:
    - DEBIT  2000 Accounts Payable  = invoice total
    - CREDIT 1000 Cash (Revolut)    = invoice total
    """
    try:
        purchase = await journal_service.create_purchase_journal(
            UUID(request.entity_id), UUID(request.invoice_id)
        )
        result = {"purchase_journal": purchase, "payment_journal": None}

        if request.create_payment:
            try:
                payment = await journal_service.create_invoice_payment_journal(
                    UUID(request.entity_id), UUID(request.invoice_id)
                )
                result["payment_journal"] = payment
            except JournalError as e:
                # Payment journal may fail if invoice is not yet paid
                result["payment_note"] = str(e)

        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating purchase journal: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/journals/expense")
async def create_expense_journals(request: ExpenseJournalRequest):
    """Batch-create expense journals for bank transactions.

    Each expense journal:
    - DEBIT  6xxx Expense account (from account_code)  = amount
    - CREDIT 1000/1100 Cash                            = amount

    If transaction_ids omitted, finds all un-journaled expense/fee transactions.
    """
    try:
        txn_ids = (
            [UUID(tid) for tid in request.transaction_ids]
            if request.transaction_ids
            else None
        )
        result = await journal_service.auto_journal_expenses(
            UUID(request.entity_id), txn_ids
        )
        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating expense journals: {e}")
        raise HTTPException(status_code=500, detail=str(e))
