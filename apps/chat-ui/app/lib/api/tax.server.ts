/**
 * UK Tax API Service
 *
 * Server-side data for the Tax page.
 *
 * Principle: corporation tax is assessed per ACCOUNTING PERIOD, never per
 * calendar year. Every figure here is cut on the entity's accounting reference
 * date. The heavy lifting — adjustments, loss relief, rate bands, marginal
 * relief — lives in the `compute_corporation_tax` Postgres function so the
 * computation is testable in SQL and reachable by the chat agent, rather than
 * being trapped in TypeScript.
 *
 * Nothing here constitutes tax advice. The output is a computation for review,
 * and the CT600 pack is a preparation working paper — not a filing. Actual
 * submission requires HMRC-recognised software and iXBRL-tagged accounts.
 */

import { getServerSupabaseClient } from '~/lib/supabase';

// VAT registration becomes compulsory once taxable turnover in any rolling
// 12-month window exceeds this. Checked monthly, not at year end.
const VAT_REGISTRATION_THRESHOLD = 90_000;

// Section 455 charge on a director's loan left outstanding more than 9 months
// and 1 day after the period end.
const S455_RATE = 0.3375;

export interface TaxPeriod {
  periodId: string;
  label: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed' | 'filed';
  paymentDue: string;
  filingDue: string;
  /**
   * False for periods predating reliable bookkeeping in this system. Every
   * numeric field below is null in that case — the real figures live in the
   * filed accounts and the accountant's records, and inventing one here would
   * look authoritative while being a guess.
   */
  ledgerBasis: boolean;
  accountingProfit: number | null;
  addBacks: number | null;
  deductions: number | null;
  adjustedProfit: number | null;
  lossBroughtForward: number | null;
  lossReliefUsed: number | null;
  taxableProfit: number | null;
  lossCarriedForward: number | null;
  marginalRelief: number | null;
  effectiveRate: number | null;
  taxDue: number | null;
  filedNetAssets: number | null;
  notes: string | null;
  /** Open periods are incomplete: the figures are a run-rate, not a liability. */
  isProjection: boolean;
  monthsElapsed: number;
  monthsInPeriod: number;
}

export interface TaxAdjustment {
  id: string;
  direction: 'add_back' | 'deduction';
  category: string;
  description: string;
  amount: number;
  source: 'auto' | 'manual';
  accountNumber: string | null;
}

export interface TaxReviewItem {
  periodId: string;
  accountNumber: string;
  accountName: string;
  amount: number;
  lineCount: number;
  guidance: string;
  /** True once a manual adjustment exists for this account in this period. */
  resolved: boolean;
}

export interface TaxDeadline {
  label: string;
  kind: 'payment' | 'filing';
  dueDate: string;
  amount: number | null;
  daysRemaining: number;
  status: 'overdue' | 'due_soon' | 'upcoming' | 'satisfied';
}

export interface EntityTaxProfile {
  entityId: string;
  name: string;
  companyNumber: string | null;
  taxReference: string | null;
  yearEndLabel: string | null;
  vatRegistered: boolean;
  vatNumber: string | null;
  /** Fields the CT600 needs that haven't been captured yet. */
  missingForFiling: string[];
}

export interface VatPosition {
  registered: boolean;
  rollingTurnover: number;
  threshold: number;
  headroom: number;
  percentOfThreshold: number;
  windowStart: string;
  windowEnd: string;
}

export interface DirectorsLoanPosition {
  balance: number;
  /** Positive = director owes the company, which is what triggers s455. */
  overdrawn: boolean;
  s455Charge: number;
}

export interface TaxProvisionPosition {
  accruedLiability: number;
  taxOnClosedPeriods: number;
  taxRecordedAsPaid: number;
  /**
   * Null when no completed period can be computed here — comparing tax owed
   * against tax paid is meaningless if the owed side is unknown, and showing
   * a difference anyway would read as a shortfall that isn't real.
   */
  unprovided: number | null;
}

export interface ProfitBreakdownLine {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: 'revenue' | 'cogs' | 'expense';
  balance: number;
  lineCount: number;
}

export interface TaxData {
  entity: EntityTaxProfile;
  periods: TaxPeriod[];
  currentPeriod: TaxPeriod | null;
  lastClosedPeriod: TaxPeriod | null;
  adjustmentsByPeriod: Record<string, TaxAdjustment[]>;
  /** Revenue/COGS/expense balances per account, per period — sums to accountingProfit. */
  profitBreakdownByPeriod: Record<string, ProfitBreakdownLine[]>;
  reviewItems: TaxReviewItem[];
  deadlines: TaxDeadline[];
  vat: VatPosition;
  directorsLoan: DirectorsLoanPosition;
  provision: TaxProvisionPosition;
}

const MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

function monthsBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MONTH_MS);
}

function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export async function getTaxData(): Promise<TaxData> {
  const supabase = getServerSupabaseClient();

  const { data: entityRows, error: entityError } = await supabase
    .from('entities')
    .select(
      'id, name, legal_name, company_number, tax_reference, year_end_day, ' +
        'year_end_month, vat_registered, vat_number'
    )
    .limit(1);

  if (entityError) throw new Error(`Failed to load entity: ${entityError.message}`);
  // Cast: the generated Supabase types predate the tax columns added for this
  // feature, so the row is otherwise inferred as an error union.
  const entityRow = (((entityRows || [])[0] ?? null) as unknown) as Record<
    string,
    unknown
  > | null;
  if (!entityRow) throw new Error('No entity configured');

  const entityId = entityRow.id as string;

  const [computationRes, adjustmentsRes, reviewRes, periodMetaRes, breakdownRes] =
    await Promise.all([
      supabase.rpc('compute_corporation_tax', { p_entity_id: entityId }),
      supabase
        .from('tax_adjustments')
        .select(
          'id, period_id, direction, category, description, amount, source, account_number'
        ),
      supabase.from('tax_review_items').select('*'),
      supabase.from('accounting_periods').select('id, filed_net_assets, notes'),
      supabase
        .from('tax_period_account_breakdown')
        .select(
          'period_id, account_id, account_number, account_name, account_type, balance, line_count'
        ),
    ]);

  const periodMeta = new Map<string, { filedNetAssets: number | null; notes: string | null }>();
  for (const r of periodMetaRes.data || []) {
    periodMeta.set((r as any).id, {
      filedNetAssets:
        (r as any).filed_net_assets != null ? Number((r as any).filed_net_assets) : null,
      notes: (r as any).notes ?? null,
    });
  }

  if (computationRes.error) {
    throw new Error(`Failed to compute corporation tax: ${computationRes.error.message}`);
  }

  const now = new Date();

  const num = (v: unknown): number | null => (v == null ? null : Number(v));

  const periods: TaxPeriod[] = (computationRes.data || []).map((row: any) => {
    const start = new Date(`${row.start_date}T00:00:00Z`);
    const end = new Date(`${row.end_date}T00:00:00Z`);
    const monthsInPeriod = Math.max(1, Math.round(monthsBetween(start, end)));
    const isOpen = row.status === 'open';
    const meta = periodMeta.get(row.period_id);
    return {
      periodId: row.period_id,
      label: row.label,
      startDate: row.start_date,
      endDate: row.end_date,
      status: row.status,
      paymentDue: row.payment_due,
      filingDue: row.filing_due,
      ledgerBasis: Boolean(row.ledger_basis),
      accountingProfit: num(row.accounting_profit),
      addBacks: num(row.add_backs),
      deductions: num(row.deductions),
      adjustedProfit: num(row.adjusted_profit),
      lossBroughtForward: num(row.loss_brought_forward),
      lossReliefUsed: num(row.loss_relief_used),
      taxableProfit: num(row.taxable_profit),
      lossCarriedForward: num(row.loss_carried_forward),
      marginalRelief: num(row.marginal_relief),
      effectiveRate: num(row.effective_rate),
      taxDue: num(row.tax_due),
      filedNetAssets: meta?.filedNetAssets ?? null,
      notes: meta?.notes ?? null,
      isProjection: isOpen,
      monthsElapsed: isOpen
        ? Math.min(monthsInPeriod, Math.round(monthsBetween(start, now)))
        : monthsInPeriod,
      monthsInPeriod,
    };
  });

  const adjustmentsByPeriod: Record<string, TaxAdjustment[]> = {};
  for (const row of adjustmentsRes.data || []) {
    const pid = (row as any).period_id as string;
    (adjustmentsByPeriod[pid] ||= []).push({
      id: (row as any).id,
      direction: (row as any).direction,
      category: (row as any).category,
      description: (row as any).description,
      amount: Number((row as any).amount ?? 0),
      source: (row as any).source,
      accountNumber: (row as any).account_number ?? null,
    });
  }

  // A review item is resolved once an adjustment exists against that account
  // for that period — whether the engine made it automatically (corporation
  // tax, depreciation) or a human recorded one after judging the split.
  const manualKeys = new Set(
    (adjustmentsRes.data || [])
      .filter((a: any) => a.account_number)
      .map((a: any) => `${a.period_id}:${a.account_number}`)
  );

  const reviewItems: TaxReviewItem[] = (reviewRes.data || []).map((row: any) => ({
    periodId: row.period_id,
    accountNumber: row.account_number,
    accountName: row.account_name,
    amount: Number(row.amount ?? 0),
    lineCount: Number(row.line_count ?? 0),
    guidance: row.guidance,
    resolved: manualKeys.has(`${row.period_id}:${row.account_number}`),
  }));

  const profitBreakdownByPeriod: Record<string, ProfitBreakdownLine[]> = {};
  for (const row of breakdownRes.data || []) {
    const pid = (row as any).period_id as string;
    (profitBreakdownByPeriod[pid] ||= []).push({
      accountId: (row as any).account_id,
      accountNumber: (row as any).account_number,
      accountName: (row as any).account_name,
      accountType: (row as any).account_type,
      balance: Number((row as any).balance ?? 0),
      lineCount: Number((row as any).line_count ?? 0),
    });
  }
  // Revenue first, then COGS, then expense — matches the waterfall order the
  // computation itself reads top to bottom.
  const typeOrder = { revenue: 0, cogs: 1, expense: 2 } as const;
  for (const lines of Object.values(profitBreakdownByPeriod)) {
    lines.sort(
      (a, b) =>
        typeOrder[a.accountType] - typeOrder[b.accountType] ||
        Math.abs(b.balance) - Math.abs(a.balance)
    );
  }

  const currentPeriod = periods.find(p => p.status === 'open') ?? null;
  const closed = periods.filter(p => p.status !== 'open');
  // Only a period the ledger can actually support counts as one we can report
  // a liability for. Everything earlier is history held by the accountant.
  const computable = closed.filter(p => p.ledgerBasis);
  const lastClosedPeriod = computable.length ? computable[computable.length - 1] : null;

  // ── Deadlines ──
  // Only closed periods carry real obligations. An open period's dates are
  // shown for planning but can't be late.
  const deadlines: TaxDeadline[] = [];
  for (const p of closed) {
    for (const kind of ['payment', 'filing'] as const) {
      const dueDate = kind === 'payment' ? p.paymentDue : p.filingDue;
      const days = daysUntil(dueDate);
      // A period marked 'filed' is done regardless of date. A nil liability
      // needs no payment, but the return is still required.
      //
      // NOTE: a past date only means this app holds no record of the
      // obligation being met — it cannot see HMRC.
      const satisfied =
        p.status === 'filed' || (kind === 'payment' && p.taxDue === 0);
      deadlines.push({
        label: p.label,
        kind,
        dueDate,
        // No amount is shown for periods the ledger cannot compute — the
        // deadline is real, the figure is the accountant's to supply.
        amount: kind === 'payment' && p.ledgerBasis ? p.taxDue : null,
        daysRemaining: days,
        status: satisfied
          ? 'satisfied'
          : days < 0
            ? 'overdue'
            : days <= 90
              ? 'due_soon'
              : 'upcoming',
      });
    }
  }
  deadlines.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // ── VAT threshold (rolling 12 months) ──
  const windowStart = new Date(now);
  windowStart.setUTCMonth(windowStart.getUTCMonth() - 12);
  const windowStartStr = windowStart.toISOString().slice(0, 10);
  const windowEndStr = now.toISOString().slice(0, 10);

  const { data: vatRows } = await supabase
    .from('orders')
    .select('grand_total_amount, created_at, status')
    .gte('created_at', windowStartStr);

  const rollingTurnover = (vatRows || [])
    .filter((o: any) => o.status !== 'cancelled')
    .reduce((sum: number, o: any) => sum + Number(o.grand_total_amount || 0), 0);

  const vat: VatPosition = {
    registered: Boolean(entityRow.vat_registered),
    rollingTurnover,
    threshold: VAT_REGISTRATION_THRESHOLD,
    headroom: VAT_REGISTRATION_THRESHOLD - rollingTurnover,
    percentOfThreshold: (rollingTurnover / VAT_REGISTRATION_THRESHOLD) * 100,
    windowStart: windowStartStr,
    windowEnd: windowEndStr,
  };

  // ── Control account positions (director's loan, tax accounts) ──
  const { data: positionRows } = await supabase
    .from('tax_account_positions')
    .select('account_number, net_debit, net_credit');

  const positions = new Map<string, { netDebit: number; netCredit: number }>();
  for (const r of positionRows || []) {
    positions.set((r as any).account_number, {
      netDebit: Number((r as any).net_debit ?? 0),
      netCredit: Number((r as any).net_credit ?? 0),
    });
  }

  // Credit balance = company owes the director, which is harmless. A debit
  // balance means the director owes the company and is what s455 taxes.
  const dlaNetDebit = positions.get('2230')?.netDebit ?? 0;
  const directorsLoan: DirectorsLoanPosition = {
    balance: dlaNetDebit,
    overdrawn: dlaNetDebit > 0,
    s455Charge: dlaNetDebit > 0 ? dlaNetDebit * S455_RATE : 0,
  };

  // ── Provision vs actual ──
  const accruedLiability = positions.get('2035')?.netCredit ?? 0;
  const taxRecordedAsPaid = positions.get('8045')?.netDebit ?? 0;

  const taxOnClosedPeriods = computable.reduce((s, p) => s + (p.taxDue ?? 0), 0);
  const provision: TaxProvisionPosition = {
    accruedLiability,
    taxOnClosedPeriods,
    taxRecordedAsPaid,
    unprovided: computable.length
      ? taxOnClosedPeriods - taxRecordedAsPaid - accruedLiability
      : null,
  };

  const missingForFiling: string[] = [];
  if (!entityRow.company_number) missingForFiling.push('Company registration number');
  if (!entityRow.tax_reference) missingForFiling.push('HMRC Unique Taxpayer Reference (UTR)');

  const yearEndLabel =
    entityRow.year_end_day && entityRow.year_end_month
      ? `${entityRow.year_end_day} ${
          [
            'January','February','March','April','May','June',
            'July','August','September','October','November','December',
          ][(entityRow.year_end_month as number) - 1]
        }`
      : null;

  return {
    entity: {
      entityId,
      name: (entityRow.legal_name as string) || (entityRow.name as string),
      companyNumber: (entityRow.company_number as string) ?? null,
      taxReference: (entityRow.tax_reference as string) ?? null,
      yearEndLabel,
      vatRegistered: Boolean(entityRow.vat_registered),
      vatNumber: (entityRow.vat_number as string) ?? null,
      missingForFiling,
    },
    periods,
    currentPeriod,
    lastClosedPeriod,
    adjustmentsByPeriod,
    profitBreakdownByPeriod,
    reviewItems,
    deadlines,
    vat,
    directorsLoan,
    provision,
  };
}
