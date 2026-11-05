/**
 * Invoice API route
 *
 * GET  ?id=<invoice>            the invoice with its lines, matched payment and pickers
 * GET  ?id=<invoice>&document=1 where to open its document: a short-lived signed URL for the
 *                               upload or the receipt it was read from, or the printable copy
 * POST intent=upload            store the file, have the agent extract it into a DRAFT invoice
 * POST intent=attachOriginal    keep a file as the document of an invoice that has no upload
 *                               (a Revolut payment request's original, say); it is not read
 * POST intent=setStatus         move the invoice through its lifecycle (nothing is posted)
 * POST intent=update            notes, direction (drafts only) and the GL account of each line
 * POST intent=delete            remove a draft, cancelled or void invoice
 * POST intent=matchPayment      link a bank transaction as the invoice's payment (unmatchPayment undoes
 *                               it); the agent then sets paid or part paid from what is linked
 * POST intent=split             replace a matched payment's journal with its split by the
 *                               invoice's lines (undoSplit puts the previous journal back)
 *
 * Every invoice is first fetched as the signed-in user (row-level security), so one user can
 * never read or change another's by guessing an id. Rules about *what* may change (lifecycle,
 * deletion, direction) are enforced by the agent; this route does not duplicate them, it only
 * shows the agent's refusal.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import {
  AgentError,
  callAgent,
  documentUrlFor,
  getInvoiceDetail,
  getOwnedInvoice,
  getUserEntity,
  jsonInit,
  type OwnedInvoice,
} from '~/lib/api/invoices.server';
import { requestAccessToken } from '~/lib/api/agent-auth.server';
import { getServerSupabaseClient } from '~/lib/supabase';
import type { LineUpdate } from '~/types/invoice';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STATUSES = ['DRAFT', 'OPEN', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED', 'VOID'];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fail = (error: string, status: number) => json({ ok: false, error }, status);

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
      const documentUrl = await documentUrlFor(request, invoice);
      if (!documentUrl) return fail('No document is attached to this invoice', 404);
      return json({ ok: true, url: documentUrl });
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
        return await setStatus(request, invoice, form);
      case 'update':
        return await update(request, invoice, form);
      case 'delete':
        return await remove(request, invoice);
      case 'attachOriginal':
        return await attachOriginal(invoice, form);
      case 'matchPayment':
      case 'unmatchPayment':
        return await matchPayment(request, invoice, form, intent === 'matchPayment');
      case 'split':
      case 'undoSplit':
        return await split(request, invoice, form, intent === 'split');
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
  const file = fileFrom(form);
  if (typeof file === 'string') return fail(file, 400);

  const entityId = (await getUserEntity(request))?.id;
  if (!entityId) return fail('Sign in to add invoices', 401);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const storagePath = storagePathFor(entityId, file);
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
      payment_match: { amount: number; currency: string; occurred_at: string } | null;
    }>('/accounting/invoices/process', await requestAccessToken(request), {
      method: 'POST',
      body: agentForm,
    });
    return json({
      ok: true,
      invoiceId: result.invoice.id,
      invoiceNumber: result.invoice.invoice_number,
      direction: result.invoice.invoice_type,
      counterparty: result.contact?.company_name || result.contact?.name || null,
      confidence: result.extraction?.confidence_score ?? null,
      // Linked on upload because one payment carries its number and exact amount.
      paymentMatched: !!result.payment_match,
    });
  } catch (error) {
    // Extraction failed, so no invoice points at the file: do not leave it orphaned.
    await storage.remove([storagePath]);
    throw error;
  }
}

/** The file, checked: a PDF or image under the size limit. */
function fileFrom(form: FormData): File | string {
  const file = form.get('file');
  if (!(file instanceof File)) return 'No file was provided';
  if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
    return 'Only PDF and image files can be added';
  }
  if (file.size > MAX_FILE_BYTES) return 'That file is over the 10 MB limit';
  return file;
}

const storagePathFor = (entityId: string, file: File) =>
  `${entityId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

/**
 * Keep a file as an invoice's document. Only for an invoice with no upload yet: an upload's own
 * file was read into it, so replacing it would leave the two disagreeing. The file is stored
 * and pointed at, not read: the invoice's figures stay what they are.
 *
 * `invoices` has no write policy for users, so the service role writes `file_path`, and only
 * after `invoice` was read as the user (the caller does that).
 */
async function attachOriginal(invoice: OwnedInvoice, form: FormData) {
  if (invoice.file_path) return fail('This invoice already has its document', 409);
  const file = fileFrom(form);
  if (typeof file === 'string') return fail(file, 400);

  const service = getServerSupabaseClient();
  const storagePath = storagePathFor(invoice.entity_id, file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: storageError } = await service.storage
    .from('invoices')
    .upload(storagePath, bytes, { contentType: file.type, upsert: false });
  if (storageError) return fail(`The file could not be stored: ${storageError.message}`, 500);

  const { error } = await service
    .from('invoices')
    .update({ file_path: storagePath })
    .eq('id', invoice.id)
    .eq('entity_id', invoice.entity_id)
    .is('file_path', null);
  if (error) {
    await service.storage.from('invoices').remove([storagePath]);
    return fail(`The document could not be saved: ${error.message}`, 500);
  }
  return json({ ok: true });
}

async function setStatus(request: Request, invoice: OwnedInvoice, form: FormData) {
  const status = String(form.get('status') ?? '').toUpperCase();
  if (!STATUSES.includes(status)) return fail('Unknown status', 400);

  // Paid with no bank transaction behind it: how (cash, personally), and a note.
  const how = form.get('paidOutsideBank');
  const outside =
    how === 'cash' || how === 'paid_personally' || how === 'other'
      ? { paid_outside_bank: how, note: String(form.get('note') ?? '') }
      : {};
  await callAgent(
    `/accounting/invoices/${invoice.id}/status`,
    await requestAccessToken(request),
    jsonInit('PATCH', { entity_id: invoice.entity_id, status, ...outside })
  );
  return json({ ok: true, status });
}

async function matchPayment(
  request: Request,
  invoice: OwnedInvoice,
  form: FormData,
  match: boolean
) {
  const transactionId = String(form.get('transactionId') ?? '');
  if (!transactionId) return fail('A transaction id is required', 400);
  const token = await requestAccessToken(request);
  const path = `/accounting/invoices/${invoice.id}/payments`;
  await (match
    ? callAgent(
        path,
        token,
        jsonInit('POST', { entity_id: invoice.entity_id, transaction_id: transactionId })
      )
    : callAgent(
        `${path}/${encodeURIComponent(transactionId)}?entity_id=${encodeURIComponent(invoice.entity_id)}`,
        token,
        { method: 'DELETE' }
      ));
  return json({ ok: true });
}

async function split(request: Request, invoice: OwnedInvoice, form: FormData, apply: boolean) {
  const transactionId = String(form.get('transactionId') ?? '');
  if (!transactionId) return fail('A transaction id is required', 400);
  const token = await requestAccessToken(request);
  const path = `/accounting/invoices/${invoice.id}/split`;
  await (apply
    ? callAgent(
        path,
        token,
        jsonInit('POST', { entity_id: invoice.entity_id, transaction_id: transactionId })
      )
    : callAgent(
        `${path}/${encodeURIComponent(transactionId)}?entity_id=${encodeURIComponent(invoice.entity_id)}`,
        token,
        { method: 'DELETE' }
      ));
  return json({ ok: true });
}

async function update(request: Request, invoice: OwnedInvoice, form: FormData) {
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
  // What each line bought: shown on the invoice only, it changes no product or stock.
  const kinds = parseJson<Record<string, LineUpdate>>(form.get('lineKinds'));
  if (form.get('lineKinds') !== null && !kinds) {
    return fail('What the lines bought was not understood', 400);
  }
  if (kinds) body.line_items = kinds;

  await callAgent(
    `/accounting/invoices/${invoice.id}`,
    await requestAccessToken(request),
    jsonInit('PATCH', body)
  );
  return json({ ok: true });
}

async function remove(request: Request, invoice: OwnedInvoice) {
  await callAgent(
    `/accounting/invoices/${invoice.id}?entity_id=${encodeURIComponent(invoice.entity_id)}`,
    await requestAccessToken(request),
    { method: 'DELETE' }
  );
  return json({ ok: true });
}
