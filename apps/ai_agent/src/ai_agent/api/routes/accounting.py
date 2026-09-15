"""API routes for accounting operations.

Provides endpoints for:
- Chart of accounts management
- Cross-provider duplicate detection
- Invoice matching
- Journal creation (accrual + settlement + expense + purchase + sale)
- Journal listing and reversal
- Invoice ingestion (AI extraction → contacts → invoices → journals)
- Contacts management
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from ...normalization.utils import extract_rows
from ...services.reconciliation_service import reconciliation_service
from ...services.journal_service import journal_service, JournalError
from ...services.invoice_service import invoice_service
from ...services.paypal_cleaning_service import paypal_cleaning_service

logger = logging.getLogger(__name__)

router = APIRouter()


# =============================================================================
# REQUEST/RESPONSE SCHEMAS
# =============================================================================


class SeedChartRequest(BaseModel):
    entity_id: str = Field(..., description="Entity ID to seed accounts for")


class AccrueRequest(BaseModel):
    entity_id: str
    payment_ids: Optional[List[str]] = Field(
        None, description="Specific payment IDs. If omitted, finds all un-accrued captured payments."
    )


class ReverseJournalRequest(BaseModel):
    entity_id: str


class DetectDuplicatesRequest(BaseModel):
    entity_id: str
    auto_journal: bool = Field(
        False,
        description="If true, auto-create payment journals for invoices matched to PAID status",
    )


class PurchaseInvoiceRequest(BaseModel):
    entity_id: str
    invoice_id: str = Field(..., description="PURCHASE invoice UUID to create COGS journal for")
    create_payment: bool = Field(
        False,
        description="If true and invoice status is 'PAID', also create a payment journal",
    )


class SaleInvoiceRequest(BaseModel):
    entity_id: str
    invoice_id: str = Field(..., description="SALE invoice UUID to create AR journal for")


class InvoicePaymentRequest(BaseModel):
    entity_id: str
    invoice_id: str = Field(
        ...,
        description="Invoice UUID to settle. Invoice status must already be PAID.",
    )


class UpsertContactRequest(BaseModel):
    entity_id: str
    name: str
    contact_type: str = Field(..., description="'supplier', 'customer', or 'both'")
    company_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line_1: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    tax_number: Optional[str] = None


class UpdateInvoiceStatusRequest(BaseModel):
    entity_id: str = Field(
        ...,
        description="Entity the invoice belongs to — resolves its chart of accounts",
    )
    status: str = Field(
        ...,
        description="New status: DRAFT, OPEN, PAID, PARTIALLY_PAID, OVERDUE, CANCELLED, VOID",
    )
    allow_prior_period: bool = Field(
        False,
        description=(
            "Permit finalising an invoice dated before the accounting cutoff. "
            "Posts a prior-year journal and moves the restated opening balance."
        ),
    )


class ExpenseJournalRequest(BaseModel):
    entity_id: str
    transaction_ids: Optional[List[str]] = Field(
        None,
        description="Specific financial transaction IDs. If omitted, finds all un-journaled expense/fee transactions.",
    )


class GenerateAllJournalsRequest(BaseModel):
    entity_id: str = Field(..., description="Entity ID to generate journals for")
    scope: Optional[str] = Field(
        None,
        description="Which journals to create: 'payments', 'transactions', or omit for all",
    )


class CleanPayPalRequest(BaseModel):
    entity_id: str


class ReconcileInvoicesRequest(BaseModel):
    entity_id: str


# =============================================================================
# INVENTORY DISPOSAL (gifts and write-offs)
# =============================================================================


class RecordDisposalRequest(BaseModel):
    entity_id: str = Field(..., description="Entity the inventory item belongs to")
    inventory_item_id: str = Field(..., description="Inventory item being disposed of")
    disposal_type: str = Field(..., description="'GIFT' or 'WRITE_OFF'")
    quantity: float = Field(..., gt=0, description="Units to dispose of, always positive")


@router.post("/inventory/disposal")
async def record_inventory_disposal(request: RecordDisposalRequest):
    """Record a gift or write-off: one dated movement plus its journal.

    Each call adds a new, independently dated disposal — it does not set a
    running total. Call it once per gifting/write-off event.

        GIFT:      DEBIT 6011 Social Media & Influencer / CREDIT inventory
        WRITE_OFF: DEBIT 5070 COGS — Inventory Write-Downs / CREDIT inventory

    The journal is skipped (movement recorded, no ledger entry) for items with
    no cost, or when the resulting date falls before the restated-period
    cutoff.
    """
    if request.disposal_type not in ("GIFT", "WRITE_OFF"):
        raise HTTPException(
            status_code=400, detail="disposal_type must be GIFT or WRITE_OFF"
        )
    try:
        return await journal_service.record_inventory_disposal(
            entity_id=UUID(request.entity_id),
            inventory_item_id=UUID(request.inventory_item_id),
            disposal_type=request.disposal_type,
            quantity=request.quantity,
        )
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error recording inventory disposal: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
# LEDGER HEALTH
# =============================================================================


@router.get("/health-checks")
async def get_accounting_health_checks(include_detail: bool = False):
    """Assertions about ledger and inventory integrity.

    Each check returns a severity:
    - ``fail``  the books are wrong, or an automated process has stopped working
    - ``warn``  a known, accepted gap worth watching
    - ``ok``    clean

    Checks cover: inventory GL vs subledger, journal balancing, sales that left
    stock with no cost recorded, negative stock, untranslated foreign-currency
    lines, and movements dated by fallback rather than from a source document.

    Pass ``include_detail=true`` to also get the offending rows for the two
    checks that have them (uncosted sales and negative stock).
    """
    try:
        client = journal_service.client

        checks = await asyncio.to_thread(
            lambda: client.table("accounting_health_checks").select("*").execute()
        )
        rows = extract_rows(checks)

        severity_rank = {"fail": 0, "warn": 1, "ok": 2}
        rows.sort(
            key=lambda r: (severity_rank.get(r.get("severity"), 3), r.get("check_name"))
        )

        result: Dict[str, Any] = {
            "status": (
                "fail" if any(r.get("severity") == "fail" for r in rows)
                else "warn" if any(r.get("severity") == "warn" for r in rows)
                else "ok"
            ),
            "checks": rows,
        }

        if include_detail:
            uncosted = await asyncio.to_thread(
                lambda: client.table("inventory_uncosted_sales")
                .select("*").order("order_date", desc=True).limit(200).execute()
            )
            negative = await asyncio.to_thread(
                lambda: client.table("inventory_negative_stock").select("*").execute()
            )
            result["uncosted_sales"] = extract_rows(uncosted)
            result["negative_stock"] = extract_rows(negative)

        return result
    except Exception as e:
        logger.error(f"Error fetching accounting health checks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# PAYPAL CLEANING
# =============================================================================


@router.post("/clean-paypal")
async def clean_paypal_transactions(request: CleanPayPalRequest):
    """Run the PayPal transaction cleaning pipeline.

    Groups PayPal transactions, classifies noise vs real economic events,
    excludes internal/conversion noise, calculates FX rates, and matches
    to Revolut transactions. Should be run before journal creation.
    """
    try:
        result = await paypal_cleaning_service.clean_paypal_transactions(
            UUID(request.entity_id)
        )
        return result
    except Exception as e:
        logger.error(f"Error cleaning PayPal transactions: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# CROSS-PROVIDER DETECTION & INVOICE MATCHING
# =============================================================================


@router.post("/reconcile-invoices")
async def reconcile_invoices(request: ReconcileInvoicesRequest):
    """Auto-match open invoices to financial transactions."""
    try:
        result = await reconciliation_service.reconcile_invoice_payments(
            UUID(request.entity_id)
        )
        return result
    except Exception as e:
        logger.error(f"Error reconciling invoices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/detect-duplicates")
async def detect_duplicates(request: DetectDuplicatesRequest):
    """Detect cross-provider duplicate transactions, enrich, and match invoices.

    Finds transactions that appear in both Revolut and PayPal, enriches
    the Revolut transaction with PayPal details (invoice_id, cart, payer,
    shipping), and auto-updates matching invoice statuses.

    If auto_journal=true, also creates payment journals for invoices
    that are matched to PAID status.
    """
    try:
        result = await reconciliation_service.detect_cross_provider_duplicates(
            UUID(request.entity_id)
        )

        # Auto-create payment journals for newly PAID invoices
        if request.auto_journal and result.get("invoice_updates"):
            journals_created = 0
            journal_errors = []
            for inv in result["invoice_updates"]:
                if inv["new_status"] == "PAID":
                    try:
                        await journal_service.create_invoice_payment_journal(
                            UUID(request.entity_id), UUID(inv["invoice_id"])
                        )
                        journals_created += 1
                    except (JournalError, Exception) as e:
                        journal_errors.append({
                            "invoice_id": inv["invoice_id"],
                            "error": str(e),
                        })
            result["journals_created"] = journals_created
            if journal_errors:
                result["journal_errors"] = journal_errors

        return result
    except Exception as e:
        logger.error(f"Error detecting duplicates: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# JOURNALS
# =============================================================================


@router.post("/journals/accrue")
async def accrue_payments(request: AccrueRequest):
    """Generate accrual journals for captured payments.

    Each accrual journal:
    - DEBIT  Payment Gateway Clearing (1012) = net_amount
    - DEBIT  Bank Charges (8020)             = fee_amount
    - CREDIT Revenue (4020)                  = subtotal - discounts
    - CREDIT Revenue (4020)                  = shipping_total
    - CREDIT Tax Payable (2030)              = tax_total
    """
    try:
        payment_ids = [UUID(pid) for pid in request.payment_ids] if request.payment_ids else None
        result = await journal_service.auto_journal_payments(UUID(request.entity_id), payment_ids)
        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating accrual journals: {e}")
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


@router.get("/journals/review-summary")
async def get_review_summary(entity_id: str):
    """Return items needing human review after journal generation.

    Returns:
    - ``draft_journals``: Journals marked draft because the automation could
      not confidently categorise the transaction.
    - ``summary``: High-level counts for badge display in the UI.
    """
    try:
        result = await journal_service.get_review_summary(UUID(entity_id))
        return result
    except Exception as e:
        logger.error(f"Error getting review summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/journals/{journal_id}/reverse")
async def reverse_journal(journal_id: str, request: ReverseJournalRequest):
    """Reverse a posted journal.

    Marks the journal 'reversed', which removes it from all balances (every
    balance consumer filters on status = 'posted'). No counter-journal is
    created — posting one as well would remove the amount twice.

    Journals inside a locked accounting period cannot be reversed and return a
    409 — those figures have been restated and reported.
    """
    try:
        result = await journal_service.reverse_journal(
            UUID(request.entity_id), UUID(journal_id)
        )
        return result
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # The period-lock trigger raises from Postgres, so it arrives here as a
        # generic error. It is a refusal, not a fault — surface it as 409 with
        # the trigger's own explanation rather than an opaque 500.
        if "Accounting period is locked" in str(e):
            raise HTTPException(status_code=409, detail=str(e))
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


@router.post("/journals/generate-all")
async def generate_all_journals(request: GenerateAllJournalsRequest):
    """Run the journal generation pipeline.

    Creates journals based on the ``scope`` parameter:

    - ``payments`` — accrual journals from captured payments
    - ``transactions`` — settlement, inbound and expense journals from financial transactions
    - omit or ``all`` — run every scope

    Each step is independent-on-failure: if one step errors, the pipeline
    continues with the remaining steps. Individual records that fail within a
    step (e.g. a locked-period backfill attempt) are reported per-record and
    do not abort the rest of that step.
    """
    try:
        result = await journal_service.generate_all_journals(
            UUID(request.entity_id), scope=request.scope
        )
        return result
    except Exception as e:
        logger.error(f"Error generating journals: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# SALE INVOICE JOURNAL
# =============================================================================


@router.post("/journals/sale-invoice")
async def create_sale_invoice_journal(request: SaleInvoiceRequest):
    """Create an Accounts Receivable journal from a SALE invoice.

    Sale journal:
    - DEBIT  1300 Accounts Receivable  = gross_amount
    - CREDIT 4000 Revenue              = net_amount
    - CREDIT 2100 Tax Payable          = tax_amount
    """
    try:
        journal = await journal_service.create_sale_journal(
            UUID(request.entity_id), UUID(request.invoice_id)
        )
        return {"sale_journal": journal}
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating sale journal: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/journals/invoice-payment")
async def create_invoice_payment(request: InvoicePaymentRequest):
    """Create a payment settlement journal for a paid invoice.

    Called automatically when an invoice status is set to PAID.

    PURCHASE invoice (we paid a supplier):
    - DEBIT  2000 Accounts Payable    = gross total
    - CREDIT 1000 Cash                = gross total

    SALE invoice (customer paid us):
    - DEBIT  1000 Cash                = gross total
    - CREDIT 1300 Accounts Receivable = gross total
    """
    try:
        journal = await journal_service.create_invoice_payment_journal(
            UUID(request.entity_id), UUID(request.invoice_id)
        )
        return {"payment_journal": journal}
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating invoice payment journal: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# INVOICE INGESTION (AI EXTRACTION PIPELINE)
# =============================================================================


@router.post("/invoices/process")
async def process_invoice(
    entity_id: str = Form(...),
    file: UploadFile = File(...),
    file_path: str = Form(""),
    create_journal: bool = Form(True),
    invoice_type: Optional[str] = Form(None),
):
    """Process an uploaded invoice document end-to-end.

    Steps executed:
    1. Fetch entity context + chart of accounts
    2. AI extracts structured data with entity context (determines SALE/PURCHASE correctly)
    3. Contact upserted (counterparty only, never our own entity)
    4. Invoice record created (source = AI-detected platform e.g. 'paypal', 'revolut')
    5. Invoice line items created (with GL account resolved from chart of accounts)
    6. Journal posted (purchase or sale depending on invoice_type)

    Returns full result object with invoice, contact, line items, and journal.
    """
    try:
        content = await file.read()
        mime_type = file.content_type or "application/pdf"
        file_name = file.filename or "invoice"

        result = await invoice_service.process_invoice(
            entity_id=UUID(entity_id),
            file_content=content,
            mime_type=mime_type,
            file_name=file_name,
            file_path=file_path,
            create_journal=create_journal,
            invoice_type_override=invoice_type,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Error processing invoice: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/invoices")
async def list_invoices(
    entity_id: str,
    invoice_type: Optional[str] = None,
    status_filter: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """List invoices with embedded contact info."""
    try:
        inv_type = invoice_type  # type: ignore[assignment]
        invoices = await invoice_service.list_invoices(
            UUID(entity_id), inv_type, status_filter, limit, offset
        )
        return {"entity_id": entity_id, "invoices": invoices, "count": len(invoices)}
    except Exception as e:
        logger.error(f"Error listing invoices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: str):
    """Get a single invoice with contact and line items."""
    try:
        invoice = await invoice_service.get_invoice(UUID(invoice_id))
        if not invoice:
            raise HTTPException(status_code=404, detail="Invoice not found")
        return invoice
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching invoice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/invoices/{invoice_id}/status")
async def update_invoice_status(invoice_id: str, request: UpdateInvoiceStatusRequest):
    """Move an invoice through its lifecycle, posting the journals it implies.

    DRAFT → OPEN finalises a purchase invoice:
    - DEBIT  each line item's own GL account (stock → 1033/1034/1035,
             freight and fees → their expense accounts)
    - CREDIT 2010 Accounts Payable = invoice gross

    → PAID additionally clears the payable:
    - DEBIT  2010 Accounts Payable
    - CREDIT the cash account the payment came from

    Both journals are idempotent, so repeating a transition will not double-post.
    If the purchase journal fails the status does not move.

    Invoices dated before the accounting cutoff are refused with a 400 — their
    journal would be dated in a restated period. CANCELLED and VOID post nothing
    and are always allowed.
    """
    valid = {"DRAFT", "OPEN", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED", "VOID"}
    if request.status not in valid:
        raise HTTPException(
            status_code=400, detail=f"Invalid status. Must be one of {valid}"
        )
    try:
        return await invoice_service.set_invoice_status(
            UUID(request.entity_id),
            UUID(invoice_id),
            request.status,
            allow_prior_period=request.allow_prior_period,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except JournalError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating invoice status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/invoices/{invoice_id}")
async def delete_invoice(invoice_id: str):
    """Delete an invoice and its line items."""
    try:
        await invoice_service.delete_invoice(UUID(invoice_id))
        return {"success": True, "invoice_id": invoice_id}
    except Exception as e:
        logger.error(f"Error deleting invoice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# INVOICE UPDATE (EDITABLE FIELDS)
# =============================================================================


class UpdateInvoiceRequest(BaseModel):
    invoice_type: Optional[str] = Field(None, description="SALE or PURCHASE")
    notes: Optional[str] = Field(None, description="Invoice notes")
    line_item_gl_accounts: Optional[Dict[str, Optional[str]]] = Field(
        None,
        description="Map of line_item_id → gl_account_id (or null to clear)",
    )


@router.patch("/invoices/{invoice_id}")
async def update_invoice(invoice_id: str, request: UpdateInvoiceRequest):
    """Update editable invoice fields (type, notes) and line item GL accounts.

    Financial amounts are immutable through this endpoint.
    """
    valid_types = {"SALE", "PURCHASE"}
    if request.invoice_type and request.invoice_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"invoice_type must be one of {valid_types}",
        )
    try:
        updates: Dict[str, Any] = {}
        if request.invoice_type is not None:
            updates["invoice_type"] = request.invoice_type
        if request.notes is not None:
            updates["notes"] = request.notes

        result = await invoice_service.update_invoice(
            UUID(invoice_id),
            updates,
            line_item_gl_updates=request.line_item_gl_accounts,
        )
        if not result:
            raise HTTPException(status_code=404, detail="Invoice not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating invoice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# PRODUCT CREATION FROM INVOICE LINE ITEMS
# =============================================================================


class CreateProductsFromInvoiceRequest(BaseModel):
    entity_id: str = Field(..., description="Entity ID")
    line_item_ids: List[str] = Field(
        ..., description="IDs of invoice_line_items to create as products"
    )
    overrides: Optional[Dict[str, Dict[str, str]]] = Field(
        None,
        description=(
            "Optional per-line-item name/sku overrides keyed by line_item_id. "
            "e.g. {\"<uuid>\": {\"name\": \"Red Cap\", \"sku\": \"CAP-RED\"}}"
        ),
    )


@router.post("/invoices/{invoice_id}/products")
async def create_products_from_invoice(
    invoice_id: str, request: CreateProductsFromInvoiceRequest
):
    """Create product catalog entries from selected invoice line items.

    Products are created with provider='invoice' and can later be enriched
    when synced with an e-commerce platform (e.g. Squarespace).
    """
    if not request.line_item_ids:
        raise HTTPException(status_code=400, detail="No line items selected")
    try:
        products = await invoice_service.create_products_from_line_items(
            entity_id=UUID(request.entity_id),
            invoice_id=UUID(invoice_id),
            line_item_ids=request.line_item_ids,
            overrides=request.overrides,
        )
        return {
            "success": True,
            "invoice_id": invoice_id,
            "products": products,
            "count": len(products),
        }
    except Exception as e:
        logger.error(f"Error creating products from invoice: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# LINK INVOICE LINE ITEMS TO EXISTING PRODUCTS (BACKFILL UNIT COSTS)
# =============================================================================


class LinkLineItemsToProductsRequest(BaseModel):
    entity_id: str = Field(..., description="Entity ID")
    links: List[Dict[str, str]] = Field(
        ...,
        description="List of {line_item_id, product_id} pairs to link",
    )


@router.post("/invoices/{invoice_id}/link-to-products")
async def link_line_items_to_products(
    invoice_id: str, request: LinkLineItemsToProductsRequest
):
    """Backfill unit costs on existing products from invoice line items.

    Matches each line item to an existing product and updates the unit_cost
    on all inventory_items for that product. Use this when the product catalog
    already exists (e.g. synced from Squarespace) and costs are sourced from
    purchase invoices.
    """
    if not request.links:
        raise HTTPException(status_code=400, detail="No links provided")
    try:
        result = await invoice_service.link_line_items_to_existing_products(
            entity_id=UUID(request.entity_id),
            invoice_id=UUID(invoice_id),
            links=request.links,
        )
        return {
            "success": True,
            "invoice_id": invoice_id,
            **result,
        }
    except Exception as e:
        logger.error(f"Error linking line items to products: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# INVENTORY MOVEMENTS ONLY (skip expenses that still need stock tracking)
# =============================================================================


class CreateInventoryMovementsRequest(BaseModel):
    entity_id: str = Field(..., description="Entity ID")
    line_item_ids: List[str] = Field(
        ..., description="IDs of invoice_line_items to record stock movements for"
    )
    overrides: Optional[Dict[str, Dict[str, str]]] = Field(
        None,
        description=(
            "Optional per-line-item overrides keyed by line_item_id. "
            "Accepted keys: sku, asset_account_id, cogs_account_id"
        ),
    )


@router.post("/invoices/{invoice_id}/inventory-movements")
async def create_inventory_movements(
    invoice_id: str, request: CreateInventoryMovementsRequest
):
    """Create inventory items and PURCHASE movements without a product catalog entry.

    Used when the user skips a line item as an expense but still wants the
    physical stock movement tracked (e.g. raw materials, consumables).
    """
    if not request.line_item_ids:
        raise HTTPException(status_code=400, detail="No line items provided")
    try:
        result = await invoice_service.create_inventory_movements_only(
            entity_id=UUID(request.entity_id),
            invoice_id=UUID(invoice_id),
            line_item_ids=request.line_item_ids,
            overrides=request.overrides,
        )
        return {
            "success": True,
            "invoice_id": invoice_id,
            **result,
        }
    except Exception as e:
        logger.error(f"Error creating inventory movements: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# CONTACTS
# =============================================================================


@router.get("/contacts")
async def list_contacts(entity_id: str, contact_type: Optional[str] = None):
    """List all contacts (suppliers and/or customers) for an entity."""
    try:
        contacts = await invoice_service.list_contacts(UUID(entity_id), contact_type)
        return {"entity_id": entity_id, "contacts": contacts, "count": len(contacts)}
    except Exception as e:
        logger.error(f"Error listing contacts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/contacts")
async def upsert_contact(request: UpsertContactRequest):
    """Create or update a contact (supplier / customer)."""
    from ...services.invoice_service import ExtractedContact

    valid_types = {"supplier", "customer", "both"}
    if request.contact_type not in valid_types:
        raise HTTPException(
            status_code=400, detail=f"contact_type must be one of {valid_types}"
        )
    try:
        contact_info = ExtractedContact(
            name=request.name,
            company_name=request.company_name,
            email=request.email,
            phone=request.phone,
            address_line_1=request.address_line_1,
            city=request.city,
            country=request.country,
            tax_number=request.tax_number,
        )
        contact = await invoice_service.upsert_contact(
            UUID(request.entity_id),
            contact_info,
            request.contact_type,  # type: ignore[arg-type]
        )
        return contact
    except Exception as e:
        logger.error(f"Error upserting contact: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# FINANCIAL TRANSACTIONS
# =============================================================================


class UpdateTransactionRequest(BaseModel):
    description: Optional[str] = None
    counterparty_name: Optional[str] = None
    account_code: Optional[str] = Field(None, description="Chart of accounts number e.g. '6020'")
    expense_category: Optional[str] = None
    excluded_reason: Optional[str] = Field(
        None,
        description="Set to a non-empty string to exclude; set to '' or null to un-exclude",
    )
    re_journal: bool = Field(
        True,
        description="If true and account_code changed, reverse existing journal and recreate",
    )


import asyncio as _asyncio


@router.get("/transactions")
async def list_transactions(
    entity_id: str,
    search: Optional[str] = None,
    source: Optional[str] = None,
    direction: Optional[str] = None,
    transaction_type: Optional[str] = None,
    txn_status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
):
    """Search and list financial transactions with pagination.

    Supports filtering by source (revolut/paypal), direction (in/out),
    transaction_type, status (active/excluded), and date range.
    Full-text search against description and counterparty_name.
    """
    from ...core.supabase_client import get_supabase_client

    client = get_supabase_client()
    offset = (page - 1) * page_size

    def _query():
        q = (
            client.table("financial_transactions")
            .select(
                "id, entity_id, source, external_transaction_id, amount, currency_code, "
                "direction, transaction_type, occurred_at, description, counterparty_name, "
                "status, excluded_reason, journalised_at, metadata",
                count="exact",
            )
            .eq("entity_id", entity_id)
        )

        if source:
            q = q.eq("source", source)
        if direction:
            q = q.eq("direction", direction)
        if transaction_type:
            q = q.eq("transaction_type", transaction_type)
        if txn_status == "excluded":
            q = q.not_.is_("excluded_reason", "null")
        elif txn_status == "active":
            q = q.is_("excluded_reason", "null")
        if date_from:
            q = q.gte("occurred_at", date_from)
        if date_to:
            q = q.lte("occurred_at", date_to)
        if search:
            # Supabase ilike OR — we chain two separate filters via .or_()
            q = q.or_(
                f"description.ilike.%{search}%,counterparty_name.ilike.%{search}%"
            )

        return (
            q.order("occurred_at", desc=True)
            .range(offset, offset + page_size - 1)
            .execute()
        )

    try:
        result = await _asyncio.to_thread(_query)
        rows = result.data or []
        total_count = result.count or 0
        return {
            "entity_id": entity_id,
            "transactions": rows,
            "total_count": total_count,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, -(-total_count // page_size)),
        }
    except Exception as e:
        logger.error(f"Error listing transactions: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/transactions/{transaction_id}")
async def get_transaction(transaction_id: str, entity_id: str):
    """Get a single financial transaction with its associated journal and line items.

    Returns the transaction record, the latest associated journal (sourced
    against this transaction), and all journal line items enriched with
    account names from chart_of_accounts.
    """
    from ...core.supabase_client import get_supabase_client

    client = get_supabase_client()

    def _fetch_txn():
        return (
            client.table("financial_transactions")
            .select("*")
            .eq("id", transaction_id)
            .eq("entity_id", entity_id)
            .execute()
        )

    def _fetch_journal():
        return (
            client.table("journals")
            .select("*")
            .eq("entity_id", entity_id)
            .eq("source_type", "financial_transaction")
            .eq("source_id", transaction_id)
            .neq("status", "reversed")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )

    try:
        txn_result = await _asyncio.to_thread(_fetch_txn)
        txn_rows = txn_result.data or []
        if not txn_rows:
            raise HTTPException(status_code=404, detail="Transaction not found")
        txn = txn_rows[0]

        journal_result = await _asyncio.to_thread(_fetch_journal)
        journal_rows = journal_result.data or []
        journal = journal_rows[0] if journal_rows else None

        line_items: List[Dict[str, Any]] = []
        if journal:
            def _fetch_line_items():
                return (
                    client.table("journal_line_items")
                    .select(
                        "id, journal_id, account_id, debit, credit, currency, "
                        "description, effective_date, "
                        "chart_of_accounts!account_id(account_number, name, account_type)"
                    )
                    .eq("journal_id", journal["id"])
                    .execute()
                )

            li_result = await _asyncio.to_thread(_fetch_line_items)
            raw_items = li_result.data or []
            # Flatten nested account join
            for item in raw_items:
                acct = item.pop("chart_of_accounts", None) or {}
                item["account_number"] = acct.get("account_number")
                item["account_name"] = acct.get("name")
                item["account_type"] = acct.get("account_type")
                line_items.append(item)

            journal["line_items"] = line_items

        return {"transaction": txn, "journal": journal}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching transaction {transaction_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/transactions/{transaction_id}")
async def update_transaction(transaction_id: str, request: UpdateTransactionRequest, entity_id: str):
    """Update a financial transaction and optionally re-journal.

    Editable fields: description, counterparty_name, metadata.account_code,
    metadata.expense_category, excluded_reason.

    Re-journaling logic (when re_journal=true):
    - If account_code changes: reverse existing expense journal, recreate.
    - If excluded_reason is set (non-empty): reverse existing journal if present.
    - If excluded_reason is cleared (''/null): offer to recreate journal
      (returns re_journal_needed=true in response for the UI to handle).
    """
    from ...core.supabase_client import get_supabase_client
    import datetime

    client = get_supabase_client()

    def _fetch_txn():
        return (
            client.table("financial_transactions")
            .select("*")
            .eq("id", transaction_id)
            .eq("entity_id", entity_id)
            .execute()
        )

    try:
        txn_result = await _asyncio.to_thread(_fetch_txn)
        txn_rows = txn_result.data or []
        if not txn_rows:
            raise HTTPException(status_code=404, detail="Transaction not found")
        txn = txn_rows[0]

        # Build update payload
        updates: Dict[str, Any] = {
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        if request.description is not None:
            updates["description"] = request.description
        if request.counterparty_name is not None:
            updates["counterparty_name"] = request.counterparty_name
        if request.excluded_reason is not None:
            # Empty string means un-exclude
            updates["excluded_reason"] = request.excluded_reason if request.excluded_reason else None

        # Merge metadata changes
        old_meta = txn.get("metadata") or {}
        new_meta = dict(old_meta)
        meta_changed = False
        old_account_code = old_meta.get("account_code")

        if request.account_code is not None:
            new_meta["account_code"] = request.account_code
            meta_changed = True
        if request.expense_category is not None:
            new_meta["expense_category"] = request.expense_category
            meta_changed = True
        if meta_changed:
            updates["metadata"] = new_meta

        def _update_txn():
            return (
                client.table("financial_transactions")
                .update(updates)
                .eq("id", transaction_id)
                .eq("entity_id", entity_id)
                .execute()
            )

        await _asyncio.to_thread(_update_txn)

        # Determine re-journaling action
        journal_action = "none"
        new_journal = None
        re_journal_needed = False

        # Find existing active journal for this transaction
        def _find_journal():
            return (
                client.table("journals")
                .select("id, journal_type, status")
                .eq("entity_id", entity_id)
                .eq("source_type", "financial_transaction")
                .eq("source_id", transaction_id)
                .neq("status", "reversed")
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )

        journal_result = await _asyncio.to_thread(_find_journal)
        existing_journal = (journal_result.data or [None])[0]

        being_excluded = (
            request.excluded_reason is not None and request.excluded_reason != ""
        )
        being_unexcluded = (
            request.excluded_reason is not None and request.excluded_reason == ""
        )
        account_code_changed = (
            request.account_code is not None
            and request.account_code != old_account_code
        )

        if request.re_journal and existing_journal:
            if being_excluded:
                # Reverse the journal since transaction is now excluded
                try:
                    await journal_service.reverse_journal(
                        UUID(entity_id), UUID(existing_journal["id"])
                    )
                    journal_action = "reversed"
                except (JournalError, Exception) as e:
                    logger.warning("Could not reverse journal %s: %s", existing_journal["id"], e)
            elif account_code_changed:
                # Reverse and recreate with new account
                try:
                    await journal_service.reverse_journal(
                        UUID(entity_id), UUID(existing_journal["id"])
                    )
                    journal_action = "reversed_and_recreated"
                    # Recreate expense journal for the updated transaction
                    try:
                        new_journal = await journal_service.create_expense_journal(
                            UUID(entity_id), UUID(transaction_id)
                        )
                    except (JournalError, Exception) as je:
                        logger.warning("Could not recreate journal: %s", je)
                        journal_action = "reversed_only"
                except (JournalError, Exception) as e:
                    logger.warning("Could not reverse journal %s: %s", existing_journal["id"], e)

        elif being_unexcluded and not existing_journal:
            re_journal_needed = True

        # Fetch updated transaction
        updated_result = await _asyncio.to_thread(_fetch_txn)
        updated_txn = (updated_result.data or [txn])[0]

        return {
            "transaction": updated_txn,
            "journal_action": journal_action,
            "new_journal": new_journal,
            "re_journal_needed": re_journal_needed,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating transaction {transaction_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

