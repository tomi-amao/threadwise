/**
 * Invoice API route
 *
 * GET  ?id=<invoice>            the invoice with its lines, journals, matched payment and pickers
 * GET  ?id=<invoice>&document=1 a short-lived signed URL for the uploaded document
 * POST intent=upload            store the file, have the agent extract it into a DRAFT invoice
 * POST intent=setStatus         move the invoice through its lifecycle (the agent posts journals)
 * POST intent=update            notes, direction (drafts only) and the GL account of each line
 * POST intent=stock             decide, per purchase line, how it is tracked as stock
 * POST intent=delete            remove a draft, cancelled or void invoice
 *
 * Every invoice is first fetched as the signed-in user (row-level security), so one user can
 * never read or change another's by guessing an id. Rules about *what* may change (lifecycle,
 * deletion, direction) are enforced by the agent, which owns the ledger; this route does not
 * duplicate them, it only shows the agent's refusal.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import {
  AgentError,
  callAgent,
  findMatchingTransaction,
  getDocumentUrl,
  getInvoiceDetail,
  getOwnedInvoice,
  getUserEntity,
  jsonInit,
  type OwnedInvoice,
} from '~/lib/api/invoices.server';
import { getServerSupabaseClient } from '~/lib/supabase';
import type { StockDecision } from '~/types/invoice';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STATUSES = ['DRAFT', 'OPEN', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED', 'VOID'];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error, ...extra }, status);

const parseJson = <T,>(value: FormDataEntryValue | null): T | null => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return fail('An invoice id is required', 400);

  try {
    if (url.searchParams.get('document')) {
      const invoice = await getOwnedInvoice(request, id);
      if (!invoice) return fail('Invoice not found', 404);
      if (!invoice.file_path) return fail('No document is attached to this invoice', 404);
      return json({ ok: true, url: await getDocumentUrl(invoice.file_path) });
    }

    const detail = await getInvoiceDetail(request, id);
    if (!detail) return fail('Invoice not found', 404);
    return json({ ok: true, detail });
  } catch (error) {
    console.error('Invoice loader error:', error);
    return fail(error instanceof Error ? error.message : 'Could not load the invoice', 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const intent = form.get('intent');

  try {
    if (intent === 'upload') return await upload(request, form);

    const invoiceId = String(form.get('invoiceId') ?? '');
    if (!invoiceId) return fail('An invoice id is required', 400);
    const invoice = await getOwnedInvoice(request, invoiceId);
    if (!invoice) return fail('Invoice not found', 404);

    switch (intent) {
      case 'setStatus':
        return await setStatus(invoice, form);
      case 'update':
        return await update(invoice, form);
      case 'stock':
        return await stock(invoice, form);
      case 'delete':
        return await remove(invoice);
      default:
        return fail('Unknown action', 400);
    }
  } catch (error) {
    if (error instanceof AgentError) return fail(error.message, error.status);
    console.error('Invoice action error:', error);
    return fail(error instanceof Error ? error.message : 'Something went wrong', 500);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────

async function upload(request: Request, form: FormData) {
  const file = form.get('file');
  if (!(file instanceof File)) return fail('No file was provided', 400);
  if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
    return fail('Only PDF and image files can be added', 400);
  }
  if (file.size > MAX_FILE_BYTES) return fail('That file is over the 10 MB limit', 400);

  const entityId = (await getUserEntity(request))?.id;
  if (!entityId) return fail('Sign in to add invoices', 401);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const storagePath = `${entityId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const storage = getServerSupabaseClient().storage.from('invoices');

  const { error: storageError } = await storage.upload(storagePath, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (storageError) return fail(`The file could not be stored: ${storageError.message}`, 500);

  const agentForm = new FormData();
  agentForm.append('file', new Blob([bytes], { type: file.type }), file.name);
  agentForm.append('entity_id', entityId);
  agentForm.append('file_path', storagePath);
  const direction = form.get('direction');
  if (direction === 'SALE' || direction === 'PURCHASE') agentForm.append('invoice_type', direction);

  try {
    const result = await callAgent<{
      invoice: { id: string; invoice_number: string | null; invoice_type: string };
      contact: { name: string; company_name: string | null } | null;
      extraction: { confidence_score: number };
    }>('/accounting/invoices/process', { method: 'POST', body: agentForm });
    return json({
      ok: true,
      invoiceId: result.invoice.id,
      invoiceNumber: result.invoice.invoice_number,
      direction: result.invoice.invoice_type,
      counterparty: result.contact?.company_name || result.contact?.name || null,
      confidence: result.extraction?.confidence_score ?? null,
    });
  } catch (error) {
    // Extraction failed, so no invoice points at the file: do not leave it orphaned.
    await storage.remove([storagePath]);
    throw error;
  }
}

async function setStatus(invoice: OwnedInvoice, form: FormData) {
  const status = String(form.get('status') ?? '').toUpperCase();
  if (!STATUSES.includes(status)) return fail('Unknown status', 400);

  // Marking paid clears the payable against the bank. Without an imported payment the agent
  // cannot say which account the money left, so ask for a deliberate go-ahead.
  if (status === 'PAID' && invoice.status !== 'PAID' && form.get('confirmUnmatched') !== '1') {
    const matched = await findMatchingTransaction(invoice.invoice_number, invoice.entity_id);
    if (!matched) {
      return fail(
        'No bank payment has been matched to this invoice yet. Import the payment first, or ' +
          'mark it paid anyway.',
        409,
        { code: 'no_matching_payment' }
      );
    }
  }

  const result = await callAgent<{
    warnings?: string[];
    voided_journals?: unknown[];
    purchase_journal?: unknown;
  }>(
    `/accounting/invoices/${invoice.id}/status`,
    jsonInit('PATCH', { entity_id: invoice.entity_id, status })
  );
  return json({
    ok: true,
    status,
    posted: !!result.purchase_journal,
    voided: result.voided_journals?.length ?? 0,
    warnings: result.warnings ?? [],
  });
}

async function update(invoice: OwnedInvoice, form: FormData) {
  const body: Record<string, unknown> = { entity_id: invoice.entity_id };
  const notes = form.get('notes');
  if (typeof notes === 'string') body.notes = notes;
  const direction = form.get('direction');
  if (direction === 'SALE' || direction === 'PURCHASE') body.invoice_type = direction;
  const coding = parseJson<Record<string, string | null>>(form.get('lineAccounts'));
  if (form.get('lineAccounts') !== null && !coding) {
    return fail('The line accounts were not understood', 400);
  }
  if (coding) body.line_item_gl_accounts = coding;

  await callAgent(`/accounting/invoices/${invoice.id}`, jsonInit('PATCH', body));
  return json({ ok: true });
}

async function stock(invoice: OwnedInvoice, form: FormData) {
  const decisions = parseJson<StockDecision[]>(form.get('decisions'));
  if (!decisions || decisions.length === 0)
    return fail('Choose how at least one line is handled', 400);

  const result = await callAgent<{ recorded: number; not_recorded: string[] }>(
    `/accounting/invoices/${invoice.id}/stock`,
    jsonInit('POST', { entity_id: invoice.entity_id, decisions })
  );
  return json({ ok: true, recorded: result.recorded, notRecorded: result.not_recorded });
}

async function remove(invoice: OwnedInvoice) {
  await callAgent(
    `/accounting/invoices/${invoice.id}?entity_id=${encodeURIComponent(invoice.entity_id)}`,
    { method: 'DELETE' }
  );
  return json({ ok: true });
}
