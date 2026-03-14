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

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

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
    status: str = Field(
        ...,
        description="New status: DRAFT, OPEN, PAID, PARTIALLY_PAID, OVERDUE, CANCELLED, VOID",
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
        description=(
            "Which journals to create: 'payments', 'transactions', 'invoices', or omit for all"
        ),
    )


class CleanPayPalRequest(BaseModel):
    entity_id: str


class ReconcileInvoicesRequest(BaseModel):
    entity_id: str


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


@router.post("/journals/generate-all")
async def generate_all_journals(request: GenerateAllJournalsRequest):
    """Run the journal generation pipeline.

    Executes journal-generating steps in dependency order. Always runs
    cross-provider duplicate detection and invoice matching first, then
    creates journals based on the ``scope`` parameter:

    - ``payments`` — accrual journals from captured payments
    - ``transactions`` — settlement + expense journals from financial transactions
    - ``invoices`` — purchase / sale / payment journals from invoices
    - omit or ``all`` — run every scope

    Each step is independent-on-failure: if one step errors, the pipeline
    continues with the remaining steps.
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
    """Update invoice status (e.g. DRAFT → OPEN → PAID)."""
    valid = {"DRAFT", "OPEN", "PAID", "PARTIALLY_PAID", "OVERDUE", "CANCELLED", "VOID"}
    if request.status not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of {valid}")
    try:
        updated = await invoice_service.update_invoice_status(
            UUID(invoice_id), request.status
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Invoice not found")
        return updated
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

