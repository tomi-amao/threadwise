/**
 * Collection planning — shared types, constants, and projection math.
 *
 * Deliberately has no `.server` suffix and does no I/O: CollectionPlanPanel
 * (a client component) needs COLLABORATION_TYPES/PLAN_COST_CATEGORIES to
 * render dropdowns and computePlanProjections() to recompute totals live as
 * the user edits, so none of this can live in a *.server.ts module — those
 * are stripped from the client bundle. Server-only I/O (the single-collection
 * fetch for the printable pack) lives separately in
 * lib/api/collection-plans.server.ts, which imports from here.
 */

// Same vocabulary toCostTypeFromAccount() (app.collections.tsx) already
// slugifies real posted transactions into, so a planned-vs-actual-by-category
// comparison lines up without a translation layer.
export const PLAN_COST_CATEGORIES = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'cmt', label: 'Manufacturing (CMT)' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'freight_in', label: 'Freight in' },
  { value: 'samples', label: 'Samples' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'social_media', label: 'Social media' },
  { value: 'paid_ads', label: 'Paid ads' },
  { value: 'outbound_shipping', label: 'Outbound shipping' },
  { value: 'marketplace_fees', label: 'Marketplace fees' },
  { value: 'gifting', label: 'Gifting / PR' },
  { value: 'other', label: 'Other' },
] as const;

// Seeded onto every new plan (see create_plan in app.collections.tsx's
// action) so a collaboration partner sees the full cost category list
// upfront — including the categories that don't have a number yet — rather
// than being surprised by a cost that only shows up once it's known.
// Categories, not fixed amounts: each is created with planned_amount null,
// shown as "to be determined" until someone fills one in.
// "gifting" is deliberately not a default here — gifted units are now
// entered per product line (CollectionPlanLine.giftedUnits) and reduce
// projected revenue directly, so a separate TBD cost placeholder for the
// same thing would just be redundant/confusing. "Gifting / PR" stays
// selectable in PLAN_COST_CATEGORIES above for a genuine cash cost (e.g.
// gift packaging) that isn't captured by the per-line reduction.
export const DEFAULT_PLAN_COST_CATEGORIES = ['freight_in', 'outbound_shipping'];

export const COLLABORATION_TYPES = [
  { value: 'in_house', label: 'In-house (no partner)' },
  { value: 'wholesale', label: 'Wholesale / bulk purchase' },
  { value: 'co_branded', label: 'Co-branded / capsule collection' },
  { value: 'revenue_share', label: 'Revenue share' },
  { value: 'pop_up', label: 'Pop-up / retail takeover' },
] as const;

/**
 * A business name made possessive, for sentences both parties read ("Atelier North's share",
 * "Moss & Co's"). A plan is read by the business and by its partner, so it names them rather
 * than saying "you" or "they".
 */
export const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

export function collaborationTypeLabel(value: string): string {
  return COLLABORATION_TYPES.find(type => type.value === value)?.label ?? value;
}

// Exactly the currencies fetchFxRate's provider (open.er-api.com) can
// actually quote a rate for — cross-checked directly against its live
// /latest response, not a generic ISO 4217 list, so a partner currency
// picked here is never a dead end at print/view time. value/label is the
// code (what the dropdown's closed state and search-by-code both want);
// meta is the full name, shown as the secondary line and also searchable.
export const CURRENCY_OPTIONS: { value: string; label: string; meta: string }[] = [
  { value: 'AED', label: 'AED', meta: 'United Arab Emirates Dirham' },
  { value: 'AFN', label: 'AFN', meta: 'Afghan Afghani' },
  { value: 'ALL', label: 'ALL', meta: 'Albanian Lek' },
  { value: 'AMD', label: 'AMD', meta: 'Armenian Dram' },
  { value: 'ANG', label: 'ANG', meta: 'Netherlands Antillean Guilder' },
  { value: 'AOA', label: 'AOA', meta: 'Angolan Kwanza' },
  { value: 'ARS', label: 'ARS', meta: 'Argentine Peso' },
  { value: 'AUD', label: 'AUD', meta: 'Australian Dollar' },
  { value: 'AWG', label: 'AWG', meta: 'Aruban Florin' },
  { value: 'AZN', label: 'AZN', meta: 'Azerbaijani Manat' },
  { value: 'BAM', label: 'BAM', meta: 'Bosnia-Herzegovina Convertible Mark' },
  { value: 'BBD', label: 'BBD', meta: 'Barbadian Dollar' },
  { value: 'BDT', label: 'BDT', meta: 'Bangladeshi Taka' },
  { value: 'BGN', label: 'BGN', meta: 'Bulgarian Lev' },
  { value: 'BHD', label: 'BHD', meta: 'Bahraini Dinar' },
  { value: 'BIF', label: 'BIF', meta: 'Burundian Franc' },
  { value: 'BMD', label: 'BMD', meta: 'Bermudan Dollar' },
  { value: 'BND', label: 'BND', meta: 'Brunei Dollar' },
  { value: 'BOB', label: 'BOB', meta: 'Bolivian Boliviano' },
  { value: 'BRL', label: 'BRL', meta: 'Brazilian Real' },
  { value: 'BSD', label: 'BSD', meta: 'Bahamian Dollar' },
  { value: 'BTN', label: 'BTN', meta: 'Bhutanese Ngultrum' },
  { value: 'BWP', label: 'BWP', meta: 'Botswanan Pula' },
  { value: 'BYN', label: 'BYN', meta: 'Belarusian Ruble' },
  { value: 'BZD', label: 'BZD', meta: 'Belize Dollar' },
  { value: 'CAD', label: 'CAD', meta: 'Canadian Dollar' },
  { value: 'CDF', label: 'CDF', meta: 'Congolese Franc' },
  { value: 'CHF', label: 'CHF', meta: 'Swiss Franc' },
  { value: 'CLF', label: 'CLF', meta: 'Chilean Unit of Account (UF)' },
  { value: 'CLP', label: 'CLP', meta: 'Chilean Peso' },
  { value: 'CNH', label: 'CNH', meta: 'Chinese Yuan (Offshore)' },
  { value: 'CNY', label: 'CNY', meta: 'Chinese Yuan' },
  { value: 'COP', label: 'COP', meta: 'Colombian Peso' },
  { value: 'CRC', label: 'CRC', meta: 'Costa Rican Colón' },
  { value: 'CUP', label: 'CUP', meta: 'Cuban Peso' },
  { value: 'CVE', label: 'CVE', meta: 'Cape Verdean Escudo' },
  { value: 'CZK', label: 'CZK', meta: 'Czech Republic Koruna' },
  { value: 'DJF', label: 'DJF', meta: 'Djiboutian Franc' },
  { value: 'DKK', label: 'DKK', meta: 'Danish Krone' },
  { value: 'DOP', label: 'DOP', meta: 'Dominican Peso' },
  { value: 'DZD', label: 'DZD', meta: 'Algerian Dinar' },
  { value: 'EGP', label: 'EGP', meta: 'Egyptian Pound' },
  { value: 'ERN', label: 'ERN', meta: 'Eritrean Nakfa' },
  { value: 'ETB', label: 'ETB', meta: 'Ethiopian Birr' },
  { value: 'EUR', label: 'EUR', meta: 'Euro' },
  { value: 'FJD', label: 'FJD', meta: 'Fijian Dollar' },
  { value: 'FKP', label: 'FKP', meta: 'Falkland Islands Pound' },
  { value: 'FOK', label: 'FOK', meta: 'Faroese Krona' },
  { value: 'GBP', label: 'GBP', meta: 'British Pound Sterling' },
  { value: 'GEL', label: 'GEL', meta: 'Georgian Lari' },
  { value: 'GGP', label: 'GGP', meta: 'Guernsey Pound' },
  { value: 'GHS', label: 'GHS', meta: 'Ghanaian Cedi' },
  { value: 'GIP', label: 'GIP', meta: 'Gibraltar Pound' },
  { value: 'GMD', label: 'GMD', meta: 'Gambian Dalasi' },
  { value: 'GNF', label: 'GNF', meta: 'Guinean Franc' },
  { value: 'GTQ', label: 'GTQ', meta: 'Guatemalan Quetzal' },
  { value: 'GYD', label: 'GYD', meta: 'Guyanaese Dollar' },
  { value: 'HKD', label: 'HKD', meta: 'Hong Kong Dollar' },
  { value: 'HNL', label: 'HNL', meta: 'Honduran Lempira' },
  { value: 'HRK', label: 'HRK', meta: 'Croatian Kuna' },
  { value: 'HTG', label: 'HTG', meta: 'Haitian Gourde' },
  { value: 'HUF', label: 'HUF', meta: 'Hungarian Forint' },
  { value: 'IDR', label: 'IDR', meta: 'Indonesian Rupiah' },
  { value: 'ILS', label: 'ILS', meta: 'Israeli New Sheqel' },
  { value: 'IMP', label: 'IMP', meta: 'Manx pound' },
  { value: 'INR', label: 'INR', meta: 'Indian Rupee' },
  { value: 'IQD', label: 'IQD', meta: 'Iraqi Dinar' },
  { value: 'IRR', label: 'IRR', meta: 'Iranian Rial' },
  { value: 'ISK', label: 'ISK', meta: 'Icelandic Króna' },
  { value: 'JEP', label: 'JEP', meta: 'Jersey Pound' },
  { value: 'JMD', label: 'JMD', meta: 'Jamaican Dollar' },
  { value: 'JOD', label: 'JOD', meta: 'Jordanian Dinar' },
  { value: 'JPY', label: 'JPY', meta: 'Japanese Yen' },
  { value: 'KES', label: 'KES', meta: 'Kenyan Shilling' },
  { value: 'KGS', label: 'KGS', meta: 'Kyrgystani Som' },
  { value: 'KHR', label: 'KHR', meta: 'Cambodian Riel' },
  { value: 'KID', label: 'KID', meta: 'Kiribati Dollar' },
  { value: 'KMF', label: 'KMF', meta: 'Comorian Franc' },
  { value: 'KRW', label: 'KRW', meta: 'South Korean Won' },
  { value: 'KWD', label: 'KWD', meta: 'Kuwaiti Dinar' },
  { value: 'KYD', label: 'KYD', meta: 'Cayman Islands Dollar' },
  { value: 'KZT', label: 'KZT', meta: 'Kazakhstani Tenge' },
  { value: 'LAK', label: 'LAK', meta: 'Laotian Kip' },
  { value: 'LBP', label: 'LBP', meta: 'Lebanese Pound' },
  { value: 'LKR', label: 'LKR', meta: 'Sri Lankan Rupee' },
  { value: 'LRD', label: 'LRD', meta: 'Liberian Dollar' },
  { value: 'LSL', label: 'LSL', meta: 'Lesotho Loti' },
  { value: 'LYD', label: 'LYD', meta: 'Libyan Dinar' },
  { value: 'MAD', label: 'MAD', meta: 'Moroccan Dirham' },
  { value: 'MDL', label: 'MDL', meta: 'Moldovan Leu' },
  { value: 'MGA', label: 'MGA', meta: 'Malagasy Ariary' },
  { value: 'MKD', label: 'MKD', meta: 'Macedonian Denar' },
  { value: 'MMK', label: 'MMK', meta: 'Myanma Kyat' },
  { value: 'MNT', label: 'MNT', meta: 'Mongolian Tugrik' },
  { value: 'MOP', label: 'MOP', meta: 'Macanese Pataca' },
  { value: 'MRU', label: 'MRU', meta: 'Mauritanian Ouguiya' },
  { value: 'MUR', label: 'MUR', meta: 'Mauritian Rupee' },
  { value: 'MVR', label: 'MVR', meta: 'Maldivian Rufiyaa' },
  { value: 'MWK', label: 'MWK', meta: 'Malawian Kwacha' },
  { value: 'MXN', label: 'MXN', meta: 'Mexican Peso' },
  { value: 'MYR', label: 'MYR', meta: 'Malaysian Ringgit' },
  { value: 'MZN', label: 'MZN', meta: 'Mozambican Metical' },
  { value: 'NAD', label: 'NAD', meta: 'Namibian Dollar' },
  { value: 'NGN', label: 'NGN', meta: 'Nigerian Naira' },
  { value: 'NIO', label: 'NIO', meta: 'Nicaraguan Córdoba' },
  { value: 'NOK', label: 'NOK', meta: 'Norwegian Krone' },
  { value: 'NPR', label: 'NPR', meta: 'Nepalese Rupee' },
  { value: 'NZD', label: 'NZD', meta: 'New Zealand Dollar' },
  { value: 'OMR', label: 'OMR', meta: 'Omani Rial' },
  { value: 'PAB', label: 'PAB', meta: 'Panamanian Balboa' },
  { value: 'PEN', label: 'PEN', meta: 'Peruvian Nuevo Sol' },
  { value: 'PGK', label: 'PGK', meta: 'Papua New Guinean Kina' },
  { value: 'PHP', label: 'PHP', meta: 'Philippine Peso' },
  { value: 'PKR', label: 'PKR', meta: 'Pakistani Rupee' },
  { value: 'PLN', label: 'PLN', meta: 'Polish Zloty' },
  { value: 'PYG', label: 'PYG', meta: 'Paraguayan Guarani' },
  { value: 'QAR', label: 'QAR', meta: 'Qatari Rial' },
  { value: 'RON', label: 'RON', meta: 'Romanian Leu' },
  { value: 'RSD', label: 'RSD', meta: 'Serbian Dinar' },
  { value: 'RUB', label: 'RUB', meta: 'Russian Ruble' },
  { value: 'RWF', label: 'RWF', meta: 'Rwandan Franc' },
  { value: 'SAR', label: 'SAR', meta: 'Saudi Riyal' },
  { value: 'SBD', label: 'SBD', meta: 'Solomon Islands Dollar' },
  { value: 'SCR', label: 'SCR', meta: 'Seychellois Rupee' },
  { value: 'SDG', label: 'SDG', meta: 'Sudanese Pound' },
  { value: 'SEK', label: 'SEK', meta: 'Swedish Krona' },
  { value: 'SGD', label: 'SGD', meta: 'Singapore Dollar' },
  { value: 'SHP', label: 'SHP', meta: 'Saint Helena Pound' },
  { value: 'SLE', label: 'SLE', meta: 'Sierra Leonean Leone' },
  { value: 'SLL', label: 'SLL', meta: 'Sierra Leonean Leone (Old)' },
  { value: 'SOS', label: 'SOS', meta: 'Somali Shilling' },
  { value: 'SRD', label: 'SRD', meta: 'Surinamese Dollar' },
  { value: 'SSP', label: 'SSP', meta: 'South Sudanese Pound' },
  { value: 'STN', label: 'STN', meta: 'São Tomé and Príncipe Dobra' },
  { value: 'SYP', label: 'SYP', meta: 'Syrian Pound' },
  { value: 'SZL', label: 'SZL', meta: 'Swazi Lilangeni' },
  { value: 'THB', label: 'THB', meta: 'Thai Baht' },
  { value: 'TJS', label: 'TJS', meta: 'Tajikistani Somoni' },
  { value: 'TMT', label: 'TMT', meta: 'Turkmenistani Manat' },
  { value: 'TND', label: 'TND', meta: 'Tunisian Dinar' },
  { value: 'TOP', label: 'TOP', meta: "Tongan Pa'anga" },
  { value: 'TRY', label: 'TRY', meta: 'Turkish Lira' },
  { value: 'TTD', label: 'TTD', meta: 'Trinidad and Tobago Dollar' },
  { value: 'TVD', label: 'TVD', meta: 'Tuvaluan Dollar' },
  { value: 'TWD', label: 'TWD', meta: 'New Taiwan Dollar' },
  { value: 'TZS', label: 'TZS', meta: 'Tanzanian Shilling' },
  { value: 'UAH', label: 'UAH', meta: 'Ukrainian Hryvnia' },
  { value: 'UGX', label: 'UGX', meta: 'Ugandan Shilling' },
  { value: 'USD', label: 'USD', meta: 'United States Dollar' },
  { value: 'UYU', label: 'UYU', meta: 'Uruguayan Peso' },
  { value: 'UZS', label: 'UZS', meta: 'Uzbekistan Som' },
  { value: 'VES', label: 'VES', meta: 'Venezuelan Bolívar Soberano' },
  { value: 'VND', label: 'VND', meta: 'Vietnamese Dong' },
  { value: 'VUV', label: 'VUV', meta: 'Vanuatu Vatu' },
  { value: 'WST', label: 'WST', meta: 'Samoan Tala' },
  { value: 'XAF', label: 'XAF', meta: 'CFA Franc BEAC' },
  { value: 'XCD', label: 'XCD', meta: 'East Caribbean Dollar' },
  { value: 'XCG', label: 'XCG', meta: 'Caribbean Guilder' },
  { value: 'XDR', label: 'XDR', meta: 'Special Drawing Rights' },
  { value: 'XOF', label: 'XOF', meta: 'CFA Franc BCEAO' },
  { value: 'XPF', label: 'XPF', meta: 'CFP Franc' },
  { value: 'YER', label: 'YER', meta: 'Yemeni Rial' },
  { value: 'ZAR', label: 'ZAR', meta: 'South African Rand' },
  { value: 'ZMW', label: 'ZMW', meta: 'Zambian Kwacha' },
  { value: 'ZWG', label: 'ZWG', meta: 'Zimbabwean ZiG' },
  { value: 'ZWL', label: 'ZWL', meta: 'Zimbabwean Dollar' },
];

// ─── Types ────────────────────────────────────────────────────────────────

/** One size of a plan line and the units planned in it. */
export interface PlanSizeQuantity {
  size: string;
  quantity: number;
}

export const MAX_PLAN_SIZES = 20;
export const MAX_SIZE_LABEL_LENGTH = 20;

/**
 * Read a stored size split (JSON from the database or the form) into clean rows: trimmed labels,
 * whole positive quantities, each size once (case-insensitive, first wins). Anything else is
 * dropped, so a line never carries a broken split into the projections.
 */
export function parseSizeQuantities(value: unknown): PlanSizeQuantity[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: PlanSizeQuantity[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { size, quantity } = item as { size?: unknown; quantity?: unknown };
    const label = typeof size === 'string' ? size.trim() : '';
    const units = Number(quantity);
    if (!label || label.length > MAX_SIZE_LABEL_LENGTH) continue;
    if (!Number.isInteger(units) || units <= 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ size: label, quantity: units });
  }
  return rows.slice(0, MAX_PLAN_SIZES);
}

export const sizesTotal = (sizes: PlanSizeQuantity[]): number =>
  sizes.reduce((sum, row) => sum + row.quantity, 0);

/** "S 20 · M 40 · L 30", or an empty string when the line has no split. */
export const formatSizes = (sizes: PlanSizeQuantity[]): string =>
  sizes.map(row => `${row.size} ${row.quantity}`).join(' · ');

export interface CollectionPlanLine {
  id: string;
  planId: string;
  productId: string | null;
  productName: string | null;
  linkedProductName: string | null;
  plannedQuantity: number;
  /** How plannedQuantity splits by size; empty when the line is one quantity. When present,
   * plannedQuantity is their sum (kept so on save), so projections need not know about sizes. */
  sizeQuantities: PlanSizeQuantity[];
  /** Units of this line given away for free (PR/influencer/partner gifting)
   * rather than sold — always sold, not an estimate. Still incurs full COGS
   * (plannedQuantity includes them — you paid to produce them), but earns
   * no revenue, so it's subtracted from the sellable pool before
   * expectedSellThroughPct is applied. */
  giftedUnits: number;
  /** Always the plan's own base currency — the authoritative figure every
   * projection is computed from, converted once at entry time if the
   * supplier quoted in a different currency (see unitCostCurrency below). */
  unitCost: number;
  unitSellingPrice: number;
  expectedSellThroughPct: number;
  notes: string | null;
  displayOrder: number | null;
  /** Null means unitCost was entered directly in the plan's own currency —
   * no conversion happened. Set together with unitCostOriginal. */
  unitCostCurrency: string | null;
  /** The amount as the user actually typed it, in unitCostCurrency, before
   * conversion to unitCost — kept so the plan can show "£8.50 (≈ $10.00)"
   * using the real entered figure, not a live-recomputed estimate that
   * could differ from what was actually quoted/paid. */
  unitCostOriginal: number | null;
}

export interface CollectionPlanCost {
  id: string;
  planId: string;
  costCategory: string;
  description: string | null;
  /** Null means "to be determined" — a disclosed category with no figure
   * yet, not a cost of zero. Excluded from projected totals until set. */
  plannedAmount: number | null;
  /** True means plannedAmount is a rough guess, not a firm quote/invoice —
   * still counted in every total (it's a real number, just a soft one),
   * but flagged everywhere it's shown so a reader doesn't mistake it for
   * confirmed. Distinct from plannedAmount being null (no number at all). */
  isEstimated: boolean;
  notes: string | null;
}

export interface CollectionPlanRecord {
  id: string;
  collectionId: string;
  entityId: string;
  collaborationType: string;
  partnerName: string | null;
  currency: string;
  /** The partner's own currency, if different from `currency` — display
   * only, never used for any stored conversion. Null means "same as
   * currency" / not set. */
  partnerCurrency: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CustomTerm {
  label: string;
  value: string;
}

// metadata.custom_terms is a free-form list the user builds themselves —
// e.g. co_brand_credit_notes/marketing_commitment_notes (co_branded) are
// useful presets, but a deal often has terms specific to it that no fixed
// field anticipates. Stored directly in the plan's metadata jsonb, not a
// new table — same "ad-hoc, not a new schema" shape as everything else
// collaboration-specific. Validates defensively since metadata is
// unstructured jsonb that nothing stops from being malformed.
export function getCustomTerms(metadata: Record<string, unknown>): CustomTerm[] {
  const raw = metadata?.custom_terms;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is CustomTerm =>
        entry && typeof entry.label === 'string' && typeof entry.value === 'string'
    )
    .filter(entry => entry.label.trim() !== '');
}

export interface PlanPayout {
  /** e.g. the logged-in entity's own name, the partner's name, or "Venue"
   * for a pop-up — never the ThreadWise platform itself. */
  party: string;
  /** True for the counterparty's row(s) — lets a renderer show the
   * partner-currency conversion on the right row without re-deriving it
   * from the party string. */
  isPartner: boolean;
  amount: number;
  /** Short human-readable explanation of how this figure was derived. */
  basis: string;
}

export interface PlanPartnerPayment {
  /** Null means the partner owes nothing *in this direction* — either
   * because this collaboration type pays the other way (e.g. pop_up: the
   * entity pays the partner's venue cost) or because the terms needed to
   * calculate it (e.g. co_branded's cost split) aren't set yet. basis
   * always explains which of those it is, so "no payment" is a stated
   * fact rather than a silent gap. */
  amount: number | null;
  basis: string;
}

export interface CollectionPlanProjections {
  projectedRevenue: number;
  projectedProductCost: number;
  projectedOtherCost: number;
  projectedTotalCost: number;
  projectedGrossProfit: number;
  projectedNetProfit: number;
  projectedGrossMarginPct: number;
  projectedNetMarginPct: number;
  // Only populated for revenue_share/co_branded — the entity's own
  // estimated take after the partner split, not a full multi-party ledger.
  estimatedShareRevenue: number | null;
  estimatedShareProfit: number | null;
  // Who gets paid what, for every collaboration type that involves another
  // party (empty for in_house). This is the authoritative "who gets paid
  // how much" statement — estimatedShareRevenue/Profit above are kept only
  // for the simpler single-figure callout already in the UI.
  payouts: PlanPayout[];
  // What the collaborating party owes the entity, specifically — distinct
  // from payouts above (which states who receives money from the revenue
  // this plan generates, in either direction). Null for in_house, since
  // there's no collaborating party to owe anything.
  partnerPaymentDue: PlanPartnerPayment | null;
  // co_branded only (null for every other type): what the entity itself
  // must have in cash before any revenue comes in. When the partner pays
  // their cost-split share upfront (the default), that's just the
  // entity's own cost share — the partner is separately covering theirs.
  // When metadata.costs_paid_upfront is false, the partner's share is
  // instead netted out of their later revenue split, so nobody but the
  // entity has put any cash in before launch — the entity is fronting the
  // *full* planned cost, not just their split share.
  entityUpfrontCost: number | null;
  // Costs with no amount yet ("to be determined") — excluded from every
  // total above, so this is how a reader knows the real figure can still
  // go up, not just a cosmetic footnote.
  costsPendingCount: number;
  // Costs with a figure that's a rough guess rather than a firm quote —
  // still counted in every total above (unlike pending costs), but a
  // reader should know some of what's in those totals isn't locked in.
  costsEstimatedCount: number;
}

// ─── Projection math ────────────────────────────────────────────────────────

function toNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Total venue/staffing/fixtures cost for a pop_up plan, from its metadata.
 * Lives here (not inline in computePlanProjections) so the print pack's
 * "basis" text can reuse the exact same duration math. */
function popUpCostTotal(metadata: Record<string, unknown>): {
  venueCostTotal: number;
  staffingCost: number;
  fixturesCost: number;
  total: number;
  venueBasis: string;
} {
  const venueCostAmount = toNumberOrNull(metadata?.venue_cost_amount) ?? 0;
  const period = metadata?.venue_cost_period || 'flat';
  const durationDays = toNumberOrNull(metadata?.duration_days) ?? 0;
  const staffingCost = toNumberOrNull(metadata?.staffing_cost_amount) ?? 0;
  const fixturesCost = toNumberOrNull(metadata?.fixtures_cost_amount) ?? 0;

  let venueCostTotal = venueCostAmount;
  let venueBasis = 'Flat venue fee';
  if (period === 'per_day' && durationDays > 0) {
    venueCostTotal = venueCostAmount * durationDays;
    venueBasis = `${durationDays} day(s) at ${venueCostAmount}/day`;
  } else if (period === 'per_week' && durationDays > 0) {
    const weeks = durationDays / 7;
    venueCostTotal = venueCostAmount * weeks;
    venueBasis = `${weeks.toFixed(1)} week(s) at ${venueCostAmount}/week`;
  }

  return {
    venueCostTotal,
    staffingCost,
    fixturesCost,
    total: venueCostTotal + staffingCost + fixturesCost,
    venueBasis,
  };
}

/**
 * COGS is charged on every unit *produced* (planned_quantity) — you pay for
 * it regardless of whether it sells. Revenue is earned only on the units
 * expected to actually sell (planned_quantity × expected_sell_through_pct),
 * so the two are allowed to diverge rather than assuming 100% sell-through.
 */
export function computePlanProjections(
  collaborationType: string,
  entityName: string | null,
  partnerName: string | null,
  metadata: Record<string, unknown>,
  lines: CollectionPlanLine[],
  costs: CollectionPlanCost[]
): CollectionPlanProjections {
  let projectedRevenue = 0;
  let projectedProductCost = 0;

  for (const line of lines) {
    const sellThroughPct = Math.max(
      0,
      Math.min(
        100,
        Number.isFinite(line.expectedSellThroughPct) ? line.expectedSellThroughPct : 100
      )
    );
    const giftedUnits = Math.max(
      0,
      Math.min(line.plannedQuantity, Number.isFinite(line.giftedUnits) ? line.giftedUnits : 0)
    );
    const sellableUnits = line.plannedQuantity - giftedUnits;
    const unitsSold = sellableUnits * (sellThroughPct / 100);
    projectedRevenue += unitsSold * line.unitSellingPrice;
    // COGS is charged on every unit produced, gifted or not — gifting
    // doesn't reduce what you paid, only what you earn.
    projectedProductCost += line.plannedQuantity * line.unitCost;
  }

  let projectedOtherCost = costs.reduce((sum, cost) => sum + (cost.plannedAmount ?? 0), 0);
  const costsPendingCount = costs.filter(cost => cost.plannedAmount == null).length;
  const costsEstimatedCount = costs.filter(
    cost => cost.plannedAmount != null && cost.isEstimated
  ).length;

  // pop_up's venue/staffing/fixtures costs are entered as collaboration
  // terms (metadata), not plan cost lines — but they're real planned costs
  // and must count toward the total, not just be display-only trivia.
  const popUp = collaborationType === 'pop_up' ? popUpCostTotal(metadata) : null;
  if (popUp) {
    projectedOtherCost += popUp.total;
  }

  const projectedTotalCost = projectedProductCost + projectedOtherCost;
  const projectedGrossProfit = projectedRevenue - projectedProductCost;
  const projectedNetProfit = projectedRevenue - projectedTotalCost;
  const projectedGrossMarginPct =
    projectedRevenue > 0 ? (projectedGrossProfit / projectedRevenue) * 100 : 0;
  const projectedNetMarginPct =
    projectedRevenue > 0 ? (projectedNetProfit / projectedRevenue) * 100 : 0;

  let estimatedShareRevenue: number | null = null;
  let estimatedShareProfit: number | null = null;
  const payouts: PlanPayout[] = [];
  let partnerPaymentDue: PlanPartnerPayment | null = null;
  let entityUpfrontCost: number | null = null;
  const partnerLabel = partnerName || 'Partner';
  const entityLabel = entityName || 'The business';

  if (collaborationType === 'wholesale') {
    const paymentTerms = typeof metadata?.payment_terms === 'string' ? metadata.payment_terms : '';
    payouts.push({
      party: entityLabel,
      isPartner: false,
      amount: projectedRevenue,
      basis: `${partnerLabel} pays wholesale price × planned quantity`,
    });
    partnerPaymentDue = {
      amount: projectedRevenue,
      basis: paymentTerms
        ? `Wholesale price × planned quantity, due ${paymentTerms}`
        : 'Wholesale price × planned quantity',
    };
  } else if (collaborationType === 'revenue_share') {
    const revenueSharePct = toNumberOrNull(metadata?.revenue_share_pct);
    if (revenueSharePct != null) {
      const rawPartnerShare = projectedRevenue * (revenueSharePct / 100);
      const minimumGuarantee = toNumberOrNull(metadata?.minimum_guarantee_amount) ?? 0;
      const partnerPayout = Math.max(rawPartnerShare, minimumGuarantee);
      const guaranteeApplied = minimumGuarantee > rawPartnerShare;

      estimatedShareRevenue = projectedRevenue - partnerPayout;
      estimatedShareProfit = estimatedShareRevenue - projectedTotalCost;

      payouts.push({
        party: partnerLabel,
        isPartner: true,
        amount: partnerPayout,
        basis: guaranteeApplied
          ? `Minimum guarantee applied (${revenueSharePct}% share alone would be ${Math.round(rawPartnerShare).toLocaleString()})`
          : `${revenueSharePct}% of projected revenue`,
      });
      payouts.push({
        party: entityLabel,
        isPartner: false,
        amount: estimatedShareProfit,
        basis: 'Remaining revenue less total planned costs',
      });
      // Under revenue_share, the entity collects all sales and remits a
      // cut — it's the entity who pays, not the partner, so there's no
      // upfront amount owed in this direction.
      partnerPaymentDue = {
        amount: null,
        basis: `No upfront payment — ${entityLabel} pays ${partnerLabel} its revenue share after sales, shown under "Who gets paid"`,
      };
    }
  } else if (collaborationType === 'co_branded') {
    const revenueSplitPct = toNumberOrNull(metadata?.revenue_split_pct);
    const costSplitPct = toNumberOrNull(metadata?.cost_split_pct);
    if (revenueSplitPct != null || costSplitPct != null) {
      const rPct = revenueSplitPct ?? 100;
      const cPct = costSplitPct ?? 100;

      const entityRevenue = projectedRevenue * (rPct / 100);
      const entityCost = projectedTotalCost * (cPct / 100);
      const partnerRevenue = projectedRevenue - entityRevenue;
      const partnerCost = projectedTotalCost - entityCost;

      estimatedShareRevenue = entityRevenue;
      estimatedShareProfit = entityRevenue - entityCost;

      // Default true so plans saved before this toggle existed keep behaving
      // exactly as before: partner contributes their cost share in cash,
      // upfront, before any revenue exists.
      const costsPaidUpfront = metadata?.costs_paid_upfront !== false;
      const partnerNetPayout = partnerRevenue - partnerCost;

      payouts.push({
        party: entityLabel,
        isPartner: false,
        amount: estimatedShareProfit,
        basis: `${rPct}% revenue share, ${cPct}% cost share`,
      });
      payouts.push({
        party: partnerLabel,
        isPartner: true,
        amount: partnerNetPayout,
        basis: costsPaidUpfront
          ? `${100 - rPct}% revenue share, ${100 - cPct}% cost share`
          : `${100 - rPct}% revenue share, less ${possessive(partnerLabel)} ${100 - cPct}% cost share (deducted here instead of paid upfront)`,
      });

      if (costsPaidUpfront) {
        // The partner's cost-split share is a real contribution obligation —
        // independent of how revenue ends up split, and due regardless of
        // whether sales meet projections, so it's shown even if partnerCost
        // comes out to 0 (e.g. cost split wasn't set, defaulting to 100%
        // entity-funded).
        partnerPaymentDue = {
          amount: partnerCost,
          basis: `${100 - cPct}% of total planned costs (${possessive(partnerLabel)} cost-split contribution)`,
        };
        // The partner is covering their own share in cash, so the entity
        // only needs to front its own share.
        entityUpfrontCost = entityCost;
      } else {
        const shortfall = partnerNetPayout < 0;
        partnerPaymentDue = {
          amount: null,
          basis: shortfall
            ? `No upfront payment — ${possessive(partnerLabel)} ${100 - cPct}% cost share (${Math.round(partnerCost).toLocaleString()}) is deducted from its revenue split instead, but that share alone doesn't cover it — ${entityLabel} may not recover the full shortfall if sales come in as planned`
            : `No upfront payment — ${possessive(partnerLabel)} ${100 - cPct}% cost share is deducted from its revenue split when it settles instead`,
        };
        // Nobody but the entity has put cash in before launch, so the
        // entity is exposed for the *full* planned cost, not just its own
        // split share — the partner's contribution only arrives later, net,
        // out of revenue that doesn't exist yet.
        entityUpfrontCost = projectedTotalCost;
      }
    } else {
      partnerPaymentDue = {
        amount: null,
        basis: `Set a cost split above to calculate ${partnerLabel}'s contribution`,
      };
    }
  } else if (collaborationType === 'pop_up' && popUp) {
    payouts.push({
      party: partnerLabel,
      isPartner: true,
      amount: popUp.venueCostTotal,
      basis: popUp.venueBasis,
    });
    // Pop_up pays the other way too — the entity pays the partner's venue
    // cost, so there's nothing the partner owes here.
    partnerPaymentDue = {
      amount: null,
      basis: `No payment due from ${partnerLabel} — ${entityLabel} pays the venue cost, shown under "Who gets paid"`,
    };
  }

  return {
    projectedRevenue,
    projectedProductCost,
    projectedOtherCost,
    projectedTotalCost,
    projectedGrossProfit,
    projectedNetProfit,
    projectedGrossMarginPct,
    projectedNetMarginPct,
    estimatedShareRevenue,
    estimatedShareProfit,
    payouts,
    partnerPaymentDue,
    entityUpfrontCost,
    costsPendingCount,
    costsEstimatedCount,
  };
}

// ─── Scenario presets (for the print pack's "compare scenarios" mode) ──────

export interface ScenarioPreset {
  label: string;
  description: string;
  sellThroughMultiplier: number;
  unitCostMultiplier: number;
  unitPriceMultiplier: number;
  /** Percentage-point shift against the entity's own share of a
   * collaboration split (positive = worse for the entity, better for the
   * partner). */
  splitShiftPct: number;
  /** Applied to pop_up's venue/staffing/fixtures costs — same direction as
   * unitCostMultiplier. */
  popUpCostMultiplier: number;
}

// Automatic variance bands, not user-entered values — ad-hoc, nothing
// persisted. "Cost" variance here means per-unit production cost
// (unit_cost) and, for pop_up, venue/staffing/fixtures — fixed planned
// cost lines (collection_plan_costs: marketing, packaging, etc.) are left
// as entered, since those are usually a decided budget rather than a
// market uncertainty the way per-unit cost and sell-through are.
export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    label: 'Conservative',
    description: '20% lower sell-through, 15% higher unit cost, 5% lower price',
    sellThroughMultiplier: 0.8,
    unitCostMultiplier: 1.15,
    unitPriceMultiplier: 0.95,
    splitShiftPct: 5,
    popUpCostMultiplier: 1.15,
  },
  {
    label: 'Base case',
    description: 'As planned, no adjustment',
    sellThroughMultiplier: 1,
    unitCostMultiplier: 1,
    unitPriceMultiplier: 1,
    splitShiftPct: 0,
    popUpCostMultiplier: 1,
  },
  {
    label: 'Optimistic',
    description: '15% higher sell-through, 10% lower unit cost, 5% higher price',
    sellThroughMultiplier: 1.15,
    unitCostMultiplier: 0.9,
    unitPriceMultiplier: 1.05,
    splitShiftPct: -5,
    popUpCostMultiplier: 0.9,
  },
];

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Applies one scenario preset to a plan's lines/metadata, returning
 * adjusted copies — never mutates the inputs. Collaboration split
 * percentages are shifted by splitShiftPct against the entity's own share
 * specifically (not a flat multiplier), since a split is already expressed
 * 0-100 and a multiplier would behave oddly near either end of the range.
 */
export function applyScenarioPreset(
  preset: ScenarioPreset,
  collaborationType: string,
  metadata: Record<string, unknown>,
  lines: CollectionPlanLine[]
): { metadata: Record<string, unknown>; lines: CollectionPlanLine[] } {
  const adjustedLines = lines.map(line => ({
    ...line,
    expectedSellThroughPct: clampPct(line.expectedSellThroughPct * preset.sellThroughMultiplier),
    unitCost: line.unitCost * preset.unitCostMultiplier,
    unitSellingPrice: line.unitSellingPrice * preset.unitPriceMultiplier,
  }));

  const adjustedMetadata: Record<string, unknown> = { ...metadata };

  if (preset.splitShiftPct !== 0) {
    if (collaborationType === 'revenue_share' && adjustedMetadata.revenue_share_pct != null) {
      adjustedMetadata.revenue_share_pct = clampPct(
        Number(adjustedMetadata.revenue_share_pct) + preset.splitShiftPct
      );
    } else if (collaborationType === 'co_branded') {
      if (adjustedMetadata.revenue_split_pct != null) {
        adjustedMetadata.revenue_split_pct = clampPct(
          Number(adjustedMetadata.revenue_split_pct) - preset.splitShiftPct
        );
      }
      if (adjustedMetadata.cost_split_pct != null) {
        adjustedMetadata.cost_split_pct = clampPct(
          Number(adjustedMetadata.cost_split_pct) + preset.splitShiftPct
        );
      }
    }
  }

  if (collaborationType === 'pop_up' && preset.popUpCostMultiplier !== 1) {
    for (const key of ['venue_cost_amount', 'staffing_cost_amount', 'fixtures_cost_amount']) {
      if (adjustedMetadata[key] != null) {
        adjustedMetadata[key] = Number(adjustedMetadata[key]) * preset.popUpCostMultiplier;
      }
    }
  }

  return { metadata: adjustedMetadata, lines: adjustedLines };
}

export interface ScenarioResult {
  preset: ScenarioPreset;
  projections: CollectionPlanProjections;
}

/** Runs every preset through computePlanProjections, reusing the plan's
 * actual cost lines unadjusted (see SCENARIO_PRESETS comment). */
export function computeScenarios(
  collaborationType: string,
  entityName: string | null,
  partnerName: string | null,
  metadata: Record<string, unknown>,
  lines: CollectionPlanLine[],
  costs: CollectionPlanCost[]
): ScenarioResult[] {
  return SCENARIO_PRESETS.map(preset => {
    const adjusted = applyScenarioPreset(preset, collaborationType, metadata, lines);
    return {
      preset,
      projections: computePlanProjections(
        collaborationType,
        entityName,
        partnerName,
        adjusted.metadata,
        adjusted.lines,
        costs
      ),
    };
  });
}
