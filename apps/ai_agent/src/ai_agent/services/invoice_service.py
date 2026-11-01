"""Invoice processing service for ThreadWise.

Handles the full invoice ingestion pipeline:
1. AI extraction from uploaded document (PDF/image) via structured output
2. Contact upsert (supplier or customer)
3. Invoice record creation
4. Invoice line items creation

Invoices never post to the ledger: the transaction that pays one is what gets journaled.
"""

import asyncio
import base64
import logging
import re
from typing import Any, Dict, List, Literal, Optional, Tuple, cast
from uuid import UUID

from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

from ..core.config import Settings
from ..core.supabase_client import get_supabase_client
from ..normalization.persistence import persistence_service
from ..normalization.utils import extract_row, extract_rows
from .invoice_rules import (
    PAYABLE,
    SYNCED_ORIGINS,
    InvoiceRuleError,
    check_deletable,
    check_editable,
    check_transition,
    normalise_status,
    status_from_payments,
)
from .journal_service import journal_service

logger = logging.getLogger(__name__)

settings = Settings()


# =============================================================================
# PYDANTIC MODELS FOR AI STRUCTURED OUTPUT
# =============================================================================


class ExtractedContact(BaseModel):
    """Contact (counterparty) extracted from invoice."""

    name: str = Field(
        ..., description="Full name or organisation name of the counterparty"
    )
    company_name: Optional[str] = Field(
        None, description="Trading / company name if different from name"
    )
    email: Optional[str] = Field(default=None, description="Contact email address")
    phone: Optional[str] = Field(default=None, description="Contact phone number")
    address_line_1: Optional[str] = Field(
        default=None, description="First line of address"
    )
    address_line_2: Optional[str] = Field(
        default=None, description="Second line of address"
    )
    city: Optional[str] = Field(default=None, description="City or town")
    region: Optional[str] = Field(default=None, description="State, county, or region")
    postal_code: Optional[str] = Field(default=None, description="Postal / ZIP code")
    country: Optional[str] = Field(default=None, description="Country name or ISO code")
    tax_number: Optional[str] = Field(
        default=None, description="VAT / GST / tax registration number"
    )


class ExtractedLineItem(BaseModel):
    """A single line item from the invoice."""

    description: str = Field(..., description="Description of goods or service")
    sku: Optional[str] = Field(
        None,
        description="Product SKU, part number, or item code if visible on the invoice",
    )
    quantity: Optional[float] = Field(None, description="Quantity of units")
    unit_cost: Optional[float] = Field(None, description="Cost per unit (excl. tax)")
    tax_code: Optional[str] = Field(
        None, description="Tax code or description, e.g. 'VAT20', 'ZERO'"
    )
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
    invoice_number: Optional[str] = Field(
        None, description="Invoice reference / number"
    )
    invoice_date: Optional[str] = Field(
        None, description="Invoice issue date in ISO 8601 format (YYYY-MM-DD)"
    )
    due_date: Optional[str] = Field(
        None, description="Payment due date in ISO 8601 format (YYYY-MM-DD)"
    )
    currency: str = Field("GBP", description="3-letter ISO currency code")
    net_amount: Optional[float] = Field(
        None, description="Total amount before tax (subtotal)"
    )
    tax_amount: Optional[float] = Field(None, description="Total VAT / tax amount")
    gross_amount: Optional[float] = Field(
        None, description="Total amount including tax"
    )
    fx_rate: Optional[float] = Field(
        None, description="Foreign exchange rate to base currency if applicable"
    )
    notes: Optional[str] = Field(
        None, description="Any payment terms, instructions, or notes from the invoice"
    )
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
    """Orchestrates invoice ingestion: AI extraction → DB persistence."""

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
            allowed_types: Tuple[str, ...]
            if invoice_type_hint == "PURCHASE":
                allowed_types = ("expense", "cogs", "cost_of_goods_sold")
            elif invoice_type_hint == "SALE":
                allowed_types = ("revenue", "income")
            else:
                allowed_types = (
                    "expense",
                    "revenue",
                    "cogs",
                    "income",
                    "cost_of_goods_sold",
                )

            relevant = [
                a
                for a in chart_of_accounts
                if a.get("account_type") in allowed_types
                and not a.get("is_header", False)
            ]
            if not relevant:
                # Fallback: include all non-header accounts
                relevant = [
                    a for a in chart_of_accounts if not a.get("is_header", False)
                ]
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
            f"FILE: {file_name}" + coa_block
        )

        # Build multimodal message
        content_parts: List[Dict[str, Any]] = [
            {"type": "text", "text": system_text},
        ]

        if mime_type == "application/pdf":
            content_parts.append(
                {
                    "type": "file",
                    "source_type": "base64",
                    "mime_type": mime_type,
                    "data": b64,
                }
            )
        else:
            content_parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{b64}"},
                }
            )

        content_parts.append(
            {
                "type": "text",
                "text": (
                    "Extract all invoice data following the rules above. "
                    "For each line item, set suggested_gl_code to the most appropriate account_number "
                    "from the chart of accounts. "
                    "Set confidence_score (0-1) based on document readability."
                ),
            }
        )

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
            return cast(
                Dict[str, Any], updated.data[0] if updated.data else existing.data[0]
            )

        # Insert new contact
        inserted = await asyncio.to_thread(
            lambda: self.client.table("contacts").insert(contact_data).execute()
        )
        if not inserted.data:
            raise ValueError("Failed to create contact")
        return cast(Dict[str, Any], inserted.data[0])

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
            lambda: self.client.table("invoices").insert(invoice_data).execute()
        )

        if not result.data:
            raise ValueError("Failed to create invoice")
        return cast(Dict[str, Any], result.data[0])

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
                if (
                    invoice_type == "PURCHASE"
                    and acct_type in invalid_types_for_purchase
                ):
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

            items_data.append(
                {
                    "invoice_id": str(invoice_id),
                    "description": item.description,
                    "sku": item.sku or None,
                    "quantity": item.quantity,
                    "unit_cost": item.unit_cost,
                    "tax_code": tax_code,
                    "vat_rate": item.vat_rate or 0.0,
                    "gl_account_id": gl_account_id,
                }
            )

        result = await asyncio.to_thread(
            lambda: self.client.table("invoice_line_items").insert(items_data).execute()
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
        invoice_type_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Full invoice ingestion pipeline.

        Steps:
            0. Fetch entity context + chart of accounts (used to enrich AI prompt)
            1. AI extraction (structured output with entity context + CoA)
            2. Contact upsert (counterparty only, never our own entity)
            3. Invoice creation (source = AI-detected platform or 'manual')
            4. Line item creation (with GL account resolution from CoA)

        Args:
            entity_id: Business entity UUID
            file_content: Raw file bytes
            mime_type: MIME type
            file_name: Original filename for context
            file_path: Supabase storage path (e.g. "entity_id/timestamp-name.pdf")

        Returns:
            { invoice, contact, line_items, extraction }
        """
        # Step 0: Fetch entity + CoA for AI context
        entity = await self._fetch_entity(entity_id)
        entity_name: str = (
            (entity.get("name") or entity.get("legal_name") or "our business")
            if entity
            else "our business"
        )

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
        contact = await self.upsert_contact(
            entity_id, extracted.counterparty, contact_type
        )
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

        return {
            "invoice": invoice,
            "contact": contact,
            "line_items": line_items,
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
    _FEE_KEYWORDS = frozenset(
        [
            "fee",
            "fees",
            "charge",
            "charges",
            "shipping",
            "postage",
            "delivery",
            "handling",
            "discount",
            "credit",
            "adjustment",
            "service charge",
            "surcharge",
            "commission",
            "tax",
            "vat",
            "duty",
            "tariff",
            "insurance",
        ]
    )

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
            sku_candidate = item.get("sku") or self._extract_sku_from_description(
                description
            )

            try:
                movement_id = (
                    await persistence_service.record_purchase_movement_for_invoice_line(
                        invoice_line_item_id=UUID(item["id"]),
                        entity_id=entity_id,
                        sku=sku_candidate,
                        description=description,
                        quantity=float(quantity),
                        unit_cost=float(unit_cost),
                        category=(category_map or {}).get(description),
                    )
                )
                if movement_id:
                    recorded.append(
                        {"movement_id": str(movement_id), "line_item_id": item["id"]}
                    )
            except Exception as exc:
                logger.warning(
                    "Failed to record purchase movement for line %s: %s",
                    item.get("id"),
                    exc,
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
            return (
                q.order("created_at", desc=True)
                .range(offset, offset + limit - 1)
                .execute()
            )

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
            q = (
                self.client.table("contacts")
                .select("*")
                .eq("entity_id", str(entity_id))
            )
            if contact_type:
                q = q.eq("contact_type", contact_type)
            return q.order("name").execute()

        result = await asyncio.to_thread(_query)
        return extract_rows(result)

    async def update_invoice_status(
        self, invoice_id: UUID, status: str
    ) -> Optional[Dict[str, Any]]:
        """Write the status as given. Prefer :meth:`set_invoice_status`, which checks the
        move is allowed."""
        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .update({"status": status})
            .eq("id", str(invoice_id))
            .execute()
        )
        return extract_row(result)

    async def _get_owned_invoice(
        self, entity_id: UUID, invoice_id: UUID
    ) -> Dict[str, Any]:
        """Fetch an invoice, treating one that belongs to another entity as not found."""
        invoice = await self.get_invoice(invoice_id)
        if not invoice or str(invoice.get("entity_id")) != str(entity_id):
            raise ValueError(f"Invoice not found: {invoice_id}")
        return invoice

    async def set_invoice_status(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        status: str,
    ) -> Dict[str, Any]:
        """Move an invoice through its lifecycle.

        The allowed moves are in :mod:`invoice_rules`; anything else raises
        :class:`InvoiceRuleError`. A status is a label on a document: nothing is posted
        or reversed, because the payment behind an invoice is journaled from its
        transaction. Repeating the current status is a no-op. A synced invoice's status
        is not the app's to set, and a draft with linked payments is finalised to the
        status those payments imply.
        """
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        check_editable(invoice.get("origin"), "status")

        current = normalise_status(invoice.get("status"))
        target = normalise_status(status)
        check_transition(current, target)

        # A draft that already has its payment linked is finalised straight to what the
        # links say, not to OPEN.
        if current == "DRAFT" and target == "OPEN":
            target = status_from_payments(
                target,
                invoice.get("gross_amount"),
                invoice.get("currency"),
                self._amounts(await self.list_payments(invoice_id)),
            )

        updated = (
            invoice
            if current == target
            else await self.update_invoice_status(invoice_id, target)
        )
        return {"invoice": updated, "previous_status": current}

    # =========================================================================
    # PAYMENT LINKS (which transactions settled an invoice)
    # =========================================================================

    @staticmethod
    def _amounts(payments: List[Dict[str, Any]]) -> List[Tuple[Any, Any]]:
        return [(p.get("amount"), p.get("currency_code")) for p in payments]

    async def list_payments(self, invoice_id: UUID) -> List[Dict[str, Any]]:
        """The invoice's payment links, oldest first."""
        result = await asyncio.to_thread(
            lambda: self.client.table("invoice_payments")
            .select("id, financial_transaction_id, amount, currency_code, matched_by")
            .eq("invoice_id", str(invoice_id))
            .order("created_at")
            .execute()
        )
        return extract_rows(result)

    async def _settle_from_payments(self, invoice: Dict[str, Any]) -> Dict[str, Any]:
        """Write the status the invoice's links imply, if it differs.

        Not for a synced invoice: its status is the provider's (a Revolut payment request
        that Revolut says is paid stays paid while its bank transaction is not linked yet).
        """
        if (invoice.get("origin") or "upload") in SYNCED_ORIGINS:
            return invoice
        payments = await self.list_payments(UUID(invoice["id"]))
        current = normalise_status(invoice.get("status"))
        target = status_from_payments(
            current,
            invoice.get("gross_amount"),
            invoice.get("currency"),
            self._amounts(payments),
        )
        if target == current:
            return invoice
        return await self.update_invoice_status(UUID(invoice["id"]), target) or invoice

    async def link_payment(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        transaction_id: UUID,
        matched_by: Literal["user", "reconciliation", "sync"] = "user",
    ) -> Dict[str, Any]:
        """Record that a transaction paid this invoice, then set the status it implies.

        The transaction must be the business's own, counted in the books, in the direction
        that pays the invoice (money in for a sale, out for a purchase) and not already
        paying another invoice. Linking the same pair again is a no-op. Nothing is posted:
        the transaction is journaled on its own.
        """
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        status = normalise_status(invoice.get("status"))
        if status not in PAYABLE and status != "DRAFT":
            raise InvoiceRuleError(
                f"A {status.lower()} invoice is not owed, so it takes no payment."
            )

        txn = extract_row(
            await asyncio.to_thread(
                lambda: self.client.table("financial_transactions")
                .select(
                    "id, entity_id, direction, excluded_reason, amount, currency_code"
                )
                .eq("id", str(transaction_id))
                .execute()
            )
        )
        if not txn or str(txn.get("entity_id")) != str(entity_id):
            raise ValueError(f"Transaction not found: {transaction_id}")
        if txn.get("excluded_reason"):
            raise InvoiceRuleError("That transaction is left out of your books.")
        is_sale = (invoice.get("invoice_type") or "").upper() == "SALE"
        if txn.get("direction") != ("in" if is_sale else "out"):
            raise InvoiceRuleError(
                "A sale is paid by money coming in."
                if is_sale
                else "A purchase is paid by money going out."
            )

        existing = extract_rows(
            await asyncio.to_thread(
                lambda: self.client.table("invoice_payments")
                .select("invoice_id")
                .eq("financial_transaction_id", str(transaction_id))
                .execute()
            )
        )
        if existing and existing[0]["invoice_id"] != str(invoice_id):
            raise InvoiceRuleError(
                "That transaction is already matched to another invoice."
            )
        if not existing:
            await asyncio.to_thread(
                lambda: self.client.table("invoice_payments")
                .insert(
                    {
                        "entity_id": str(entity_id),
                        "invoice_id": str(invoice_id),
                        "financial_transaction_id": str(transaction_id),
                        "amount": abs(float(txn["amount"])),
                        "currency_code": txn["currency_code"],
                        "matched_by": matched_by,
                    }
                )
                .execute()
            )
        return await self._settle_from_payments(invoice)

    async def unlink_payment(
        self, entity_id: UUID, invoice_id: UUID, transaction_id: UUID
    ) -> Dict[str, Any]:
        """Remove a transaction's link to this invoice, then set the status left."""
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        removed = extract_rows(
            await asyncio.to_thread(
                lambda: self.client.table("invoice_payments")
                .delete()
                .eq("invoice_id", str(invoice_id))
                .eq("financial_transaction_id", str(transaction_id))
                .execute()
            )
        )
        if not removed:
            raise InvoiceRuleError("That transaction is not matched to this invoice.")
        return await self._settle_from_payments(invoice)

    async def delete_invoice(self, entity_id: UUID, invoice_id: UUID) -> Dict[str, Any]:
        """Delete an invoice and its line items, and its stored document.

        Only a DRAFT, CANCELLED or VOID invoice can go; a live one is voided instead, so
        the record stays. Line items cascade with the invoice.
        """
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        check_editable(invoice.get("origin"), "delete")
        check_deletable(invoice.get("status") or "")

        result = await asyncio.to_thread(
            lambda: self.client.table("invoices")
            .delete()
            .eq("id", str(invoice_id))
            .eq("entity_id", str(entity_id))
            .execute()
        )
        deleted = bool(result.data)

        file_removed = False
        file_path = invoice.get("file_path")
        if deleted and file_path:
            try:
                await asyncio.to_thread(
                    lambda: self.client.storage.from_("invoices").remove([file_path])
                )
                file_removed = True
            except (
                Exception
            ) as exc:  # the record is gone; an orphaned file is only clutter
                logger.warning(
                    "Could not remove stored document %s: %s", file_path, exc
                )

        return {"deleted": deleted, "file_removed": file_removed}

    # =========================================================================
    # INVOICE UPDATE (editable fields only)
    # =========================================================================

    async def update_invoice(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        updates: Dict[str, Any],
        line_item_gl_updates: Optional[Dict[str, Optional[str]]] = None,
    ) -> Dict[str, Any]:
        """Update editable invoice fields and optionally line item GL accounts.

        Only ``invoice_type`` and ``notes`` are editable at invoice level, and the type
        only while the invoice is a DRAFT: once it is finalised, which side owes whom is
        settled. Amounts are never editable here.

        ``line_item_gl_updates`` maps ``{line_item_id: gl_account_id_or_null}``. Every
        line must belong to this invoice (an id from another invoice is rejected rather
        than silently re-coded). The accounts describe what each line was for; nothing
        is posted from them.
        """
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        status = normalise_status(invoice.get("status"))

        safe_updates = {
            k: v for k, v in updates.items() if k in {"invoice_type", "notes"}
        }
        new_type = safe_updates.get("invoice_type")
        if new_type and new_type != invoice.get("invoice_type"):
            check_editable(invoice.get("origin"), "direction")
            if status != "DRAFT":
                raise InvoiceRuleError(
                    "The direction of an invoice can only be changed while it is a draft."
                )

        if line_item_gl_updates:
            own_lines = {li["id"] for li in invoice.get("invoice_line_items") or []}
            foreign = set(line_item_gl_updates) - own_lines
            if foreign:
                raise InvoiceRuleError(
                    f"{len(foreign)} line item(s) do not belong to this invoice"
                )

        if safe_updates:
            await asyncio.to_thread(
                lambda: self.client.table("invoices")
                .update(safe_updates)
                .eq("id", str(invoice_id))
                .execute()
            )

        for li_id, gl_id in (line_item_gl_updates or {}).items():
            await asyncio.to_thread(
                lambda: self.client.table("invoice_line_items")
                .update({"gl_account_id": gl_id})
                .eq("id", li_id)
                .eq("invoice_id", str(invoice_id))
                .execute()
            )

        return await self.get_invoice(invoice_id) or invoice

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
            products_data.append(
                {
                    "entity_id": str(entity_id),
                    "provider": "invoice",
                    "external_id": line_item_id,
                    "name": name,
                    "description": description,
                    "product_type": None,
                    "status": "draft",
                    "variants": (
                        [
                            {
                                "external_id": line_item_id,
                                "sku": sku,
                                "name": name,
                                "price": (
                                    {
                                        "amount": str(item["unit_cost"]),
                                        "currency": "GBP",
                                    }
                                    if item.get("unit_cost") is not None
                                    else None
                                ),
                                "compare_at_price": None,
                                "on_sale": False,
                                "quantity": int(item.get("quantity", 0) or 0),
                                "is_unlimited": False,
                                "attributes": {},
                            }
                        ]
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
                }
            )

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
                    lambda: self.client.table("inventory_movements")
                    .select("inventory_item_id")
                    .eq("reference_id", line_item_id)
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
                if row_overrides.get("asset_account_id"):
                    patch["asset_account_id"] = row_overrides["asset_account_id"]
                if row_overrides.get("cogs_account_id"):
                    patch["cogs_account_id"] = row_overrides["cogs_account_id"]

                await asyncio.to_thread(
                    lambda: self.client.table("inventory_items")
                    .update(patch)
                    .eq("id", inventory_item_id)
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

    async def link_line_items_to_existing_products(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        links: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Backfill unit costs on existing inventory items from invoice line items.

        For each {line_item_id, product_id} pair:
          1. Reads unit_cost from the invoice line item
          2. Finds all inventory_items linked to that product
          3. Updates their unit_cost
          4. Creates a PURCHASE movement per inventory item for COGS tracking

        This is the correct path when the product catalog already exists
        (e.g. synced from Squarespace) and the user just wants to assign costs
        from a purchase invoice.
        """
        if not links:
            return {"updated_items": 0, "linked_products": 0}

        line_item_ids = [
            lnk["line_item_id"] for lnk in links if lnk.get("line_item_id")
        ]
        if not line_item_ids:
            return {"updated_items": 0, "linked_products": 0}

        # Fetch all referenced line items in one round-trip
        li_result = await asyncio.to_thread(
            lambda: self.client.table("invoice_line_items")
            .select("id, unit_cost, quantity, description, sku")
            .eq("invoice_id", str(invoice_id))
            .in_("id", line_item_ids)
            .execute()
        )
        line_items_by_id: Dict[str, Any] = {
            li["id"]: li for li in (li_result.data or [])
        }

        updated_items = 0
        linked_products = 0

        for lnk in links:
            line_item_id = lnk.get("line_item_id")
            product_id = lnk.get("product_id")
            if not line_item_id or not product_id:
                continue

            li = line_items_by_id.get(line_item_id)
            if not li or li.get("unit_cost") is None:
                logger.warning(
                    "Skipping link: line item %s not found or has no unit_cost",
                    line_item_id,
                )
                continue

            unit_cost = float(li["unit_cost"])
            qty = float(li.get("quantity") or 0)
            asset_account_id = lnk.get("asset_account_id") or None
            cogs_account_id = lnk.get("cogs_account_id") or None

            try:
                # Fetch all inventory_items for this product
                inv_result = await asyncio.to_thread(
                    lambda: self.client.table("inventory_items")
                    .select("id, variant_external_id, sku")
                    .eq("product_id", product_id)
                    .eq("entity_id", str(entity_id))
                    .execute()
                )
                inventory_items = inv_result.data or []

                # No inventory_items yet — bootstrap from the product's variants
                if not inventory_items:
                    prod_result = await asyncio.to_thread(
                        lambda: self.client.table("products")
                        .select("id, name, provider, variants")
                        .eq("id", product_id)
                        .eq("entity_id", str(entity_id))
                        .limit(1)
                        .execute()
                    )
                    product_row = prod_result.data[0] if prod_result.data else None
                    if not product_row:
                        logger.warning(
                            "Product %s not found for entity %s — skipping link",
                            product_id,
                            entity_id,
                        )
                        continue

                    raw_variants = product_row.get("variants") or []
                    # Fall back to a single generic entry if product has no variants
                    if not raw_variants:
                        raw_variants = [
                            {"external_id": product_id, "sku": None, "attributes": {}}
                        ]

                    provider = product_row.get("provider") or "invoice"
                    to_insert = [
                        {
                            "entity_id": str(entity_id),
                            "product_id": product_id,
                            "variant_external_id": (v.get("external_id") or product_id),
                            "sku": v.get("sku") or None,
                            "description": li.get("description"),
                            "unit_cost": unit_cost,
                            "is_unlimited": False,
                            "provider": provider,
                            **(
                                {"asset_account_id": asset_account_id}
                                if asset_account_id
                                else {}
                            ),
                            **(
                                {"cogs_account_id": cogs_account_id}
                                if cogs_account_id
                                else {}
                            ),
                        }
                        for v in raw_variants
                    ]
                    upsert_result = await asyncio.to_thread(
                        lambda: self.client.table("inventory_items")
                        .upsert(
                            to_insert,
                            on_conflict="entity_id,provider,variant_external_id",
                        )
                        .execute()
                    )
                    inventory_items = upsert_result.data or []
                    if not inventory_items:
                        logger.warning(
                            "Failed to create inventory_items for product %s — skipping",
                            product_id,
                        )
                        continue
                    logger.info(
                        "Bootstrapped %d inventory_item(s) for product %s",
                        len(inventory_items),
                        product_id,
                    )

                # Bulk-update unit_cost (and optionally account IDs) for all variants
                inv_ids = [item["id"] for item in inventory_items]
                update_patch: Dict[str, Any] = {"unit_cost": unit_cost}
                if asset_account_id:
                    update_patch["asset_account_id"] = asset_account_id
                if cogs_account_id:
                    update_patch["cogs_account_id"] = cogs_account_id
                await asyncio.to_thread(
                    lambda: self.client.table("inventory_items")
                    .update(update_patch)
                    .in_("id", inv_ids)
                    .eq("entity_id", str(entity_id))
                    .execute()
                )
                updated_items += len(inv_ids)

                # Record a PURCHASE movement for each inventory item.
                # Use the same column names as persistence_service (quantity, not
                # quantity_delta; entity_id is not a column on inventory_movements).
                # Idempotent: skip if a PURCHASE movement already exists for this
                # line_item_id + inventory_item combination.
                for inv_item in inventory_items:
                    try:
                        existing_mv = await asyncio.to_thread(
                            lambda: self.client.table("inventory_movements")
                            .select("id")
                            .eq("reference_id", line_item_id)
                            .eq("inventory_item_id", inv_item["id"])
                            .eq("transaction_type", "PURCHASE")
                            .limit(1)
                            .execute()
                        )
                        if existing_mv.data:
                            continue  # Already recorded — skip to stay idempotent

                        movement = {
                            "inventory_item_id": inv_item["id"],
                            "quantity": qty,
                            "unit_cost": unit_cost,
                            "transaction_type": "PURCHASE",
                            "reference_id": line_item_id,
                            "reference_table": "invoice_line_items",
                            "notes": f"Cost backfilled from invoice {invoice_id}",
                        }
                        await asyncio.to_thread(
                            lambda: self.client.table("inventory_movements")
                            .insert(movement)
                            .execute()
                        )
                    except Exception as exc:
                        logger.warning(
                            "Could not record purchase movement for inv_item %s: %s",
                            inv_item["id"],
                            exc,
                        )

                linked_products += 1
                logger.info(
                    "Linked invoice line %s → product %s: updated %d item(s) @ £%.2f",
                    line_item_id,
                    product_id,
                    len(inv_ids),
                    unit_cost,
                )

            except Exception as exc:
                logger.warning(
                    "Failed to link line item %s to product %s: %s",
                    line_item_id,
                    product_id,
                    exc,
                )

        return {"updated_items": updated_items, "linked_products": linked_products}

    async def create_inventory_movements_only(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        line_item_ids: List[str],
        overrides: Optional[Dict[str, Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """Create inventory items + PURCHASE movements without creating product catalog entries.

        Used when the user selects Skip (expense) on a line item but still wants
        to track the physical stock movement (e.g. consumables, raw materials).

        ``overrides`` is keyed by line_item_id and accepts:
          - ``sku``              — override the SKU used to match/create the inventory_item
          - ``asset_account_id`` — set the GL asset account on the inventory_item
          - ``cogs_account_id``  — set the GL COGS account on the inventory_item
        """
        if not line_item_ids:
            return {"recorded": 0}

        result = await asyncio.to_thread(
            lambda: self.client.table("invoice_line_items")
            .select("*")
            .eq("invoice_id", str(invoice_id))
            .in_("id", line_item_ids)
            .execute()
        )
        items = result.data or []
        if not items:
            return {"recorded": 0}

        # Apply SKU overrides before passing to _record_purchase_movements
        for item in items:
            item_overrides = (overrides or {}).get(item["id"], {})
            if item_overrides.get("sku"):
                item["sku"] = item_overrides["sku"]

        movements = await self._record_purchase_movements(
            entity_id, items, category_map={}
        )

        # Apply asset/cogs account overrides to the inventory items created above
        for item in items:
            item_overrides = (overrides or {}).get(item["id"], {})
            asset_account_id = item_overrides.get("asset_account_id")
            cogs_account_id = item_overrides.get("cogs_account_id")
            if not asset_account_id and not cogs_account_id:
                continue
            try:
                mv_result = await asyncio.to_thread(
                    lambda: self.client.table("inventory_movements")
                    .select("inventory_item_id")
                    .eq("reference_id", item["id"])
                    .eq("transaction_type", "PURCHASE")
                    .limit(1)
                    .execute()
                )
                if not mv_result.data:
                    continue
                inv_item_id = mv_result.data[0]["inventory_item_id"]
                patch: Dict[str, Any] = {}
                if asset_account_id:
                    patch["asset_account_id"] = asset_account_id
                if cogs_account_id:
                    patch["cogs_account_id"] = cogs_account_id
                await asyncio.to_thread(
                    lambda: self.client.table("inventory_items")
                    .update(patch)
                    .eq("id", inv_item_id)
                    .eq("entity_id", str(entity_id))
                    .execute()
                )
            except Exception as exc:
                logger.warning(
                    "Failed to apply account overrides for line %s: %s", item["id"], exc
                )

        return {"recorded": len(movements)}

    # =========================================================================
    # STOCK DECISIONS (one call for a whole invoice)
    # =========================================================================

    STOCK_ACTIONS = ("expense", "link", "new", "track")

    async def stock_state(self, invoice_id: UUID, line_item_ids: List[str]) -> set:
        """Line items that already have a PURCHASE movement recorded against them."""
        if not line_item_ids:
            return set()
        result = await asyncio.to_thread(
            lambda: self.client.table("inventory_movements")
            .select("reference_id")
            .eq("reference_table", "invoice_line_items")
            .eq("transaction_type", "PURCHASE")
            .in_("reference_id", line_item_ids)
            .execute()
        )
        return {row["reference_id"] for row in extract_rows(result)}

    async def apply_stock_decisions(
        self,
        entity_id: UUID,
        invoice_id: UUID,
        decisions: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Decide, for each purchase line, whether it is stock and how it is tracked.

        This replaces three separate endpoints that the UI used to call in turn (and race).
        Each decision is one of:

        * ``expense`` : nothing to record; the line stays a pure expense.
        * ``link``    : an existing product (``product_id``): set its unit cost from this
                        line and record the purchase against its inventory items.
        * ``new``     : create a draft product (``name``, optional ``sku``) and its stock.
        * ``track``   : record the stock movement without a catalogue product (raw
                        materials, consumables).

        ``asset_account_id`` / ``cogs_account_id`` are optional on ``link``, ``new`` and
        ``track``. Every step is idempotent per line, so re-sending a decision is safe.

        Validation happens up front, before anything is written: a bad line fails the
        whole request rather than leaving the invoice half-applied.

        Returns one result per line: ``recorded`` is whether a purchase movement now
        exists for it (a line without a quantity or unit cost cannot be recorded).
        """
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        if (invoice.get("invoice_type") or "PURCHASE").upper() != "PURCHASE":
            raise InvoiceRuleError("Only purchase invoices carry stock")

        lines = {li["id"]: li for li in invoice.get("invoice_line_items") or []}
        seen: set = set()
        for d in decisions:
            line_id = d.get("line_item_id")
            action = d.get("action")
            if line_id not in lines:
                raise InvoiceRuleError(
                    f"Line item {line_id} does not belong to this invoice"
                )
            if line_id in seen:
                raise InvoiceRuleError(f"Line item {line_id} appears more than once")
            seen.add(line_id)
            if action not in self.STOCK_ACTIONS:
                raise InvoiceRuleError(f"Unknown stock action '{action}'")
            if action == "link" and not d.get("product_id"):
                raise InvoiceRuleError("Choose a product to link each 'link' line to")

        def accounts(d: Dict[str, Any]) -> Dict[str, str]:
            return {
                k: d[k] for k in ("asset_account_id", "cogs_account_id") if d.get(k)
            }

        to_create = [d for d in decisions if d["action"] == "new"]
        to_link = [d for d in decisions if d["action"] == "link"]
        to_track = [d for d in decisions if d["action"] == "track"]

        if to_create:
            await self.create_products_from_line_items(
                entity_id,
                invoice_id,
                [d["line_item_id"] for d in to_create],
                overrides={
                    d["line_item_id"]: {
                        "name": (
                            d.get("name") or lines[d["line_item_id"]]["description"]
                        ).strip(),
                        **({"sku": d["sku"]} if d.get("sku") else {}),
                        **accounts(d),
                    }
                    for d in to_create
                },
            )
        if to_link:
            await self.link_line_items_to_existing_products(
                entity_id,
                invoice_id,
                [
                    {
                        "line_item_id": d["line_item_id"],
                        "product_id": d["product_id"],
                        **accounts(d),
                    }
                    for d in to_link
                ],
            )
        if to_track:
            await self.create_inventory_movements_only(
                entity_id,
                invoice_id,
                [d["line_item_id"] for d in to_track],
                overrides={
                    d["line_item_id"]: {
                        **({"sku": d["sku"]} if d.get("sku") else {}),
                        **accounts(d),
                    }
                    for d in to_track
                },
            )

        stocked = [d["line_item_id"] for d in decisions if d["action"] != "expense"]
        recorded_ids = await self.stock_state(invoice_id, stocked)
        results = [
            {
                "line_item_id": d["line_item_id"],
                "action": d["action"],
                "recorded": d["line_item_id"] in recorded_ids,
            }
            for d in decisions
        ]
        return {
            "results": results,
            "recorded": sum(1 for r in results if r["recorded"]),
            "not_recorded": [
                r["line_item_id"]
                for r in results
                if r["action"] != "expense" and not r["recorded"]
            ],
        }


# Global service instance
invoice_service = InvoiceService()
