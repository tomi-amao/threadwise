"""Invoice processing service for ThreadWise.

Handles the full invoice ingestion pipeline:
1. AI extraction from uploaded document (PDF/image) via structured output
2. Contact upsert (supplier or customer)
3. Invoice record creation
4. Invoice line items creation
5. Journal generation via journal rule engine
"""

import asyncio
import base64
import logging
import re
from datetime import timezone
from decimal import Decimal
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

from ..core.config import Settings
from ..core.supabase_client import get_supabase_client
from ..normalization.persistence import persistence_service
from ..normalization.utils import extract_id as _extract_id, extract_row, extract_rows
from .journal_service import journal_service, JournalError

logger = logging.getLogger(__name__)

settings = Settings()


# =============================================================================
# PYDANTIC MODELS FOR AI STRUCTURED OUTPUT
# =============================================================================


class ExtractedContact(BaseModel):
    """Contact (counterparty) extracted from invoice."""

    name: str = Field(..., description="Full name or organisation name of the counterparty")
    company_name: Optional[str] = Field(None, description="Trading / company name if different from name")
    email: Optional[str] = Field(None, description="Contact email address")
    phone: Optional[str] = Field(None, description="Contact phone number")
    address_line_1: Optional[str] = Field(None, description="First line of address")
    address_line_2: Optional[str] = Field(None, description="Second line of address")
    city: Optional[str] = Field(None, description="City or town")
    region: Optional[str] = Field(None, description="State, county, or region")
    postal_code: Optional[str] = Field(None, description="Postal / ZIP code")
    country: Optional[str] = Field(None, description="Country name or ISO code")
    tax_number: Optional[str] = Field(None, description="VAT / GST / tax registration number")


class ExtractedLineItem(BaseModel):
    """A single line item from the invoice."""

    description: str = Field(..., description="Description of goods or service")
    sku: Optional[str] = Field(None, description="Product SKU, part number, or item code if visible on the invoice")
    quantity: Optional[float] = Field(None, description="Quantity of units")
    unit_cost: Optional[float] = Field(None, description="Cost per unit (excl. tax)")
    tax_code: Optional[str] = Field(None, description="Tax code or description, e.g. 'VAT20', 'ZERO'")
    vat_rate: Optional[float] = Field(
        None,
        description="VAT / sales tax rate as a percentage (0-100), e.g. 20 for 20%",
    )
    suggested_gl_code: Optional[str] = Field(
        None,
        description=(
            "Account number from the provided chart of accounts that best matches this line item. "
            "Use the exact account_number string (e.g. '5010', '5210'). Leave null if unsure."
        ),
    )
    category: Optional[str] = Field(
        None,
        description=(
            "Inventory/product category for this line item, e.g. 'Headwear', 'Accessories', "
            "'Apparel', 'Footwear', 'Stationery', 'Electronics'. "
            "Use a broad category that fits the industry context. Leave null if unclear."
        ),
    )


class ExtractedInvoice(BaseModel):
    """Structured invoice data extracted by the AI model."""

    invoice_type: Literal["SALE", "PURCHASE"] = Field(
        ...,
        description=(
            "Classify using the entity context provided.\n"
            "SALE = our business issued this invoice TO a customer (money coming IN).\n"
            "PURCHASE = our business received this invoice FROM a supplier (money going OUT).\n"
            "Key rule: if our entity name appears as the BILL-TO / SOLD-TO party, it is a PURCHASE. "
            "If our entity name appears as the BILL-FROM / ISSUED-BY party, it is a SALE."
        ),
    )
    payment_source: Optional[str] = Field(
        None,
        description=(
            "Payment platform or origin detected from the document branding, headers, or footer. "
            "Examples: 'paypal', 'revolut', 'stripe', 'square', 'shopify', 'xero', 'quickbooks'. "
            "Use lowercase. Leave null if no specific platform is identifiable."
        ),
    )
    invoice_number: Optional[str] = Field(None, description="Invoice reference / number")
    invoice_date: Optional[str] = Field(None, description="Invoice issue date in ISO 8601 format (YYYY-MM-DD)")
    due_date: Optional[str] = Field(None, description="Payment due date in ISO 8601 format (YYYY-MM-DD)")
    currency: str = Field("GBP", description="3-letter ISO currency code")
    net_amount: Optional[float] = Field(None, description="Total amount before tax (subtotal)")
    tax_amount: Optional[float] = Field(None, description="Total VAT / tax amount")
    gross_amount: Optional[float] = Field(None, description="Total amount including tax")
    fx_rate: Optional[float] = Field(None, description="Foreign exchange rate to base currency if applicable")
    notes: Optional[str] = Field(None, description="Any payment terms, instructions, or notes from the invoice")
    counterparty: ExtractedContact = Field(
        ...,
        description=(
            "The OTHER party on the invoice — never our own entity.\n"
            "For PURCHASE: the supplier/vendor who sent us the invoice.\n"
            "For SALE: the customer/buyer we invoiced.\n"
            "If our entity name appears on the document, ignore it for contact extraction."
        ),
    )
    line_items: List[ExtractedLineItem] = Field(default_factory=list)
    confidence_score: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description="Extraction confidence between 0 and 1",
    )


# =============================================================================
# INVOICE SERVICE
# =============================================================================


class InvoiceService:
    """Orchestrates invoice ingestion: AI extraction → DB persistence → journals."""

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
    # AI EXTRACTION
    # =========================================================================

    async def extract_invoice_data(
        self,
        file_content: bytes,
        mime_type: str,
        file_name: str = "invoice",
        entity_name: str = "our business",
        entity_details: Optional[Dict[str, Any]] = None,
        chart_of_accounts: Optional[List[Dict[str, Any]]] = None,
        invoice_type_hint: Optional[str] = None,
    ) -> ExtractedInvoice:
        """Use LLM with structured output to extract invoice data from a document.

        Args:
            file_content: Raw file bytes (PDF or image)
            mime_type: MIME type (application/pdf or image/*)
            file_name: Original file name for context
            entity_name: Our business name — used to determine SALE vs PURCHASE
            entity_details: Full entity record for richer context
            chart_of_accounts: CoA list so AI can suggest GL codes per line item
            invoice_type_hint: User-supplied invoice type ('SALE' or 'PURCHASE').
                When provided, the CoA is filtered to only show relevant account
                types so the AI picks the correct GL codes.

        Returns:
            Structured ExtractedInvoice Pydantic model

        Raises:
            ValueError: If extraction fails
        """
        model = init_chat_model(settings.default_chat_model)
        structured_model = model.with_structured_output(ExtractedInvoice)

        b64 = base64.b64encode(file_content).decode("utf-8")

        # --- Build entity context block ---
        entity_block = f"Our business name: {entity_name}"
        if entity_details:
            legal = entity_details.get("legal_name") or entity_name
            country = entity_details.get("country") or ""
            industry = entity_details.get("industry") or ""
            currency = entity_details.get("currency") or "GBP"
            if legal != entity_name:
                entity_block += f" (legal name: {legal})"
            if country:
                entity_block += f", Country: {country}"
            if industry:
                entity_block += f", Industry: {industry}"
            entity_block += f", Base currency: {currency}"

        # --- Build Chart of Accounts block (filter by invoice type when known) ---
        coa_block = ""
        if chart_of_accounts:
            # When the user tells us the invoice type, only show relevant accounts
            # so the AI cannot accidentally pick revenue accounts for a PURCHASE.
            if invoice_type_hint == "PURCHASE":
                allowed_types = ("expense", "cogs", "cost_of_goods_sold")
            elif invoice_type_hint == "SALE":
                allowed_types = ("revenue", "income")
            else:
                allowed_types = ("expense", "revenue", "cogs", "income", "cost_of_goods_sold")

            relevant = [
                a for a in chart_of_accounts
                if a.get("account_type") in allowed_types
                and not a.get("is_header", False)
            ]
            if not relevant:
                # Fallback: include all non-header accounts
                relevant = [a for a in chart_of_accounts if not a.get("is_header", False)]
            coa_lines = "\n".join(
                f"  {a['account_number']} — {a['name']} ({a.get('account_type', '')})"
                for a in relevant[:60]  # Cap to avoid token overflow
            )

            type_guidance = ""
            if invoice_type_hint == "PURCHASE":
                type_guidance = (
                    "\nIMPORTANT: This is a PURCHASE invoice. Only use 'expense' or 'cogs' accounts.\n"
                    "- For physical goods intended for resale (inventory/stock), use COGS accounts (5xxx).\n"
                    "- For fees, shipping, services, marketing, giveaways, R&D, and other non-resale items, "
                    "use the most specific expense account (6xxx or 7xxx).\n"
                    "- NEVER assign revenue or income accounts to a PURCHASE invoice line item.\n"
                )
            elif invoice_type_hint == "SALE":
                type_guidance = (
                    "\nIMPORTANT: This is a SALE invoice. Only use 'revenue' or 'income' accounts.\n"
                    "- NEVER assign expense or cogs accounts to a SALE invoice line item.\n"
                )

            coa_block = (
                "\n\nCHART OF ACCOUNTS (use account_number for suggested_gl_code on each line item):\n"
                + coa_lines
                + "\n\nGL ACCOUNT SELECTION RULES:\n"
                "- For PURCHASE invoices: choose accounts with account_type 'expense' or 'cogs' "
                "(these represent costs/expenses incurred by the business).\n"
                "- For SALE invoices: choose accounts with account_type 'revenue' or 'income' "
                "(these represent income earned by the business).\n"
                "- Match the account to the nature of the goods/service described in each line item.\n"
                "- For PURCHASE: physical goods for resale → COGS (5xxx); "
                "fees/services/marketing/giveaways → expense (6xxx/7xxx).\n"
                + type_guidance
            )

        system_text = (
            f"You are an expert accountant processing invoices for a business.\n\n"
            f"ENTITY CONTEXT:\n{entity_block}\n\n"
            "SALE vs PURCHASE RULES:\n"
            f"- If '{entity_name}' (or its legal name) appears as the BILL-TO, SOLD-TO, or SHIP-TO party "
            f"→ this is a PURCHASE (supplier sends us an invoice, money goes OUT).\n"
            f"- If '{entity_name}' appears as the FROM / ISSUED BY / SELLER party "
            f"→ this is a SALE (we send an invoice to a customer, money comes IN).\n"
            "- When in doubt: if we are paying the invoice, it's a PURCHASE.\n\n"
            "CONTACT EXTRACTION RULES:\n"
            f"- The counterparty is ALWAYS the OTHER party, never '{entity_name}' itself.\n"
            "- For PURCHASE: extract the supplier/vendor details (the issuer of the invoice).\n"
            "- For SALE: extract the customer/buyer details (who we billed).\n"
            f"- If you see '{entity_name}' contact details, IGNORE them.\n\n"
            "PAYMENT SOURCE:\n"
            "- Look for platform branding, logos, or keywords in the document header/footer "
            "(e.g. PayPal, Revolut, Stripe, Square, Shopify, Xero). "
            "Extract as lowercase (e.g. 'paypal', 'revolut'). Null if none detected.\n\n"
            "AMOUNTS:\n"
            "- Be precise. Derive missing amounts: if gross and net are present, tax = gross - net.\n"
            "- VAT rate as a percentage (e.g. 20, not 0.20).\n\n"
            f"FILE: {file_name}"
            + coa_block
        )

        # Build multimodal message
        content_parts: List[Dict[str, Any]] = [
            {"type": "text", "text": system_text},
        ]

        if mime_type == "application/pdf":
            content_parts.append(
                {"type": "file", "source_type": "base64", "mime_type": mime_type, "data": b64}
            )
        else:
            content_parts.append(
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}}
            )

        content_parts.append({
            "type": "text",
            "text": (
                "Extract all invoice data following the rules above. "
                "For each line item, set suggested_gl_code to the most appropriate account_number "
                "from the chart of accounts. "
                "Set confidence_score (0-1) based on document readability."
            ),
        })

        try:
            result = await asyncio.to_thread(
                lambda: structured_model.invoke(
                    [{"role": "user", "content": content_parts}]
                )
            )
            return result  # type: ignore[return-value]
        except Exception as exc:
            logger.error(f"AI invoice extraction failed: {exc}")
            raise ValueError(f"AI extraction failed: {exc}") from exc

    # =========================================================================
    # CONTACT UPSERT
    # =========================================================================

    async def upsert_contact(
        self,
        entity_id: UUID,
        extracted: ExtractedContact,
        contact_type: Literal["supplier", "customer", "both"],
    ) -> Dict[str, Any]:
        """Upsert a contact based on extracted data.

        Matches on (entity_id, name, contact_type). If found, update; else insert.

        Returns:
            Contact dict with at minimum { id, name, contact_type }
        """
        contact_data: Dict[str, Any] = {
            "entity_id": str(entity_id),
            "contact_type": contact_type,
            "name": extracted.name,
            "company_name": extracted.company_name,
            "email": extracted.email,
            "phone": extracted.phone,
            "address_line_1": extracted.address_line_1,
            "address_line_2": extracted.address_line_2,
            "city": extracted.city,
            "region": extracted.region,
            "postal_code": extracted.postal_code,
            "country": extracted.country,
            "tax_number": extracted.tax_number,
            "is_active": True,
        }
        # Remove None values to avoid overwriting existing data in update path
        contact_data = {k: v for k, v in contact_data.items() if v is not None}

        # Try to find existing contact by name + entity + type
        existing = await asyncio.to_thread(
            lambda: self.client.table("contacts")
            .select("*")
            .eq("entity_id", str(entity_id))
            .eq("name", extracted.name)
            .eq("contact_type", contact_type)
            .limit(1)
            .execute()
        )

        if existing.data:
            contact_id = existing.data[0]["id"]
            updated = await asyncio.to_thread(
                lambda: self.client.table("contacts")
                .update(contact_data)
                .eq("id", contact_id)
                .execute()
            )
            return updated.data[0] if updated.data else existing.data[0]

        # Insert new contact
        inserted = await asyncio.to_thread(
            lambda: self.client.table("contacts")
            .insert(contact_data)
            .execute()
        )
        if not inserted.data:
            raise ValueError("Failed to create contact")
        return inserted.data[0]

    # =========================================================================
    # INVOICE CREATION
    # =========================================================================

    async def create_invoice(
        self,
        entity_id: UUID,
        extracted: ExtractedInvoice,
        counterparty_id: UUID,
        source: str = "manual",
        file_path: str = "",
    ) -> Dict[str, Any]:
        """Persist an invoice record to the database.

        Args:
            entity_id: Business entity UUID
            extracted: AI-extracted invoice data
            counterparty_id: Contact UUID of counterparty
            source: Upload source label (e.g. "manual", "email")

        Returns:
            Invoice dict (includes file_path for storage reference)
        """
        # Reconcile amounts — all three columns are NOT NULL in the DB.
        # Derive missing values rather than inserting NULL.
        gross = extracted.gross_amount
        net = extracted.net_amount
        tax = extracted.tax_amount

        if gross is not None and net is not None:
            tax = tax if tax is not None else round(gross - net, 2)
        elif gross is not None and tax is not None:
            net = round(gross - tax, 2)
        elif net is not None and tax is not None:
            gross = round(net + tax, 2)
        elif gross is not None:
            # No breakdown available — assume zero-rated
            tax = 0.0
            net = gross
        elif net is not None:
            tax = tax or 0.0
            gross = round(net + tax, 2)
        else:
            # Completely unknown amounts
            gross = 0.0
            net = 0.0
            tax = 0.0

        invoice_data: Dict[str, Any] = {
            "entity_id": str(entity_id),
            "invoice_type": extracted.invoice_type,
            "invoice_number": extracted.invoice_number,
            "invoice_date": extracted.invoice_date,
            "due_date": extracted.due_date,
            "currency": extracted.currency or "GBP",
            "net_amount": net,
            "tax_amount": tax,
            "gross_amount": gross,
            "fx_rate": extracted.fx_rate,
            "counterparty_id": str(counterparty_id),
            "status": "DRAFT",
            "source": source,
            "file_path": file_path or None,
            "notes": extracted.notes,
        }

        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .insert(invoice_data)
            .execute()
        )

        if not result.data:
            raise ValueError("Failed to create invoice")
        return result.data[0]

    # =========================================================================
    # LINE ITEMS CREATION
    # =========================================================================

    async def create_line_items(
        self,
        invoice_id: UUID,
        line_items: List[ExtractedLineItem],
        chart_of_accounts: Optional[List[Dict[str, Any]]] = None,
        invoice_type: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Insert invoice line items, resolving AI-suggested GL codes to account UUIDs.

        Validates that GL codes match the invoice type (e.g. PURCHASE invoices
        should not have revenue accounts).

        Args:
            invoice_id: Invoice UUID
            line_items: Extracted line items (may include suggested_gl_code)
            chart_of_accounts: Pre-fetched CoA used to resolve account_number → UUID
            invoice_type: 'SALE' or 'PURCHASE' — used to validate GL code types

        Returns:
            List of created line item dicts
        """
        if not line_items:
            return []

        # Build lookups: account_number → UUID, and account_number → account_type
        coa_by_code: Dict[str, str] = {}
        coa_type_by_code: Dict[str, str] = {}
        if chart_of_accounts:
            for acct in chart_of_accounts:
                num = acct.get("account_number")
                acct_id = acct.get("id")
                acct_type = acct.get("account_type", "")
                if num and acct_id:
                    coa_by_code[str(num)] = str(acct_id)
                    coa_type_by_code[str(num)] = acct_type

        # Account types that are invalid for each invoice type
        invalid_types_for_purchase = {"revenue", "income"}
        invalid_types_for_sale = {"expense", "cogs", "cost_of_goods_sold"}

        items_data = []
        for item in line_items:
            # Derive a sensible default tax_code (NOT NULL in DB) when AI omits it
            tax_code = item.tax_code
            if not tax_code:
                if item.vat_rate is None or item.vat_rate == 0:
                    tax_code = "ZERO"
                elif item.vat_rate <= 5:
                    tax_code = "T1"  # Reduced rate
                else:
                    tax_code = "STANDARD"

            # Resolve suggested GL code → UUID, with invoice-type validation
            gl_account_id: Optional[str] = None
            if item.suggested_gl_code:
                code = str(item.suggested_gl_code)
                acct_type = coa_type_by_code.get(code, "")

                # Validate: reject revenue accounts on PURCHASE invoices and vice versa
                type_mismatch = False
                if invoice_type == "PURCHASE" and acct_type in invalid_types_for_purchase:
                    logger.warning(
                        f"GL code '{code}' is a {acct_type} account — invalid for PURCHASE invoice. "
                        f"Clearing assignment for line item '{item.description}'."
                    )
                    type_mismatch = True
                elif invoice_type == "SALE" and acct_type in invalid_types_for_sale:
                    logger.warning(
                        f"GL code '{code}' is a {acct_type} account — invalid for SALE invoice. "
                        f"Clearing assignment for line item '{item.description}'."
                    )
                    type_mismatch = True

                if not type_mismatch:
                    gl_account_id = coa_by_code.get(code)
                    if not gl_account_id:
                        logger.debug(
                            f"GL code '{code}' not found in CoA, leaving unassigned"
                        )

            items_data.append({
                "invoice_id": str(invoice_id),
                "description": item.description,
                "sku": item.sku or None,
                "quantity": item.quantity,
                "unit_cost": item.unit_cost,
                "tax_code": tax_code,
                "vat_rate": item.vat_rate or 0.0,
                "gl_account_id": gl_account_id,
            })

        result = await asyncio.to_thread(
            lambda: self.client.table("invoice_line_items")
            .insert(items_data)
            .execute()
        )
        return result.data or []

    # =========================================================================
    # FULL PIPELINE
    # =========================================================================

    async def _fetch_entity(self, entity_id: UUID) -> Optional[Dict[str, Any]]:
        """Fetch entity record from DB."""
        try:
            result = await asyncio.to_thread(
                lambda: self.client.table("entities")
                .select("*")
                .eq("id", str(entity_id))
                .limit(1)
                .execute()
            )
            rows = result.data or []
            return rows[0] if rows else None
        except Exception as exc:
            logger.warning(f"Could not fetch entity {entity_id}: {exc}")
            return None

    async def process_invoice(
        self,
        entity_id: UUID,
        file_content: bytes,
        mime_type: str,
        file_name: str = "invoice",
        file_path: str = "",
        create_journal: bool = True,
        invoice_type_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Full invoice ingestion pipeline.

        Steps:
            0. Fetch entity context + chart of accounts (used to enrich AI prompt)
            1. AI extraction (structured output with entity context + CoA)
            2. Contact upsert (counterparty only, never our own entity)
            3. Invoice creation (source = AI-detected platform or 'manual')
            4. Line item creation (with GL account resolution from CoA)
            5. Journal creation (purchase or sale)

        Args:
            entity_id: Business entity UUID
            file_content: Raw file bytes
            mime_type: MIME type
            file_name: Original filename for context
            file_path: Supabase storage path (e.g. "entity_id/timestamp-name.pdf")
            create_journal: Whether to auto-create the accounting journal

        Returns:
            { invoice, contact, line_items, journal, journal_error, extraction }
        """
        # Step 0: Fetch entity + CoA for AI context
        entity = await self._fetch_entity(entity_id)
        entity_name: str = (
            entity.get("name") or entity.get("legal_name") or "our business"
        ) if entity else "our business"

        try:
            coa = await journal_service.get_chart_of_accounts(entity_id)
        except Exception as exc:
            logger.warning(f"Could not fetch CoA for extraction context: {exc}")
            coa = []

        # Step 1: AI extraction (pass invoice_type_override as hint for GL filtering)
        logger.info(f"Extracting invoice data from {file_name} (entity: {entity_name})")
        extracted = await self.extract_invoice_data(
            file_content,
            mime_type,
            file_name=file_name,
            entity_name=entity_name,
            entity_details=entity,
            chart_of_accounts=coa,
            invoice_type_hint=invoice_type_override,
        )
        logger.info(
            f"Extracted invoice: type={extracted.invoice_type}, number={extracted.invoice_number}, "
            f"source={extracted.payment_source}, confidence={extracted.confidence_score:.2f}"
        )

        # Apply user-supplied invoice type override (takes priority over AI decision)
        if invoice_type_override in ("SALE", "PURCHASE"):
            logger.info(
                f"Overriding AI invoice_type '{extracted.invoice_type}' → '{invoice_type_override}' "
                f"(user-specified)"
            )
            extracted.invoice_type = invoice_type_override  # type: ignore[assignment]

        # Step 2: Upsert contact (always the OTHER party, not our entity)
        contact_type: Literal["supplier", "customer", "both"] = (
            "supplier" if extracted.invoice_type == "PURCHASE" else "customer"
        )
        contact = await self.upsert_contact(entity_id, extracted.counterparty, contact_type)
        logger.info(f"Contact upserted: {contact['id']} ({contact['name']})")

        # Determine source label: prefer AI-detected platform, fall back to 'manual'
        source_label = extracted.payment_source or "manual"

        # Step 3: Create invoice
        invoice = await self.create_invoice(
            entity_id,
            extracted,
            UUID(contact["id"]),
            source=source_label,
            file_path=file_path,
        )
        logger.info(f"Invoice created: {invoice['id']} (source: {source_label})")

        # Step 4: Create line items (pass CoA + type so GL codes can be resolved & validated)
        line_items = await self.create_line_items(
            UUID(invoice["id"]),
            extracted.line_items,
            chart_of_accounts=coa,
            invoice_type=extracted.invoice_type,
        )
        logger.info(f"Created {len(line_items)} line items")

        # NOTE: Inventory movements are NO LONGER created automatically here.
        # They are created only when the user explicitly selects product line items
        # via the Product Selection Modal → create_products_from_line_items().
        # This ensures only items the user identifies as products/inventory get
        # stock records, while non-product items (R&D, marketing, giveaways)
        # remain pure expenses with no inventory footprint.

        # Step 5: Create journal
        journal = None
        journal_error = None
        if create_journal:
            try:
                invoice_type = extracted.invoice_type
                inv_uuid = UUID(invoice["id"])
                if invoice_type == "PURCHASE":
                    journal = await journal_service.create_purchase_journal(entity_id, inv_uuid)
                else:
                    journal = await journal_service.create_sale_journal(entity_id, inv_uuid)
                logger.info(f"Journal created: {journal['id']}")
            except JournalError as exc:
                logger.warning(f"Journal creation skipped: {exc}")
                journal_error = str(exc)
            except Exception as exc:
                logger.error(f"Journal creation failed: {exc}")
                journal_error = str(exc)

        return {
            "invoice": invoice,
            "contact": contact,
            "line_items": line_items,
            "journal": journal,
            "journal_error": journal_error,
            "extraction": {
                "invoice_type": extracted.invoice_type,
                "payment_source": extracted.payment_source,
                "confidence_score": extracted.confidence_score,
                "invoice_number": extracted.invoice_number,
            },
        }

    # =========================================================================
    # INVENTORY MOVEMENT RECORDING
    # =========================================================================

    # Fee-like keywords — line items matching these are NOT stock purchases
    _FEE_KEYWORDS = frozenset([
        "fee", "fees", "charge", "charges", "shipping", "postage", "delivery",
        "handling", "discount", "credit", "adjustment", "service charge",
        "surcharge", "commission", "tax", "vat", "duty", "tariff", "insurance",
    ])

    # Pre-compiled regex: whole-word match for each keyword
    _FEE_PATTERN = re.compile(
        r"\b(?:" + "|".join(re.escape(k) for k in _FEE_KEYWORDS) + r")\b",
        re.IGNORECASE,
    )

    def _is_stockable_line(self, description: str) -> bool:
        """Heuristic: return False if the line item looks like a fee / service.

        Uses whole-word matching so e.g. 'trendsbyafeez' is NOT caught by 'fee'.
        """
        return not self._FEE_PATTERN.search(description)

    async def _record_purchase_movements(
        self,
        entity_id: UUID,
        line_items: List[Dict[str, Any]],
        category_map: Optional[Dict[str, str]] = None,
    ) -> List[Dict[str, Any]]:
        """Record PURCHASE inventory movements for stockable line items.

        Skips fee-like items (shipping, discounts, etc.) and lines with
        no quantity or no unit_cost.

        Returns list of movement dicts for items that were recorded.
        """
        recorded: List[Dict[str, Any]] = []

        for item in line_items:
            description = item.get("description", "")
            quantity = item.get("quantity")
            unit_cost = item.get("unit_cost")

            # Skip non-stockable or zero-quantity items
            if not quantity or quantity <= 0:
                continue
            if unit_cost is None:
                continue
            if not self._is_stockable_line(description):
                continue

            # Prefer SKU stored on the line item by the AI; fall back to heuristic extraction
            sku_candidate = item.get("sku") or self._extract_sku_from_description(description)

            try:
                movement_id = await persistence_service.record_purchase_movement_for_invoice_line(
                    invoice_line_item_id=UUID(item["id"]),
                    entity_id=entity_id,
                    sku=sku_candidate,
                    description=description,
                    quantity=float(quantity),
                    unit_cost=float(unit_cost),
                    category=(category_map or {}).get(description),
                )
                if movement_id:
                    recorded.append({"movement_id": str(movement_id), "line_item_id": item["id"]})
            except Exception as exc:
                logger.warning(
                    "Failed to record purchase movement for line %s: %s",
                    item.get("id"), exc,
                )

        return recorded

    @staticmethod
    def _extract_sku_from_description(description: str) -> Optional[str]:
        """Try to extract a SKU from the line item description.

        Returns the first token that looks like a product code
        (alphanumeric, 3+ chars, contains at least one digit).
        """
        import re
        tokens = description.split()
        for token in tokens[:3]:  # Only check first few tokens
            cleaned = re.sub(r"[^A-Za-z0-9]", "", token)
            if len(cleaned) >= 3 and re.search(r"\d", cleaned):
                return cleaned.upper()
        return None

    # =========================================================================
    # QUERY HELPERS
    # =========================================================================

    async def list_invoices(
        self,
        entity_id: UUID,
        invoice_type: Optional[Literal["SALE", "PURCHASE"]] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """List invoices with contact info and line items."""

        def _query():
            q = (
                self.client.table("invoices")
                .select("*, contacts(id, name, company_name, email, contact_type)")
                .eq("entity_id", str(entity_id))
            )
            if invoice_type:
                q = q.eq("invoice_type", invoice_type)
            if status:
                q = q.eq("status", status)
            return q.order("created_at", desc=True).range(offset, offset + limit - 1).execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def get_invoice(self, invoice_id: UUID) -> Optional[Dict[str, Any]]:
        """Get a single invoice with contact and line items."""
        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .select(
                "*, "
                "contacts(id, name, company_name, email, phone, address_line_1, city, country, tax_number, contact_type), "
                "invoice_line_items(*)"
            )
            .eq("id", str(invoice_id))
            .execute()
        )
        return extract_row(result)

    async def list_contacts(
        self,
        entity_id: UUID,
        contact_type: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """List contacts for an entity."""

        def _query():
            q = self.client.table("contacts").select("*").eq("entity_id", str(entity_id))
            if contact_type:
                q = q.eq("contact_type", contact_type)
            return q.order("name").execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def update_invoice_status(
        self, invoice_id: UUID, status: str
    ) -> Optional[Dict[str, Any]]:
        """Update invoice status."""
        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .update({"status": status})
            .eq("id", str(invoice_id))
            .execute()
        )
        return extract_row(result)

    async def delete_invoice(self, invoice_id: UUID) -> bool:
        """Delete invoice and its line items."""
        # Line items have ON DELETE CASCADE so just delete parent
        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .delete()
            .eq("id", str(invoice_id))
            .execute()
        )
        return bool(result.data)

    # =========================================================================
    # INVOICE UPDATE (editable fields only)
    # =========================================================================

    async def update_invoice(
        self,
        invoice_id: UUID,
        updates: Dict[str, Any],
        line_item_gl_updates: Optional[Dict[str, Optional[str]]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Update editable invoice fields and optionally line item GL accounts.

        Only invoice_type, notes are accepted as invoice-level edits.
        Line item GL accounts can be updated via line_item_gl_updates mapping
        {line_item_id: gl_account_id_or_null}.
        """
        ALLOWED_FIELDS = {"invoice_type", "notes"}
        safe_updates = {k: v for k, v in updates.items() if k in ALLOWED_FIELDS}

        invoice = None
        if safe_updates:
            result = await asyncio.to_thread(
                lambda: self.client.table("invoices")
                .update(safe_updates)
                .eq("id", str(invoice_id))
                .select()
                .execute()
            )
            invoice = extract_row(result)

        # Update line item GL accounts if provided
        if line_item_gl_updates:
            for li_id, gl_id in line_item_gl_updates.items():
                await asyncio.to_thread(
                    lambda lid=li_id, gid=gl_id: self.client.table("invoice_line_items")
                    .update({"gl_account_id": gid})
                    .eq("id", lid)
                    .execute()
                )

        # Return the full invoice with joins, regenerating the purchase journal
        # if GL accounts were changed so journal_line_items stay in sync.
        refreshed = None
        if invoice or line_item_gl_updates:
            refreshed = await self.get_invoice(invoice_id)

        if line_item_gl_updates and refreshed:
            if refreshed.get("invoice_type") == "PURCHASE":
                entity_id_val = refreshed.get("entity_id")
                if entity_id_val:
                    try:
                        await journal_service.create_purchase_journal(
                            UUID(entity_id_val), invoice_id, force=True
                        )
                    except Exception as exc:
                        logger.warning(
                            "Could not sync journal after GL account update on invoice "
                            f"{invoice_id}: {exc}"
                        )

        return refreshed

    # =========================================================================
    # PRODUCT CREATION FROM LINE ITEMS
    # =========================================================================

    async def create_products_from_line_items(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        line_item_ids: List[str],
        overrides: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Create product + inventory entries from user-selected invoice line items.

        Only line items explicitly chosen by the user in the Product Selection
        Modal are processed.  This is the ONLY path that creates inventory
        items and purchase movements — ensuring non-product expenses (R&D,
        marketing, giveaways) never receive stock records.

        Products created from invoices are bare-bones with provider='invoice'
        and external_id derived from the line item ID. These serve as
        placeholder entries that can be enriched when synced from an
        e-commerce platform.

        ``overrides`` is keyed by line_item_id and allows the user to supply
        corrected name/sku values before products are persisted.
        """
        if not line_item_ids:
            return []

        # Fetch the specified line items
        result = await asyncio.to_thread(
            lambda: self.client.table("invoice_line_items")
            .select("*")
            .eq("invoice_id", str(invoice_id))
            .in_("id", line_item_ids)
            .execute()
        )
        items = result.data or []

        if not items:
            return []

        products_data = []
        for item in items:
            description = item.get("description", "")
            line_item_id = item["id"]

            # Apply user overrides for name / sku if provided
            row_overrides = (overrides or {}).get(line_item_id, {})
            name = (row_overrides.get("name") or description).strip()
            sku = row_overrides.get("sku") or item.get("sku") or None

            if not name:
                continue

            # Use 'invoice' as provider and line_item_id as external_id
            # for uniqueness within the (provider, external_id, entity_id) constraint
            products_data.append({
                "entity_id": str(entity_id),
                "provider": "invoice",
                "external_id": line_item_id,
                "name": name,
                "description": description,
                "product_type": None,
                "status": "draft",
                "variants": (
                    [{
                        "external_id": line_item_id,
                        "sku": sku,
                        "name": name,
                        "price": (
                            {"amount": str(item["unit_cost"]), "currency": "GBP"}
                            if item.get("unit_cost") is not None
                            else None
                        ),
                        "compare_at_price": None,
                        "on_sale": False,
                        "quantity": int(item.get("quantity", 0) or 0),
                        "is_unlimited": False,
                        "attributes": {},
                    }]
                    if sku or item.get("unit_cost") is not None
                    else []
                ),
                "tags": [],
                "metadata": {
                    "source": "invoice",
                    "invoice_id": str(invoice_id),
                    "line_item_id": line_item_id,
                    "original_unit_cost": str(item.get("unit_cost", "0")),
                    "original_quantity": str(item.get("quantity", "0")),
                },
            })

        if not products_data:
            return []

        # Upsert to handle re-runs gracefully
        created = await asyncio.to_thread(
            lambda: self.client.table("products")
            .upsert(products_data, on_conflict="provider,external_id,entity_id")
            .execute()
        )

        created_products = created.data or []
        logger.info(
            "Created %d products from invoice %s line items",
            len(created_products),
            invoice_id,
        )

        # Create inventory items + purchase movements for the selected line items.
        # This is the ONLY place inventory records get created — ensuring items
        # the user did NOT select (or skipped entirely) never become stock.
        if created_products and items:
            # Build category_map from AI extraction data if possible
            category_map: Dict[str, str] = {}
            # items already holds the fetched line items
            inventory_movements = await self._record_purchase_movements(
                entity_id, items, category_map=category_map
            )
            if inventory_movements:
                logger.info(
                    "Created %d inventory movements for selected products",
                    len(inventory_movements),
                )

            # Link inventory_items → products
            await self._link_inventory_items_to_products(
                entity_id, created_products, overrides=overrides
            )

        return created_products

    async def _link_inventory_items_to_products(
        self,
        entity_id: UUID,
        products: List[Dict[str, Any]],
        overrides: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> None:
        """Set inventory_items.product_id (and sku if overridden) for items
        whose purchase movement was created from one of the given invoice line items.

        Discovery path:
          products.external_id (= line_item_id)
          → inventory_movements.reference_id WHERE transaction_type = 'PURCHASE'
          → inventory_movements.inventory_item_id
          → UPDATE inventory_items SET product_id = products.id [, sku = override_sku]
        """
        for product in products:
            product_id = product.get("id")
            line_item_id = product.get("external_id")
            if not product_id or not line_item_id:
                continue
            try:
                # Find the PURCHASE movement for this invoice line
                mv_result = await asyncio.to_thread(
                    lambda lid=line_item_id: self.client.table("inventory_movements")
                    .select("inventory_item_id")
                    .eq("reference_id", lid)
                    .eq("reference_table", "invoice_line_items")
                    .eq("transaction_type", "PURCHASE")
                    .limit(1)
                    .execute()
                )
                if not mv_result.data:
                    continue  # No stock movement — product-only line, skip
                inventory_item_id = mv_result.data[0]["inventory_item_id"]

                # Build the patch: always set product_id; also update sku if the
                # user supplied an override (so inventory_items.sku stays in sync)
                row_overrides = (overrides or {}).get(line_item_id, {})
                override_sku = row_overrides.get("sku") or None
                patch: Dict[str, Any] = {"product_id": product_id}
                if override_sku:
                    patch["sku"] = override_sku
                    patch["variant_external_id"] = override_sku

                await asyncio.to_thread(
                    lambda iid=inventory_item_id, p=patch: self.client.table(
                        "inventory_items"
                    )
                    .update(p)
                    .eq("id", iid)
                    .eq("entity_id", str(entity_id))
                    .execute()
                )
                logger.debug(
                    "Linked inventory_item %s → product %s%s",
                    inventory_item_id,
                    product_id,
                    f" (sku → {override_sku})" if override_sku else "",
                )
            except Exception as exc:
                logger.warning(
                    "Failed to link inventory_item for line %s: %s", line_item_id, exc
                )

# Global service instance
invoice_service = InvoiceService()