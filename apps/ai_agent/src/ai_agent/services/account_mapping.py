"""Centralised chart-of-accounts mapping for the journal system.

This module is the **single source of truth** for mapping logical account
purposes to real account_number values that exist in the ``chart_of_accounts``
table.  All journal-creation code MUST resolve accounts through this module
rather than hard-coding account numbers.

Key design decisions
--------------------
* Header accounts (``is_header = True``) are **never** returned as valid
  postable targets.  Calling ``get_account_id`` for a header will raise.
* The normaliser's legacy ``metadata.account_code`` values (``6200``, ``6300``,
  etc.) are translated to real account numbers via ``NORMALISER_CODE_MAP``.
* ``6999`` (miscellaneous) is **not** a valid fallback — the system will
  attempt intelligent categorisation and, failing that, mark the journal as
  ``draft`` for human review.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List, Optional, Tuple, cast
from uuid import UUID

from ..core.supabase_client import get_supabase_client
from ..normalization.utils import extract_id as _extract_id, extract_rows

logger = logging.getLogger(__name__)

# In-memory cache for account lookups — avoids redundant DB calls when the
# same account number is resolved thousands of times during batch processing.
_account_id_cache: Dict[str, UUID] = {}
_header_accounts: set[str] = set()  # account numbers known to be headers


# ═══════════════════════════════════════════════════════════════════════════════
# JOURNAL-TYPE ACCOUNT CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════
# These are the *real* account numbers that match the user's manually-created
# chart of accounts in Supabase.

# ── Assets ──────────────────────────────────────────────────────────────────
CASH_AND_EQUIVALENTS = "1010"       # Cash & Cash Equivalents
PETTY_CASH = "1011"                 # Petty Cash
MERCHANT_CLEARING = "1012"          # Merchant Services Clearing
PAYPAL_CLEARING = "1013"            # PayPal Clearing Account (legacy — settlements)
PAYPAL_ACCOUNT = "1019"             # PayPal Account (active PayPal balance)
REVOLUT_GBP = "1014"                # Revolut GBP Account
REVOLUT_EUR = "1015"                # Revolut EUR Account
REVOLUT_USD = "1016"                # Revolut USD Account
REVOLUT_SETTLEMENT = "1017"         # Revolut Settlement
ACCOUNTS_RECEIVABLE = "1020"        # Accounts Receivable
VAT_RECEIVABLE = "1050"             # VAT Receivable (input VAT)

# ── Liabilities ─────────────────────────────────────────────────────────────
ACCOUNTS_PAYABLE = "2010"           # Accounts Payable
VAT_PAYABLE = "2030"                # VAT Payable

# ── Revenue ─────────────────────────────────────────────────────────────────
REVENUE_ECOMMERCE = "4020"          # Sales — E-Commerce (DTC)
SHIPPING_REVENUE = "4025"           # Shipping Revenue
REVENUE_WHOLESALE = "4030"          # Sales — Wholesale
REVENUE_MARKETPLACE = "4040"        # Sales — Marketplace
SALES_RETURNS = "4110"              # Sales Returns & Allowances
DISCOUNTS = "4120"                  # Discounts & Promotional Allowances

# ── COGS ────────────────────────────────────────────────────────────────────
COGS_FABRIC = "5010"                # COGS — Fabric & Materials
COGS_CMT = "5020"                   # COGS — CMT / Manufacturing
COGS_TRIMS = "5030"                 # COGS — Trims & Accessories
COGS_PACKAGING = "5040"             # COGS — Labels & Packaging
COGS_FREIGHT_IN = "5050"            # COGS — Freight Inbound
COGS_DUTIES = "5060"                # COGS — Import Duties & Customs
COGS_PRODUCTION_SUPPLIES = "5090"   # COGS — Production Supplies (Amazon/eBay)
COGS_DEFAULT = "5010"               # Default COGS account

# ── Selling Expenses ────────────────────────────────────────────────────────
MARKETING = "6010"                  # Marketing & Advertising
SOCIAL_MEDIA = "6011"               # Social Media & Influencer
PAID_ADS = "6012"                   # Paid Search & Display Advertising
OUTBOUND_SHIPPING = "6020"          # Outbound Freight & Shipping
MARKETPLACE_FEES = "6030"           # Marketplace Fees & Commission
RETURNS_HANDLING = "6040"           # Returns Handling & Processing
PHOTOGRAPHY = "6080"                # Photography & Content Production
PR_PRESS = "6090"                   # PR & Press

# ── General & Administrative ────────────────────────────────────────────────
RENT = "7030"                       # Rent & Occupancy
UTILITIES = "7040"                  # Utilities
INSURANCE = "7050"                  # Insurance
PROFESSIONAL_FEES = "7060"          # Professional Fees
ACCOUNTING_AUDIT = "7061"           # Accounting & Audit
LEGAL_FEES = "7062"                 # Legal Fees
TECHNOLOGY_SAAS = "7070"            # Technology & SaaS Subscriptions
OFFICE_SUPPLIES = "7090"            # Office & General Supplies
TRAVEL_ENTERTAINMENT = "7100"       # Travel & Entertainment

# ── Other Expenses ──────────────────────────────────────────────────────────
INTEREST_EXPENSE = "8010"           # Interest Expense
BANK_CHARGES = "8020"               # Bank Charges & Payment Fees
FX_LOSS = "8030"                    # Foreign Exchange Loss
MISCELLANEOUS_EXPENSE = "8090"      # Miscellaneous Expense (pending reclassification)

# ── Equity ──────────────────────────────────────────────────────────────────
OWNER_CAPITAL = "3050"              # Owner's Capital Introduced

# ── Director & Related Party ─────────────────────────────────────────────────
DIRECTORS_LOAN = "2230"             # Director's Loan Account (DLA) — personal funds / top-ups


# ═══════════════════════════════════════════════════════════════════════════════
# NORMALISER LEGACY CODE → REAL ACCOUNT MAP
# ═══════════════════════════════════════════════════════════════════════════════
# The Revolut normaliser historically wrote these codes into
# metadata.account_code.  This table translates them to real account numbers.

NORMALISER_CODE_MAP: Dict[str, str] = {
    "2000": ACCOUNTS_PAYABLE,            # → 2010
    "5000": COGS_DEFAULT,                # → 5010
    "5100": COGS_FABRIC,                 # → 5010  (materials)
    "6100": MARKETING,                   # → 6010
    "6200": OUTBOUND_SHIPPING,           # → 6020
    "6300": TECHNOLOGY_SAAS,             # → 7070
    "6400": RENT,                        # → 7030  (rent default; utilities handled via category)
    "6500": PROFESSIONAL_FEES,           # → 7060  (payroll/contractors – closest match)
    "6600": PROFESSIONAL_FEES,           # → 7060
    "6700": INSURANCE,                   # → 7050
    "6800": OFFICE_SUPPLIES,             # → 7090  (default for multi-use code)
    "6900": BANK_CHARGES,                # → 8020
    # 6999 is intentionally ABSENT – never use miscellaneous as a fallback
}


# ═══════════════════════════════════════════════════════════════════════════════
# EXPENSE CATEGORY → REAL ACCOUNT MAP
# ═══════════════════════════════════════════════════════════════════════════════
# The normaliser also writes an expense_category string.  This is often more
# specific than the legacy code, so we prefer it.

CATEGORY_ACCOUNT_MAP: Dict[str, Optional[str]] = {
    "product_purchase": COGS_DEFAULT,           # 5010
    "materials": COGS_FABRIC,                   # 5010
    "marketing": MARKETING,                     # 6010
    "advertising": PAID_ADS,                    # 6012
    "outbound_shipping": OUTBOUND_SHIPPING,     # 6020
    "software": TECHNOLOGY_SAAS,                # 7070
    "rent": RENT,                               # 7030
    "utilities": UTILITIES,                     # 7040
    "payroll": "7014",                          # Salaries — Management & Directors
    "contractors": PROFESSIONAL_FEES,           # 7060
    "professional_services": PROFESSIONAL_FEES, # 7060
    "legal": LEGAL_FEES,                        # 7062
    "accounting": ACCOUNTING_AUDIT,             # 7061
    "insurance": INSURANCE,                     # 7050
    "office_supplies": OFFICE_SUPPLIES,         # 7090
    "travel": TRAVEL_ENTERTAINMENT,             # 7100
    "meals": TRAVEL_ENTERTAINMENT,              # 7100
    "entertainment": TRAVEL_ENTERTAINMENT,      # 7100
    "bank_charges": BANK_CHARGES,               # 8020
    "accounts_payable": ACCOUNTS_PAYABLE,       # 2010
    "miscellaneous": None,                      # Explicitly None — skip to keyword match
}

# Single account used when no category, code, keyword, or type rule matches.
# Journals using this account are always marked "draft" for user reclassification.
UNCATEGORISED_FALLBACK = MISCELLANEOUS_EXPENSE


# ═══════════════════════════════════════════════════════════════════════════════
# KEYWORD-BASED EXPENSE CATEGORISER
# ═══════════════════════════════════════════════════════════════════════════════
# When the normaliser didn't tag a transaction (e.g. transfers, PayPal txns),
# we fall back to keyword matching on the description / counterparty name.
#
# Rules are evaluated top-to-bottom; first match wins.

_KEYWORD_RULES: List[Tuple[re.Pattern, str]] = [
    # ── Vendor-specific rules (highest priority) ────────────────────────────
    (re.compile(r"\b(46678xbqa|wellsuc7tb4|wellsucceed\s*embroidery)\b", re.I), COGS_DEFAULT),  # Inventory purchase
    (re.compile(r"\b4filment\b", re.I), OUTBOUND_SHIPPING),  # Warehouse distributor shipping

    # ── Import fees / duties (UPS etc.) ─────────────────────────────────────
    (re.compile(r"\bups\b", re.I), COGS_DUTIES),  # UPS = import/customs fees

    # ── Shipping / logistics ────────────────────────────────────────────────
    (re.compile(r"\b(dhl|fedex|dpd|evri|hermes|royal\s*mail|parcelforce|yodel)\b", re.I), OUTBOUND_SHIPPING),
    (re.compile(r"\b(shipping|freight|courier|postage|parcel)\b", re.I), OUTBOUND_SHIPPING),

    # ── SaaS / Software ────────────────────────────────────────────────────
    (re.compile(r"\b(shopify|squarespace|notion|figma|canva|adobe|slack|zoom|dropbox|github|aws|google\s*workspace|microsoft|openai|anthropic|vercel|netlify|heroku|lightricks)\b", re.I), TECHNOLOGY_SAAS),
    (re.compile(r"\b(saas|subscription|software|app\s*store|google\s*play)\b", re.I), TECHNOLOGY_SAAS),

    # ── Marketing / Advertising ─────────────────────────────────────────────
    (re.compile(r"\b(google\s*ads?|meta\s*ads?|facebook|instagram|tiktok|mailchimp|klaviyo|hubspot|semrush)\b", re.I), MARKETING),
    (re.compile(r"\b(advertising|advert|promo|campaign|seo|ppc)\b", re.I), MARKETING),

    # ── Marketplace fees ────────────────────────────────────────────────────
    (re.compile(r"\b(asos|amazon\s*(seller|fees)|ebay\s*(fees|managed))\b", re.I), MARKETPLACE_FEES),

    # ── Materials / product sourcing ────────────────────────────────────────
    (re.compile(r"\b(fabric|textile|yarn|thread|dye|trim|button|zipper|lining|leather)\b", re.I), COGS_FABRIC),
    (re.compile(r"\b(manufacturer|cmt|garment\s*tech|factory|sampling)\b", re.I), COGS_CMT),
    (re.compile(r"\b(packaging|label|tag|tissue\s*paper|box|poly\s*bag)\b", re.I), COGS_PACKAGING),

    # ── Professional services ───────────────────────────────────────────────
    (re.compile(r"\b(accountant|accounting|audit|bookkeep|xero|quickbooks|freeagent)\b", re.I), ACCOUNTING_AUDIT),
    (re.compile(r"\b(solicitor|lawyer|legal|law\s*firm|ip\s*protect)\b", re.I), LEGAL_FEES),
    (re.compile(r"\b(consult|advisory|freelance|contractor)\b", re.I), PROFESSIONAL_FEES),

    # ── Office / general ────────────────────────────────────────────────────
    (re.compile(r"\b(stationery|printing|ink|paper|office\s*depot|staples)\b", re.I), OFFICE_SUPPLIES),
    (re.compile(r"\b(amazon|ebay)\b", re.I), COGS_PRODUCTION_SUPPLIES),  # Amazon/eBay = production supplies

    # ── Travel & entertainment ──────────────────────────────────────────────
    (re.compile(r"\b(hotel|airbnb|booking\.com|flight|airline|trainline|uber|taxi|cab)\b", re.I), TRAVEL_ENTERTAINMENT),
    (re.compile(r"\b(restaurant|cafe|coffee|deliveroo|just\s*eat|uber\s*eats)\b", re.I), TRAVEL_ENTERTAINMENT),

    # ── Rent / occupancy ────────────────────────────────────────────────────
    (re.compile(r"\b(rent|lease|landlord|rates|council\s*tax)\b", re.I), RENT),

    # ── Utilities ───────────────────────────────────────────────────────────
    (re.compile(r"\b(electric|gas|water|energy|british\s*gas|edf|octopus|bulb)\b", re.I), UTILITIES),

    # ── Insurance ───────────────────────────────────────────────────────────
    (re.compile(r"\b(insurance|insure|hiscox|simply\s*business|zurich)\b", re.I), INSURANCE),

    # ── Bank charges / fees ─────────────────────────────────────────────────
    (re.compile(r"\b(bank\s*(fee|charge)|payment\s*fee|card\s*fee|stripe\s*fee|plan\s*fee)\b", re.I), BANK_CHARGES),
    (re.compile(r"\b(capital\s*on\s*tap|amex|revolut|monzo)\b", re.I), BANK_CHARGES),

    # ── Photography / content ───────────────────────────────────────────────
    (re.compile(r"\b(photograph|studio\s*hire|model\s*agency|lookbook|videograph)\b", re.I), PHOTOGRAPHY),

    # ── PR / Press ──────────────────────────────────────────────────────────
    (re.compile(r"\b(pr\s*agency|press|media\s*relation|vogue|elle|conde\s*nast)\b", re.I), PR_PRESS),

    # ── Tax payments (HMRC) ─────────────────────────────────────────────────
    (re.compile(r"\bhmrc\b", re.I), VAT_PAYABLE),  # VAT/Corp tax → liability
    (re.compile(r"\b(corporation\s*tax|vat\s*payment)\b", re.I), VAT_PAYABLE),

    # ── Interest ────────────────────────────────────────────────────────────
    (re.compile(r"\b(interest|loan\s*repay|overdraft)\b", re.I), INTEREST_EXPENSE),
]


# ═══════════════════════════════════════════════════════════════════════════════
# ACCOUNT → HUMAN-READABLE LABEL
# ═══════════════════════════════════════════════════════════════════════════════
# Used by the journal service to produce accurate descriptions that reflect the
# *resolved* account, not the normaliser's original (possibly wrong) category.

ACCOUNT_LABEL: Dict[str, str] = {
    COGS_DEFAULT: "materials",
    COGS_FABRIC: "fabrics & materials",
    COGS_CMT: "manufacturing",
    COGS_TRIMS: "trims & accessories",
    COGS_PACKAGING: "packaging",
    COGS_FREIGHT_IN: "inbound freight",
    COGS_DUTIES: "import duties",
    MARKETING: "marketing",
    SOCIAL_MEDIA: "social media",
    PAID_ADS: "advertising",
    OUTBOUND_SHIPPING: "shipping",
    MARKETPLACE_FEES: "marketplace fees",
    RETURNS_HANDLING: "returns handling",
    PHOTOGRAPHY: "photography",
    PR_PRESS: "PR & press",
    RENT: "rent",
    UTILITIES: "utilities",
    INSURANCE: "insurance",
    PROFESSIONAL_FEES: "professional fees",
    ACCOUNTING_AUDIT: "accounting",
    LEGAL_FEES: "legal",
    TECHNOLOGY_SAAS: "software & SaaS",
    OFFICE_SUPPLIES: "office supplies",
    TRAVEL_ENTERTAINMENT: "travel & entertainment",
    INTEREST_EXPENSE: "interest",
    BANK_CHARGES: "bank charges",
    FX_LOSS: "FX loss",
    MISCELLANEOUS_EXPENSE: "miscellaneous expense",
    VAT_PAYABLE: "tax payment",
    SALES_RETURNS: "sales return",
    SHIPPING_REVENUE: "shipping revenue",
    COGS_PRODUCTION_SUPPLIES: "production supplies",
    PAYPAL_ACCOUNT: "PayPal balance",
    OWNER_CAPITAL: "owner's capital introduced",
}


# ═══════════════════════════════════════════════════════════════════════════════
# PUBLIC API
# ═══════════════════════════════════════════════════════════════════════════════


def resolve_cash_account(source: str, currency: Optional[str] = None) -> str:
    """Return the correct cash/bank account for a given provider + currency.

    Args:
        source: ``"revolut"`` or ``"paypal"``
        currency: ISO currency code (used for Revolut multi-currency accounts)

    Returns:
        Real account_number string
    """
    if source == "paypal":
        return PAYPAL_ACCOUNT

    # Revolut — pick account by currency
    cur = (currency or "GBP").upper()
    return {
        "GBP": REVOLUT_GBP,
        "EUR": REVOLUT_EUR,
        "USD": REVOLUT_USD,
    }.get(cur, REVOLUT_GBP)


def resolve_expense_account(
    metadata: Optional[Dict[str, Any]] = None,
    description: Optional[str] = None,
    counterparty: Optional[str] = None,
    transaction_type: Optional[str] = None,
    amount: Optional[float] = None,
) -> str:
    """Intelligently resolve the correct expense account for a transaction.

    Resolution order (first match wins):
    1. ``metadata.expense_category`` via :data:`CATEGORY_ACCOUNT_MAP`
    2. ``metadata.account_code`` via :data:`NORMALISER_CODE_MAP`
    3. ``metadata.invoice_id`` semantic patterns (CLICKANDDROP, PISSX, UPS tracking)
    4. Keyword match on ``description`` / ``counterparty``
    5. Special case by ``transaction_type`` (fee → bank charges, refund → returns)
    6. :data:`UNCATEGORISED_FALLBACK` (8090 Miscellaneous Expense) — caller marks journal as ``draft``

    Args:
        metadata:  Transaction metadata dict (may contain account_code,
                   expense_category, invoice_id keys)
        description:  Transaction description text
        counterparty:  Counterparty / merchant name
        transaction_type:  The normalised transaction_type
        amount:  Absolute transaction amount (used for PISSX sampling threshold)

    Returns:
        account_number string, or ``None`` if uncategorisable
    """
    meta = metadata or {}

    # 1. Try expense_category → real account
    category = meta.get("expense_category")
    if category and category != "miscellaneous":
        acct = CATEGORY_ACCOUNT_MAP.get(category)
        if acct:
            return acct

    # 2. Try legacy normaliser account_code → real account
    code = meta.get("account_code")
    if code and code != "6999":
        acct = NORMALISER_CODE_MAP.get(code)
        if acct:
            return acct

    # 3. Semantic patterns from metadata.invoice_id
    #    PayPal transactions carry an invoice reference that reveals the vendor /
    #    purpose even when the description is an opaque reference code.
    inv_ref = str(meta.get("invoice_id") or "").strip()
    if inv_ref:
        inv_ref_upper = inv_ref.upper()

        # Royal Mail Click & Drop — outbound shipping label purchase
        if "CLICKANDDROP" in inv_ref_upper:
            return OUTBOUND_SHIPPING

        # PISSX prefix — inventory purchase or sampling order
        if "PISSX" in inv_ref_upper:
            # Small amounts (< £/$/€300) are typically sampling runs
            if amount is not None and float(amount) < 300:
                return COGS_CMT  # sampling / small production run
            return COGS_DEFAULT  # full inventory / bulk purchase

        # UPS tracking numbers start with "1Z" (import duties billed via PayPal)
        if re.match(r"^1Z[A-Z0-9]{10,}", inv_ref_upper):
            return COGS_DUTIES

    # 4. Keyword match on description + counterparty
    search_text = " ".join(filter(None, [description, counterparty]))
    if search_text:
        for pattern, account in _KEYWORD_RULES:
            if pattern.search(search_text):
                return account

    # 5. Special cases by transaction type
    if transaction_type == "fee":
        return BANK_CHARGES  # Fees are almost always bank/payment charges
    if transaction_type == "refund":
        return SALES_RETURNS  # Refund outflows → deduction from revenue

    # Could not determine — return the miscellaneous fallback
    return UNCATEGORISED_FALLBACK


async def get_account_id(
    account_number: str,
    *,
    allow_header: bool = False,
) -> Optional[UUID]:
    """Look up a chart-of-accounts UUID by ``account_number``.

    Results are cached in-memory so repeated lookups (e.g. the same revenue
    account across 1 000 accrual journals) only hit the database once.

    Args:
        account_number: The real account number (e.g. ``"1014"``)
        allow_header: If ``False`` (default), raises if the account is a header

    Returns:
        The account UUID, or ``None`` if not found

    Raises:
        ValueError: If the account is a header and ``allow_header`` is ``False``
    """
    # Fast-path: already cached
    if account_number in _account_id_cache:
        if account_number in _header_accounts and not allow_header:
            raise ValueError(
                f"Account {account_number} is a header account and cannot be posted to."
            )
        return _account_id_cache[account_number]

    client = get_supabase_client()
    if client is None:
        raise RuntimeError("Supabase client not configured")

    result = await asyncio.to_thread(
        lambda: client.table("chart_of_accounts")
        .select("id, is_header")
        .eq("account_number", account_number)
        .execute()
    )

    if not result.data:
        logger.warning("Account %s not found in chart_of_accounts", account_number)
        return None

    row: Dict[str, Any] = cast(Dict[str, Any], result.data[0])
    uid = UUID(str(row["id"]))

    # Cache the result
    _account_id_cache[account_number] = uid
    if row.get("is_header"):
        _header_accounts.add(account_number)

    if row.get("is_header") and not allow_header:
        raise ValueError(
            f"Account {account_number} ({row.get('name', '?')}) is a header account "
            "and cannot be posted to. Use a sub-account instead."
        )

    return uid


def clear_account_cache():
    """Clear the in-memory account cache (e.g. after chart-of-accounts changes)."""
    _account_id_cache.clear()
    _header_accounts.clear()


async def validate_account_exists(account_number: str) -> bool:
    """Quick check that a postable (non-header) account exists."""
    try:
        aid = await get_account_id(account_number)
        return aid is not None
    except ValueError:
        return False
