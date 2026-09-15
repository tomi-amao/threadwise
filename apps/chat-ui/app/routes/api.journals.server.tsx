/**
 * Journals API Route
 *
 * Server-side action for creating manual journal entries directly in Supabase.
 * Supports two intents:
 *   - createJournal: create an arbitrary double-entry journal
 *   - reclassifySamples: query unlinked inventory items and create the
 *     reclassification journal (DR expense / CR Inventory — Finished Goods)
 */

import type { ActionFunctionArgs } from 'react-router';
import { getServerSupabaseClient } from '~/lib/supabase';

const ENTITY_ID = 'f49f608d-0868-4e63-b0bb-d4c60d74db68';

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const supabase = getServerSupabaseClient();

  let body: Record<string, unknown>;
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = await request.json();
    } else {
      const fd = await request.formData();
      body = Object.fromEntries(fd.entries()) as Record<string, string>;
    }
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { intent } = body;

  // ── createJournal ──────────────────────────────────────────────────────────
  if (intent === 'createJournal') {
    const { journal_date, description, journal_type, lines: rawLines } = body as {
      journal_date: string;
      description: string;
      journal_type?: string;
      lines: unknown;
    };

    if (!journal_date) return json({ error: 'journal_date is required' }, { status: 400 });
    if (!rawLines) return json({ error: 'lines are required' }, { status: 400 });

    interface LineInput {
      account_id: string;
      debit: number;
      credit: number;
      currency: string;
      gbp_equivalent?: number | null;
      line_description?: string;
    }

    let lines: LineInput[];
    try {
      lines = (typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines) as LineInput[];
    } catch {
      return json({ error: 'Invalid lines format' }, { status: 400 });
    }

    if (!Array.isArray(lines) || lines.length < 2) {
      return json({ error: 'At least two line items are required' }, { status: 400 });
    }

    // Validate each line has an account_id
    for (const line of lines) {
      if (!line.account_id) {
        return json({ error: 'All lines must have an account_id' }, { status: 400 });
      }
    }

    // Compute GBP totals for balance check
    const gbpDebit = lines.reduce((s, l) => {
      const isNonGbp = l.currency && l.currency.toUpperCase() !== 'GBP';
      const gbpVal = isNonGbp ? (l.gbp_equivalent ?? 0) : (l.debit ?? 0);
      return s + (l.debit > 0 ? Number(gbpVal) : 0);
    }, 0);
    const gbpCredit = lines.reduce((s, l) => {
      const isNonGbp = l.currency && l.currency.toUpperCase() !== 'GBP';
      const gbpVal = isNonGbp ? (l.gbp_equivalent ?? 0) : (l.credit ?? 0);
      return s + (l.credit > 0 ? Number(gbpVal) : 0);
    }, 0);

    if (Math.abs(gbpDebit - gbpCredit) > 0.005) {
      return json(
        { error: `Journal is unbalanced: debits £${gbpDebit.toFixed(2)} ≠ credits £${gbpCredit.toFixed(2)}` },
        { status: 400 }
      );
    }

    // Insert journal
    const now = new Date().toISOString();
    const { data: journal, error: journalErr } = await supabase
      .from('journals')
      .insert({
        entity_id: ENTITY_ID,
        journal_date,
        journal_type: journal_type || 'adjustment',
        description: description || null,
        source_type: 'manual',
        source_id: null,
        status: 'posted',
        posted_at: now,
        metadata: { created_by: 'manual_journal_ui' },
      })
      .select('id')
      .single();

    if (journalErr || !journal) {
      return json({ error: journalErr?.message ?? 'Failed to create journal' }, { status: 500 });
    }

    // Insert line items
    const lineRows = lines.map((l) => ({
      journal_id: journal.id,
      account_id: l.account_id,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      currency: l.currency || 'GBP',
      gbp_equivalent: l.gbp_equivalent != null ? Number(l.gbp_equivalent) : null,
      description: l.line_description || null,
      effective_date: journal_date,
    }));

    const { error: linesErr } = await supabase.from('journal_line_items').insert(lineRows);
    if (linesErr) {
      // Roll back - delete the orphaned journal
      await supabase.from('journals').delete().eq('id', journal.id);
      return json({ error: linesErr.message }, { status: 500 });
    }

    return json({ ok: true, journal_id: journal.id });
  }

  // ── reclassifySamples ─────────────────────────────────────────────────────
  if (intent === 'reclassifySamples') {
    const { debit_account_id, credit_account_id, gbp_amount, usd_amount, journal_date } = body as {
      debit_account_id: string;
      credit_account_id: string;
      gbp_amount: number;
      usd_amount: number;
      journal_date: string;
    };

    if (!debit_account_id || !credit_account_id) {
      return json({ error: 'Both debit_account_id and credit_account_id are required' }, { status: 400 });
    }

    const gbpAmt = Number(gbp_amount);
    const usdAmt = Number(usd_amount);
    if (!gbpAmt || gbpAmt <= 0) {
      return json({ error: 'gbp_amount must be positive' }, { status: 400 });
    }

    const date = journal_date || new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    const { data: journal, error: journalErr } = await supabase
      .from('journals')
      .insert({
        entity_id: ENTITY_ID,
        journal_date: date,
        journal_type: 'adjustment',
        description: 'Reclassify sample / unlinked inventory items out of Finished Goods to Samples & Product Development Expense',
        source_type: 'manual',
        source_id: null,
        status: 'posted',
        posted_at: now,
        metadata: {
          created_by: 'samples_reclassification',
          usd_equivalent: usdAmt,
          item_count: 27,
        },
      })
      .select('id')
      .single();

    if (journalErr || !journal) {
      return json({ error: journalErr?.message ?? 'Failed to create journal' }, { status: 500 });
    }

    const lineRows = [
      {
        journal_id: journal.id,
        account_id: debit_account_id,
        debit: usdAmt > 0 ? usdAmt : gbpAmt,
        credit: 0,
        currency: usdAmt > 0 ? 'USD' : 'GBP',
        gbp_equivalent: usdAmt > 0 ? gbpAmt : null,
        description: 'Samples & unlinked inventory items reclassified to expense',
        effective_date: date,
      },
      {
        journal_id: journal.id,
        account_id: credit_account_id,
        debit: 0,
        credit: usdAmt > 0 ? usdAmt : gbpAmt,
        currency: usdAmt > 0 ? 'USD' : 'GBP',
        gbp_equivalent: usdAmt > 0 ? gbpAmt : null,
        description: 'Remove sample items from Inventory — Finished Goods',
        effective_date: date,
      },
    ];

    const { error: linesErr } = await supabase.from('journal_line_items').insert(lineRows);
    if (linesErr) {
      await supabase.from('journals').delete().eq('id', journal.id);
      return json({ error: linesErr.message }, { status: 500 });
    }

    return json({ ok: true, journal_id: journal.id, gbp_amount: gbpAmt });
  }

  return json({ error: `Unknown intent: ${String(intent)}` }, { status: 400 });
}
