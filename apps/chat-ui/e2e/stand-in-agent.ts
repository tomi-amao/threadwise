/**
 * A stand-in for the FastAPI agent, covering the server-side calls the app makes while it is
 * under test:
 *
 *   POST   /accounting/inventory/disposal          record a gift or write-off (Inventory)
 *   POST   /accounting/invoices/process            "read" an uploaded invoice into a draft
 *   GET    /accounting/invoices/{id}/payment-candidates  likely payments, with why they fit
 *   PATCH  /accounting/invoices/{id}/status        move an invoice through its lifecycle
 *   PATCH  /accounting/invoices/{id}               notes, direction, line accounts, what lines bought
 *   DELETE /accounting/invoices/{id}               remove a draft
 *   POST   /accounting/invoices/{id}/payments      match a bank transaction as its payment
 *   DELETE /accounting/invoices/{id}/payments/{t}  remove that match
 *   GET    /accounting/invoices/{id}/split         each matched payment's journal split by the lines
 *   POST   /accounting/invoices/{id}/split         apply one (the payment's journal is reversed)
 *   DELETE /accounting/invoices/{id}/split/{t}     undo it (the previous journal comes back)
 *   POST   /accounting/journals/{id}/reverse       take a posted journal out of the books (Journals)
 *   POST   /accounting/journals/{id}/post-draft    choose a draft's account and post it
 *   POST   /accounting/journals/suggest-accounts   a guess at the account for each draft
 *
 * The real endpoints also enforce the lifecycle rules; those are tested in the agent's own
 * suite (tests/test_invoice_rules.py, tests/test_invoice_service.py). This stand-in writes only
 * the rows the pages read back, straight into the local test database, and refuses to run
 * unless Supabase is the local stack. It mimics the refusals the pages need to show: deleting
 * an invoice that is not a draft, and matching a transaction that already pays another invoice.
 * Matching or unmatching a payment sets the status from what is linked, as the agent does
 * (invoice_rules.status_from_payments, simplified to one currency).
 *
 * Journals: reversing a journal dated inside a closed or filed accounting period is refused with
 * a 409, as the real agent does when the period lock trips.
 *
 * Inventory: a quantity above 1,000 is refused with a 422.
 *
 * Splits (services/invoice_split.py, simplified to journals in one currency): a payment
 * journaled as one expense, posted or draft, is split by line gross with the rounding on the
 * largest line; a line with no account keeps the payment's. Applying and undoing are two writes
 * here, not the agent's single database function.
 *
 * Every route answers only a request carrying a live Supabase user token, as the real agent does.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, loadTestEnv, requireEnv } from './env';
import { STAND_IN_NOTE } from './helpers/db';

loadTestEnv();
const supabase = createClient(
  assertLocalSupabase(process.env.SUPABASE_URL),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const PORT = Number(process.env.STAND_IN_AGENT_PORT ?? 8099);

async function readJson<T>(req: import('node:http').IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}') as T;
}

async function invoiceWithLines(id: string) {
  const { data } = await supabase
    .from('invoices')
    .select(
      'id, entity_id, invoice_number, invoice_type, status, origin, invoice_date, invoice_line_items(id, description, quantity, unit_cost, sku)'
    )
    .eq('id', id)
    .maybeSingle();
  return data;
}

async function processInvoice(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
) {
  const request = new Request('http://stand-in.local/', {
    method: 'POST',
    headers: req.headers as Record<string, string>,
    body: Readable.toWeb(req) as unknown as ReadableStream,
    // @ts-expect-error Node needs this to stream a request body
    duplex: 'half',
  });
  const form = await request.formData();
  const file = form.get('file');
  const entityId = String(form.get('entity_id') ?? '');
  if (!(file instanceof File) || !entityId)
    return send(res, 400, { detail: 'file and entity_id are required' });
  if (file.name.includes('unreadable')) {
    return send(res, 422, { detail: 'Could not read any invoice data from this document' });
  }
  // The same file twice is refused, as the agent does (by the file's SHA-256).
  const sha256 = createHash('sha256')
    .update(Buffer.from(await file.arrayBuffer()))
    .digest('hex');
  const { data: same } = await supabase
    .from('invoices')
    .select('invoice_number')
    .eq('entity_id', entityId)
    .eq('file_sha256', sha256)
    .limit(1)
    .maybeSingle();
  if (same) {
    return send(res, 409, {
      detail: `This file is already in your invoices as ${same.invoice_number}.`,
    });
  }
  const type = form.get('invoice_type') === 'SALE' ? 'SALE' : 'PURCHASE';
  const name = type === 'SALE' ? 'Stand-in Customer Ltd' : 'Stand-in Supplier Ltd';

  const { data: existing } = await supabase
    .from('contacts')
    .select('id, name, company_name')
    .eq('entity_id', entityId)
    .eq('name', name)
    .maybeSingle();
  const contact =
    existing ??
    (
      await supabase
        .from('contacts')
        .insert({
          entity_id: entityId,
          name,
          company_name: name,
          contact_type: type === 'SALE' ? 'customer' : 'supplier',
        })
        .select('id, name, company_name')
        .single()
    ).data;

  const number = `E2E-UP-${Date.now() % 1_000_000}`;
  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({
      entity_id: entityId,
      invoice_number: number,
      invoice_type: type,
      status: 'DRAFT',
      counterparty_id: contact?.id,
      currency: 'GBP',
      net_amount: 50,
      tax_amount: 10,
      gross_amount: 60,
      invoice_date: new Date().toISOString(),
      due_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      source: 'manual',
      file_path: String(form.get('file_path') ?? '') || null,
      file_sha256: sha256,
    })
    .select('id, invoice_number, invoice_type')
    .single();
  if (error || !invoice) return send(res, 500, { detail: error?.message ?? 'insert failed' });
  await supabase.from('invoice_line_items').insert({
    invoice_id: invoice.id,
    description: 'Uploaded item',
    quantity: 2,
    unit_cost: 25,
    vat_rate: 0.2,
    tax_code: 'STANDARD',
  });
  send(res, 200, {
    invoice,
    contact,
    line_items: [],
    extraction: { confidence_score: 0.93 },
    payment_match: null,
  });
}

/**
 * Likely payments for an invoice, as the agent scores them (services/invoice_matching.py),
 * simplified: the right direction and currency, counted in the books, not paying another
 * invoice, within 10% of the total; the invoice number counts when it is the transaction's
 * PayPal reference. No date window. Best first.
 */
async function paymentCandidates(res: import('node:http').ServerResponse, id: string) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('entity_id, invoice_number, invoice_type, status, currency, gross_amount')
    .eq('id', id)
    .maybeSingle();
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  if (['CANCELLED', 'VOID'].includes(invoice.status)) return send(res, 200, { candidates: [] });
  const total = Number(invoice.gross_amount);
  const { data: rows } = await supabase
    .from('financial_transactions')
    .select('id, occurred_at, description, counterparty_name, amount, currency_code, metadata')
    .eq('entity_id', invoice.entity_id)
    .eq('direction', invoice.invoice_type === 'SALE' ? 'in' : 'out')
    .eq('currency_code', invoice.currency)
    .is('excluded_reason', null)
    .gte('amount', total * 0.9)
    .lte('amount', total * 1.1)
    .limit(200);
  const ids = (rows ?? []).map(r => r.id as string);
  const { data: taken } = ids.length
    ? await supabase
        .from('invoice_payments')
        .select('financial_transaction_id')
        .in('financial_transaction_id', ids)
    : { data: [] };
  const busy = new Set((taken ?? []).map(t => t.financial_transaction_id as string));
  const candidates = (rows ?? [])
    .filter(r => !busy.has(r.id as string))
    .map(r => {
      const amount = Number(r.amount);
      const exact = Math.abs(amount - total) < 0.005;
      const number =
        (r.metadata as { invoice_id?: string } | null)?.invoice_id === invoice.invoice_number;
      return {
        transaction_id: r.id,
        occurred_at: r.occurred_at,
        description: r.description,
        counterparty: r.counterparty_name,
        amount,
        currency: r.currency_code,
        reasons: [
          ...(number ? ['Invoice number on the transaction'] : []),
          exact ? 'Exact amount' : 'Amount within 10%',
        ],
        confident: number && exact,
        score: (number ? 50 : 0) + (exact ? 30 : 15) - Math.abs(amount - total) / total,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  send(res, 200, { candidates });
}

async function setStatus(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const body = await readJson<{
    entity_id: string;
    status: string;
    paid_outside_bank?: string;
    note?: string;
  }>(req);
  const { status } = body;
  const invoice = await invoiceWithLines(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  // Paid with no bank transaction behind it, as the agent records it; undoing a payment
  // clears how it was paid (InvoiceService.set_invoice_status).
  const outside = body.paid_outside_bank
    ? {
        paid_outside_bank: body.paid_outside_bank,
        paid_outside_bank_note: body.note?.trim() || null,
      }
    : status !== 'PAID'
      ? { paid_outside_bank: null, paid_outside_bank_note: null }
      : {};
  const { error } = await supabase
    .from('invoices')
    .update({ status, ...outside })
    .eq('id', id);
  if (error) return send(res, 500, { detail: error.message });
  send(res, 200, { invoice: { id, status }, previous_status: invoice.status });
}

/** Set the status the invoice's payment links imply (drafts and dead invoices keep theirs). */
async function settleFromPayments(id: string) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('status, gross_amount')
    .eq('id', id)
    .single();
  const { data: links } = await supabase
    .from('invoice_payments')
    .select('amount')
    .eq('invoice_id', id);
  const current = invoice!.status as string;
  if (!['OPEN', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'].includes(current)) return current;
  const paid = (links ?? []).reduce((n, l) => n + Number(l.amount), 0);
  const status = !links?.length
    ? current === 'OVERDUE'
      ? 'OVERDUE'
      : 'OPEN'
    : paid >= Number(invoice!.gross_amount) * 0.95
      ? 'PAID'
      : 'PARTIALLY_PAID';
  if (status !== current) await supabase.from('invoices').update({ status }).eq('id', id);
  return status;
}

async function linkPayment(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const { entity_id, transaction_id } = await readJson<{
    entity_id: string;
    transaction_id: string;
  }>(req);
  const { data: txn } = await supabase
    .from('financial_transactions')
    .select('id, amount, currency_code')
    .eq('id', transaction_id)
    .maybeSingle();
  if (!txn) return send(res, 404, { detail: `Transaction not found: ${transaction_id}` });
  const { data: taken } = await supabase
    .from('invoice_payments')
    .select('invoice_id')
    .eq('financial_transaction_id', transaction_id)
    .maybeSingle();
  if (taken && taken.invoice_id !== id) {
    return send(res, 409, { detail: 'That transaction is already matched to another invoice.' });
  }
  if (!taken) {
    const { error } = await supabase.from('invoice_payments').insert({
      entity_id,
      invoice_id: id,
      financial_transaction_id: transaction_id,
      amount: Math.abs(Number(txn.amount)),
      currency_code: txn.currency_code,
      matched_by: 'user',
    });
    if (error) return send(res, 500, { detail: error.message });
  }
  send(res, 200, { id, status: await settleFromPayments(id) });
}

async function unlinkPayment(res: import('node:http').ServerResponse, id: string, txnId: string) {
  const { data } = await supabase
    .from('invoice_payments')
    .delete()
    .eq('invoice_id', id)
    .eq('financial_transaction_id', txnId)
    .select('id');
  if (!data?.length) {
    return send(res, 409, { detail: 'That transaction is not matched to this invoice.' });
  }
  send(res, 200, { id, status: await settleFromPayments(id) });
}

async function updateInvoice(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const body = await readJson<{
    notes?: string;
    invoice_type?: string;
    line_item_gl_accounts?: Record<string, string | null>;
    line_items?: Record<string, { line_kind?: string; product_id?: string | null }>;
  }>(req);
  const patch: Record<string, unknown> = {};
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.invoice_type) patch.invoice_type = body.invoice_type;
  if (Object.keys(patch).length) await supabase.from('invoices').update(patch).eq('id', id);
  for (const [lineId, gl] of Object.entries(body.line_item_gl_accounts ?? {})) {
    await supabase
      .from('invoice_line_items')
      .update({ gl_account_id: gl })
      .eq('id', lineId)
      .eq('invoice_id', id);
  }
  // What a line bought, as the agent records it (InvoiceService._line_patches): a product
  // makes it a product line, a sample or other line has no product. Only the line is written.
  for (const [lineId, u] of Object.entries(body.line_items ?? {})) {
    const patch = u.product_id
      ? { line_kind: 'product', product_id: u.product_id }
      : u.line_kind === 'sample' || u.line_kind === 'other'
        ? { line_kind: u.line_kind, product_id: null }
        : {
            ...(u.line_kind === 'product' ? { line_kind: 'product' } : {}),
            ...('product_id' in u ? { product_id: null } : {}),
          };
    await supabase.from('invoice_line_items').update(patch).eq('id', lineId).eq('invoice_id', id);
  }
  send(res, 200, { id });
}

async function deleteInvoice(res: import('node:http').ServerResponse, id: string) {
  const invoice = await invoiceWithLines(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  // The agent's rules (invoice_rules.check_editable / check_deletable): a Revolut payment
  // request never goes, an invoice read from a receipt always can.
  if (invoice.origin === 'revolut_merchant') {
    return send(res, 409, {
      detail: 'This invoice is synced from Revolut. It would come back on the next sync.',
    });
  }
  if (
    invoice.origin !== 'revolut_expense' &&
    !['DRAFT', 'CANCELLED', 'VOID'].includes(invoice.status)
  ) {
    return send(res, 409, {
      detail: `A ${invoice.status.toLowerCase()} invoice cannot be deleted. Void it instead.`,
    });
  }
  await supabase.from('invoices').delete().eq('id', id);
  send(res, 200, { success: true, deleted: true });
}

async function reverseJournal(res: import('node:http').ServerResponse, id: string) {
  const { data: journal } = await supabase
    .from('journals')
    .select('id, entity_id, status, journal_date')
    .eq('id', id)
    .maybeSingle();
  if (!journal) return send(res, 404, { detail: 'Journal not found' });
  if (journal.status !== 'posted')
    return send(res, 400, { detail: 'Only posted journals can be reversed' });
  const day = String(journal.journal_date).slice(0, 10);
  const { data: locked } = await supabase
    .from('accounting_periods')
    .select('end_date')
    .eq('entity_id', journal.entity_id)
    .in('status', ['closed', 'filed'])
    .lte('start_date', day)
    .gte('end_date', day)
    .limit(1);
  if (locked && locked.length > 0) {
    return send(res, 409, {
      detail: `Accounting period is locked through ${locked[0].end_date}: cannot reverse a journal dated ${day}.`,
    });
  }
  await supabase.from('journals').update({ status: 'reversed' }).eq('id', id);
  send(res, 200, { id, status: 'reversed' });
}

async function postDraftJournal(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const body = await readJson<{ account_id?: string }>(req);
  const { data: journal } = await supabase
    .from('journals')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (!journal) return send(res, 404, { detail: 'Journal not found' });
  if (journal.status !== 'draft')
    return send(res, 400, { detail: 'Only draft journals can be posted' });
  const { data: fallback } = await supabase
    .from('chart_of_accounts')
    .select('id')
    .eq('account_number', 8090)
    .limit(1);
  const fallbackId = fallback?.[0]?.id;
  const { data: lines } = await supabase
    .from('journal_line_items')
    .select('id, account_id')
    .eq('journal_id', id);
  const target = (lines ?? []).find(l => l.account_id === fallbackId);
  if (!target || !body.account_id) return send(res, 400, { detail: 'Nothing to recategorise' });
  await supabase
    .from('journal_line_items')
    .update({ account_id: body.account_id })
    .eq('id', target.id);
  await supabase
    .from('journals')
    .update({ status: 'posted', posted_at: new Date().toISOString() })
    .eq('id', id);
  send(res, 200, { id, status: 'posted' });
}

async function suggestAccounts(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
) {
  const body = await readJson<{ journal_ids?: string[] }>(req);
  const { data: journals } = await supabase
    .from('journals')
    .select('id, description')
    .in('id', body.journal_ids ?? []);
  const { data: accounts } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .in('account_number', [6300, 6500]);
  const idOf = (n: number) => accounts?.find(a => Number(a.account_number) === n)?.id ?? null;
  const suggestions: Record<string, unknown> = {};
  for (const j of journals ?? []) {
    const text = String(j.description ?? '').toLowerCase();
    const account = text.includes('ad ')
      ? idOf(6500)
      : text.includes('postage')
        ? idOf(6300)
        : null;
    suggestions[j.id] = {
      account_id: account,
      confidence: account ? 0.8 : 0,
      reasoning: account
        ? 'Looks like a stand-in guess from the description'
        : 'No confident match',
    };
  }
  send(res, 200, { suggestions });
}

// ─── Journal splits (services/invoice_split.py, simplified) ─────────────────────────────────

const SPLITTABLE = ['expense'];
const cents = (n: number) => Math.round(n * 100) / 100;

interface StandInLine {
  account_id: string;
  debit: number;
  credit: number;
  currency: string | null;
  description: string | null;
}

async function liveJournals(entityId: string, transactionId: string) {
  const { data } = await supabase
    .from('journals')
    .select(
      'id, journal_type, status, journal_date, metadata, journal_line_items(account_id, debit, credit, currency, description)'
    )
    .eq('entity_id', entityId)
    .eq('source_type', 'financial_transaction')
    .eq('source_id', transactionId)
    .neq('status', 'reversed');
  return (data ?? []).map(j => ({
    ...j,
    lines: (j.journal_line_items as StandInLine[]).map(l => ({
      ...l,
      debit: Number(l.debit),
      credit: Number(l.credit),
    })),
  }));
}

async function splitInvoice(id: string) {
  const { data } = await supabase
    .from('invoices')
    .select(
      'id, entity_id, invoice_number, invoice_type, currency, gross_amount, invoice_line_items(id, description, quantity, unit_cost, vat_rate, line_gross, gl_account_id), invoice_payments(financial_transaction_id)'
    )
    .eq('id', id)
    .maybeSingle();
  return data;
}

type SplitInvoice = NonNullable<Awaited<ReturnType<typeof splitInvoice>>>;

async function proposalFor(invoice: SplitInvoice, transactionId: string) {
  const { data: txn } = await supabase
    .from('financial_transactions')
    .select('id, occurred_at, amount, currency_code, excluded_reason')
    .eq('id', transactionId)
    .single();
  const live = await liveJournals(invoice.entity_id, transactionId);
  const { data: accountRows } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number, name');
  const account = new Map((accountRows ?? []).map(a => [a.id as string, a]));
  const shown = (l: StandInLine) => ({
    ...l,
    account_number: account.get(l.account_id)?.account_number ?? null,
    account_name: account.get(l.account_id)?.name ?? null,
  });
  const gross = Number(invoice.gross_amount);
  const amount = Math.abs(Number(txn!.amount));
  const proposal = {
    transaction_id: transactionId,
    state: 'unsupported',
    reason: null as string | null,
    occurred_at: txn!.occurred_at,
    payment_amount: amount,
    payment_currency: txn!.currency_code,
    journal_amount: null as number | null,
    journal_currency: null as string | null,
    share_of_invoice:
      gross && txn!.currency_code === invoice.currency
        ? Math.round((amount / gross) * 10000) / 10000
        : null,
    replaces: [] as { id: string; journal_type: string; status: string }[],
    current_lines: [] as ReturnType<typeof shown>[],
    lines: [] as (ReturnType<typeof shown> & Record<string, unknown>)[],
    split_journal_id: null as string | null,
    items: [] as StandInLine[],
  };
  const applied = live.find(j => j.journal_type === 'invoice_split');
  if (applied) {
    return {
      ...proposal,
      state: 'applied',
      split_journal_id: applied.id,
      lines: applied.lines.map(shown),
    };
  }
  if (txn!.excluded_reason) {
    return { ...proposal, reason: 'The payment is left out of the books, so it has no journal.' };
  }
  if (invoice.invoice_type !== 'PURCHASE') {
    return { ...proposal, reason: 'Only purchases can be split for now.' };
  }
  if (live.length === 0) {
    return {
      ...proposal,
      state: 'not_journaled',
      reason: 'The payment has no journal yet. Generate journals, then split it.',
    };
  }
  if (live.length !== 1 || !SPLITTABLE.includes(live[0].journal_type)) {
    return { ...proposal, reason: 'Only a payment journaled as one expense can be split.' };
  }
  const journal = live[0];
  const debit = journal.lines.find(l => l.debit > 0)!;
  const total = debit.debit;
  const weighted = invoice.invoice_line_items
    .map(l => ({
      ...l,
      weight:
        l.line_gross != null
          ? Number(l.line_gross)
          : Number(l.quantity) * Number(l.unit_cost) * (1 + Number(l.vat_rate)),
    }))
    .filter(l => l.weight > 0);
  const sum = weighted.reduce((n, l) => n + l.weight, 0);
  const shares = weighted.map(l => cents((total * l.weight) / sum));
  const largest = weighted.reduce((best, l, i) => (l.weight > weighted[best].weight ? i : best), 0);
  shares[largest] = cents(shares[largest] + total - shares.reduce((n, a) => n + a, 0));
  const debits = weighted.map((l, i) => ({
    account_id: (l.gl_account_id as string | null) ?? debit.account_id,
    debit: shares[i],
    credit: 0,
    currency: debit.currency,
    description: `${invoice.invoice_number}: ${l.description}`,
  }));
  const credits = journal.lines.filter(l => l.credit > 0);
  return {
    ...proposal,
    state: 'ready',
    journal_amount: total,
    journal_currency: debit.currency,
    replaces: [{ id: journal.id, journal_type: journal.journal_type, status: journal.status }],
    current_lines: journal.lines.map(shown),
    lines: [
      ...debits.map((d, i) => ({
        ...shown(d),
        line_item_id: weighted[i].id,
        vat: 0,
        from_invoice_account: !!weighted[i].gl_account_id,
      })),
      ...credits.map(shown),
    ],
    items: [...debits, ...credits],
    journal_date: journal.journal_date,
  };
}

async function splitProposals(res: import('node:http').ServerResponse, id: string) {
  const invoice = await splitInvoice(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  const proposals = await Promise.all(
    invoice.invoice_payments.map(p => proposalFor(invoice, p.financial_transaction_id as string))
  );
  // The journal items are for applying; the agent does not return them.
  send(res, 200, { proposals: proposals.map(p => ({ ...p, items: undefined })) });
}

async function applySplit(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const { transaction_id } = await readJson<{ transaction_id: string }>(req);
  const invoice = await splitInvoice(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  if (!invoice.invoice_payments.some(p => p.financial_transaction_id === transaction_id)) {
    return send(res, 409, { detail: 'That transaction is not matched to this invoice.' });
  }
  const proposal = await proposalFor(invoice, transaction_id);
  if (proposal.state !== 'ready' || !('journal_date' in proposal)) {
    return send(res, 409, { detail: proposal.reason ?? 'This payment’s journal cannot be split.' });
  }
  const [replaced] = proposal.replaces;
  await supabase.from('journals').update({ status: 'reversed' }).eq('id', replaced.id);
  const { data: journal, error } = await supabase
    .from('journals')
    .insert({
      entity_id: invoice.entity_id,
      journal_date: proposal.journal_date,
      journal_type: 'invoice_split',
      description: `Split by invoice ${invoice.invoice_number}`,
      source_type: 'financial_transaction',
      source_id: transaction_id,
      status: 'posted',
      posted_at: new Date().toISOString(),
      metadata: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        replaces: [{ id: replaced.id, status: replaced.status }],
      },
    })
    .select('id')
    .single();
  if (error) return send(res, 500, { detail: error.message });
  await supabase.from('journal_line_items').insert(
    proposal.items.map(item => ({
      ...item,
      journal_id: journal.id,
      effective_date: proposal.journal_date,
    }))
  );
  send(res, 200, { journal_id: journal.id, replaced: [replaced.id] });
}

async function undoSplit(res: import('node:http').ServerResponse, id: string, txnId: string) {
  const invoice = await splitInvoice(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  const split = (await liveJournals(invoice.entity_id, txnId)).find(
    j =>
      j.journal_type === 'invoice_split' &&
      (j.metadata as { invoice_id?: string } | null)?.invoice_id === id
  );
  if (!split)
    return send(res, 409, { detail: 'This payment’s journal is not split by this invoice.' });
  await supabase.from('journals').update({ status: 'reversed' }).eq('id', split.id);
  for (const previous of (split.metadata as { replaces: { id: string; status: string }[] })
    .replaces) {
    await supabase.from('journals').update({ status: previous.status }).eq('id', previous.id);
  }
  send(res, 200, { journal_id: split.id, undone: true });
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });

  // Like the real agent, answer only a signed-in user: the token must be a live Supabase one.
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const { data: caller } = bearer ? await supabase.auth.getUser(bearer) : { data: { user: null } };
  if (!caller.user) return send(res, 401, { detail: 'Missing or invalid bearer token' });

  // Where Zoho would send the user to consent; the test follows the redirect back to the app.
  if (req.method === 'GET' && req.url === '/oauth/zoho_calendar/authorize-url') {
    return send(res, 200, {
      url: `http://localhost:${process.env.E2E_PORT ?? 5180}/integrations?zoho_calendar=connected`,
    });
  }

  if (req.method === 'POST' && req.url === '/accounting/inventory/disposal') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as {
      inventory_item_id?: string;
      disposal_type?: string;
      quantity?: number;
    };
    if (!body.inventory_item_id || !['GIFT', 'WRITE_OFF'].includes(body.disposal_type ?? '')) {
      return send(res, 400, { detail: 'Invalid disposal' });
    }
    const quantity = Number(body.quantity);
    if (!(quantity > 0) || quantity > 1000) {
      return send(res, 422, { detail: 'Quantity exceeds the stock that can be disposed of' });
    }
    const { data: item } = await supabase
      .from('inventory_items')
      .select('unit_cost')
      .eq('id', body.inventory_item_id)
      .single();
    const { error } = await supabase.from('inventory_movements').insert({
      inventory_item_id: body.inventory_item_id,
      transaction_type: body.disposal_type,
      quantity: -quantity,
      unit_cost: item?.unit_cost ?? 0,
      movement_date: new Date().toISOString(),
      movement_date_source: 'backdated',
      notes: STAND_IN_NOTE,
    });
    if (error) return send(res, 500, { detail: error.message });
    return send(res, 200, { success: true });
  }

  const invoiceRoute =
    /^\/accounting\/invoices\/([0-9a-f-]{36})(\/status|\/payment-candidates|\/payments(?:\/[0-9a-f-]{36})?|\/split(?:\/[0-9a-f-]{36})?)?(\?.*)?$/.exec(
      req.url ?? ''
    );
  if (req.method === 'POST' && req.url === '/accounting/invoices/process') {
    return processInvoice(req, res);
  }
  if (invoiceRoute) {
    const [, id, suffix] = invoiceRoute;
    if (req.method === 'PATCH' && suffix === '/status') return setStatus(req, res, id);
    if (req.method === 'GET' && suffix === '/payment-candidates') return paymentCandidates(res, id);
    if (req.method === 'PATCH' && !suffix) return updateInvoice(req, res, id);
    if (req.method === 'DELETE' && !suffix) return deleteInvoice(res, id);
    if (req.method === 'POST' && suffix === '/payments') return linkPayment(req, res, id);
    if (req.method === 'DELETE' && suffix?.startsWith('/payments/')) {
      return unlinkPayment(res, id, suffix.slice('/payments/'.length));
    }
    if (req.method === 'GET' && suffix === '/split') return splitProposals(res, id);
    if (req.method === 'POST' && suffix === '/split') return applySplit(req, res, id);
    if (req.method === 'DELETE' && suffix?.startsWith('/split/')) {
      return undoSplit(res, id, suffix.slice('/split/'.length));
    }
  }

  if (req.method === 'POST' && req.url === '/accounting/journals/suggest-accounts') {
    return suggestAccounts(req, res);
  }
  const journalRoute = /^\/accounting\/journals\/([0-9a-f-]{36})\/(reverse|post-draft)$/.exec(
    req.url ?? ''
  );
  if (req.method === 'POST' && journalRoute) {
    const [, id, verb] = journalRoute;
    return verb === 'reverse' ? reverseJournal(res, id) : postDraftJournal(req, res, id);
  }

  send(res, 404, { detail: 'Not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Stand-in agent on :${PORT}`));
