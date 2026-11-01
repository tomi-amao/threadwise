"""Invoice processing service for ThreadWise.

Handles the full invoice ingestion pipeline:
1. AI extraction from uploaded document (PDF/image) via structured output
2. Contact upsert (supplier or customer)
3. Invoice record creation
4. Invoice line items creation, each with what it bought (``line_kind``: a product, a
   sample or neither) and, for a product, the product it matches

Invoices never post to the ledger: the transaction that pays one is what gets journaled. Nor
do they touch stock: what a line bought is shown on the invoice, and nothing is written to
``products``, ``inventory_items`` or ``inventory_movements``.
"""

import asyncio
import base64
import hashlib
import logging
import re
from typing import Any, Dict, List, Literal, NamedTuple, Optional, Tuple, cast
from uuid import UUID

from langchain.chat_models import init_chat_model
from pydantic import BaseModel, Field

from ..core.config import Settings
from ..core.supabase_client import get_supabase_client
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


LineKind = Literal["product", "sample", "other"]
LINE_KINDS = ("product", "sample", "other")


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
    line_kind: Optional[LineKind] = Field(
        None,
        description=(
            "What this line is. 'product': goods the business sells, bought or made for "
            "resale. 'sample': a sample, prototype or trial run of a product, not for "
            "resale. 'other': anything else (shipping, freight, packaging, fees, services, "
            "tooling, setup or design charges)."
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


def document_part(file_content: bytes, mime_type: str) -> Dict[str, Any]:
    """The file as one part of a multimodal message: a PDF as a file, anything else as an
    image."""
    b64 = base64.b64encode(file_content).decode("utf-8")
    if mime_type == "application/pdf":
        return {
            "type": "file",
            "source_type": "base64",
            "mime_type": mime_type,
            "data": b64,
        }
    return {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}}


class DuplicateInvoiceError(InvoiceRuleError):
    """The upload is an invoice the register already holds: the same file, or the same
    number from the same counterparty."""

    def __init__(self, message: str, invoice_id: str):
        super().__init__(message)
        self.invoice_id = invoice_id


def same_number(a: Optional[str], b: Optional[str]) -> bool:
    """Invoice numbers compared as people write them: case, spaces and punctuation aside."""
    squash = lambda s: re.sub(r"[^0-9a-z]", "", (s or "").lower())  # noqa: E731
    return bool(squash(a)) and squash(a) == squash(b)


class ProductCatalogue(NamedTuple):
    """The business's products, keyed for matching an invoice line to one.

    ``by_sku``: an inventory item's SKU (lower case) to its product. ``by_name``: a product's
    name (lower case, trimmed) to the product. A key that points at more than one product is
    left out, so an ambiguous line stays unlinked rather than linked to the wrong one.
    """

    by_sku: Dict[str, str]
    by_name: Dict[str, str]


def _unambiguous(pairs: List[Tuple[str, str]]) -> Dict[str, str]:
    found: Dict[str, set] = {}
    for key, product_id in pairs:
        if key:
            found.setdefault(key, set()).add(product_id)
    return {key: next(iter(ids)) for key, ids in found.items() if len(ids) == 1}


def build_catalogue(
    products: List[Dict[str, Any]], items: List[Dict[str, Any]]
) -> ProductCatalogue:
    """A catalogue from ``products`` rows (id, name) and ``inventory_items`` rows (sku,
    product_id). Items without a product (samples, materials) are ignored."""
    return ProductCatalogue(
        by_sku=_unambiguous(
            [
                (str(i.get("sku") or "").strip().lower(), str(i["product_id"]))
                for i in items
                if i.get("product_id")
            ]
        ),
        by_name=_unambiguous(
            [
                (str(p.get("name") or "").strip().lower(), str(p["id"]))
                for p in products
                if p.get("id")
            ]
        ),
    )


def match_product(
    catalogue: ProductCatalogue, sku: Optional[str], description: Optional[str]
) -> Optional[str]:
    """The product an invoice line bought: by SKU first, then by exact name. None when
    nothing matches, or only ambiguously; the person can link it in the drawer."""
    if sku and (found := catalogue.by_sku.get(sku.strip().lower())):
        return found
    if description:
        return catalogue.by_name.get(description.strip().lower())
    return None


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
            "LINE KINDS (line_kind on each line item):\n"
            "- 'product' for goods the business sells (bought or made for resale).\n"
            "- 'sample' for samples, prototypes and trial runs (often marked 'sample').\n"
            "- 'other' for shipping, freight, packaging, fees, services and setup charges.\n\n"
            "AMOUNTS:\n"
            "- Be precise. Derive missing amounts: if gross and net are present, tax = gross - net.\n"
            "- VAT rate as a percentage (e.g. 20, not 0.20).\n\n"
            f"FILE: {file_name}" + coa_block
        )

        # Build multimodal message
        content_parts: List[Dict[str, Any]] = [
            {"type": "text", "text": system_text},
        ]

        content_parts.append(document_part(file_content, mime_type))

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
        *,
        status: str = "DRAFT",
        origin: str = "upload",
        external_id: Optional[str] = None,
        attachment_id: Optional[str] = None,
        file_sha256: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Persist an invoice record to the database.

        Args:
            entity_id: Business entity UUID
            extracted: AI-extracted invoice data
            counterparty_id: Contact UUID of counterparty
            source: Upload source label (e.g. "manual", "email")
            status: DRAFT for an upload (a person reviews it); a synced invoice says its own
            origin, external_id, attachment_id: where the record came from (see the
                invoice_register migration); the defaults are an upload's

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
            "status": status,
            "source": source,
            "file_path": file_path or None,
            "notes": extracted.notes,
            "origin": origin,
            "external_id": external_id,
            "attachment_id": attachment_id,
            "file_sha256": file_sha256,
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

    async def product_catalogue(self, entity_id: UUID) -> ProductCatalogue:
        """The business's products and the SKUs of their inventory items, for matching.
        Reads only."""
        products = await asyncio.to_thread(
            lambda: self.client.table("products")
            .select("id, name")
            .eq("entity_id", str(entity_id))
            .execute()
        )
        items = await asyncio.to_thread(
            lambda: self.client.table("inventory_items")
            .select("sku, product_id")
            .eq("entity_id", str(entity_id))
            .not_.is_("product_id", "null")
            .execute()
        )
        return build_catalogue(extract_rows(products), extract_rows(items))

    async def create_line_items(
        self,
        invoice_id: UUID,
        line_items: List[ExtractedLineItem],
        chart_of_accounts: Optional[List[Dict[str, Any]]] = None,
        invoice_type: Optional[str] = None,
        entity_id: Optional[UUID] = None,
    ) -> List[Dict[str, Any]]:
        """Insert invoice line items, resolving AI-suggested GL codes to account UUIDs.

        Validates that GL codes match the invoice type (e.g. PURCHASE invoices
        should not have revenue accounts). Each line keeps the kind the extraction gave it
        (product, sample or other) and, for a product with ``entity_id`` given, the
        business's product it matches (``match_product``). Only the line is written.

        Args:
            invoice_id: Invoice UUID
            line_items: Extracted line items (may include suggested_gl_code)
            chart_of_accounts: Pre-fetched CoA used to resolve account_number → UUID
            invoice_type: 'SALE' or 'PURCHASE' — used to validate GL code types
            entity_id: The business, to match product lines to its products

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

        catalogue = (
            await self.product_catalogue(entity_id)
            if entity_id and any(i.line_kind == "product" for i in line_items)
            else ProductCatalogue({}, {})
        )

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
                    "line_kind": item.line_kind or "other",
                    "product_id": (
                        match_product(catalogue, item.sku, item.description)
                        if item.line_kind == "product"
                        else None
                    ),
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
            5. Matching to its payment (``invoice_matching.auto_match``): linked only when
               a transaction carries the invoice number and the exact amount

        A duplicate is refused with DuplicateInvoiceError before anything is written: the
        same file (checked before the model reads it) or the same counterparty and number.

        Args:
            entity_id: Business entity UUID
            file_content: Raw file bytes
            mime_type: MIME type
            file_name: Original filename for context
            file_path: Supabase storage path (e.g. "entity_id/timestamp-name.pdf")

        Returns:
            { invoice, contact, line_items, extraction, payment_match }
        """
        # The same file again is refused before the model is paid to read it.
        file_sha256 = hashlib.sha256(file_content).hexdigest()
        await self._refuse_duplicate_file(entity_id, file_sha256)

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
        await self._refuse_duplicate_number(
            entity_id, UUID(contact["id"]), extracted.invoice_number
        )

        # Determine source label: prefer AI-detected platform, fall back to 'manual'
        source_label = extracted.payment_source or "manual"

        # Step 3: Create invoice
        invoice = await self.create_invoice(
            entity_id,
            extracted,
            UUID(contact["id"]),
            source=source_label,
            file_path=file_path,
            file_sha256=file_sha256,
        )
        logger.info(f"Invoice created: {invoice['id']} (source: {source_label})")

        # Step 4: Create line items (pass CoA + type so GL codes can be resolved & validated,
        # and the business so product lines can be matched to its products)
        line_items = await self.create_line_items(
            UUID(invoice["id"]),
            extracted.line_items,
            chart_of_accounts=coa,
            invoice_type=extracted.invoice_type,
            entity_id=entity_id,
        )
        logger.info(f"Created {len(line_items)} line items")

        # Step 5: Match it to its payment, if one confidently fits. A failure here never
        # fails the upload: the invoice is in, and is matched again after the next sync.
        from .invoice_matching import auto_match

        try:
            payment_match = await auto_match(entity_id, UUID(invoice["id"]))
        except Exception as exc:
            logger.warning(f"Matching invoice {invoice['id']} failed: {exc}")
            payment_match = None

        return {
            "invoice": invoice,
            "contact": contact,
            "line_items": line_items,
            "payment_match": payment_match,
            "extraction": {
                "invoice_type": extracted.invoice_type,
                "payment_source": extracted.payment_source,
                "confidence_score": extracted.confidence_score,
                "invoice_number": extracted.invoice_number,
            },
        }

    async def _refuse_duplicate_file(self, entity_id: UUID, file_sha256: str) -> None:
        rows = extract_rows(
            await asyncio.to_thread(
                lambda: self.client.table("invoices")
                .select("id, invoice_number")
                .eq("entity_id", str(entity_id))
                .eq("file_sha256", file_sha256)
                .limit(1)
                .execute()
            )
        )
        if rows:
            raise DuplicateInvoiceError(
                f"This file is already in your invoices as {rows[0]['invoice_number']}.",
                rows[0]["id"],
            )

    async def _refuse_duplicate_number(
        self, entity_id: UUID, counterparty_id: UUID, invoice_number: Optional[str]
    ) -> None:
        if not invoice_number:
            return
        rows = extract_rows(
            await asyncio.to_thread(
                lambda: self.client.table("invoices")
                .select("id, invoice_number")
                .eq("entity_id", str(entity_id))
                .eq("counterparty_id", str(counterparty_id))
                .execute()
            )
        )
        for row in rows:
            if same_number(row.get("invoice_number"), invoice_number):
                raise DuplicateInvoiceError(
                    f"Invoice {row['invoice_number']} from this supplier or customer is "
                    "already in your invoices.",
                    row["id"],
                )

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
        matched_by: Literal["user", "reconciliation", "sync", "auto"] = "user",
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
        the record stays. An invoice read from a receipt can always go (the receipt stays on
        its transaction). Line items and payment links cascade with the invoice.
        """
        invoice = await self._get_owned_invoice(entity_id, invoice_id)
        check_editable(invoice.get("origin"), "delete")
        check_deletable(invoice.get("status") or "", invoice.get("origin"))

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
        line_item_updates: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Update editable invoice fields and optionally line item GL accounts.

        Only ``invoice_type`` and ``notes`` are editable at invoice level, and the type
        only while the invoice is a DRAFT: once it is finalised, which side owes whom is
        settled. Amounts are never editable here.

        ``line_item_gl_updates`` maps ``{line_item_id: gl_account_id_or_null}``. Every
        line must belong to this invoice (an id from another invoice is rejected rather
        than silently re-coded). The accounts describe what each line was for; nothing
        is posted from them.

        ``line_item_updates`` maps ``{line_item_id: {line_kind?, product_id?}}``: what the
        line bought. A product must be one of this business's and makes the line a
        'product' line; a 'sample' or 'other' line has no product. Only the line is written:
        what an invoice bought is shown, it never changes products or stock.
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

        if line_item_gl_updates or line_item_updates:
            own_lines = {li["id"] for li in invoice.get("invoice_line_items") or []}
            foreign = (
                set(line_item_gl_updates or {}) | set(line_item_updates or {})
            ) - own_lines
            if foreign:
                raise InvoiceRuleError(
                    f"{len(foreign)} line item(s) do not belong to this invoice"
                )

        line_patches = await self._line_patches(entity_id, line_item_updates or {})

        if safe_updates:
            await asyncio.to_thread(
                lambda: self.client.table("invoices")
                .update(safe_updates)
                .eq("id", str(invoice_id))
                .execute()
            )

        for li_id, gl_id in (line_item_gl_updates or {}).items():
            line_patches.setdefault(li_id, {})["gl_account_id"] = gl_id

        for li_id, patch in line_patches.items():
            await asyncio.to_thread(
                lambda: self.client.table("invoice_line_items")
                .update(patch)
                .eq("id", li_id)
                .eq("invoice_id", str(invoice_id))
                .execute()
            )

        return await self.get_invoice(invoice_id) or invoice

    async def _line_patches(
        self, entity_id: UUID, updates: Dict[str, Dict[str, Any]]
    ) -> Dict[str, Dict[str, Any]]:
        """The column changes for each line's kind and product, checked before anything is
        written: a product must be this business's, and only a product line has one."""
        wanted = {str(u["product_id"]) for u in updates.values() if u.get("product_id")}
        if wanted:
            rows = await asyncio.to_thread(
                lambda: self.client.table("products")
                .select("id")
                .eq("entity_id", str(entity_id))
                .in_("id", sorted(wanted))
                .execute()
            )
            if wanted - {str(r["id"]) for r in extract_rows(rows)}:
                raise InvoiceRuleError("That product is not one of this business's")

        patches: Dict[str, Dict[str, Any]] = {}
        for line_id, update in updates.items():
            kind = update.get("line_kind")
            if kind is not None and kind not in LINE_KINDS:
                raise InvoiceRuleError(f"Unknown line kind '{kind}'")
            patch: Dict[str, Any] = {}
            if update.get("product_id"):
                if kind not in (None, "product"):
                    raise InvoiceRuleError(
                        "Only a product line can be linked to a product"
                    )
                patch = {
                    "line_kind": "product",
                    "product_id": str(update["product_id"]),
                }
            elif kind in ("sample", "other"):
                patch = {"line_kind": kind, "product_id": None}
            else:
                if kind == "product":
                    patch["line_kind"] = "product"
                if "product_id" in update:  # explicitly unlinked
                    patch["product_id"] = None
            if patch:
                patches[line_id] = patch
        return patches


# Global service instance
invoice_service = InvoiceService()
