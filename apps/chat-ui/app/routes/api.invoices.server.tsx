/**
 * Invoice API Route
 *
 * Handles invoice operations:
 * - POST upload: forwards file to AI Agent for extraction and record creation
 * - POST updateStatus: patches invoice status
 * - POST delete: removes invoice record
 * - POST getUrl / download: signed URL from Supabase Storage
 */

import type { ActionFunctionArgs } from 'react-router';
import { redirect } from 'react-router';
import {
  deleteInvoice,
  getInvoice,
  getInvoiceUrl,
  listInvoices,
  getInvoiceStats,
  updateInvoiceStatus,
} from '~/lib/api/invoices.server';
import { getServerSupabaseClient } from '~/lib/supabase';

// AI Agent base URL
const AI_AGENT_URL =
  process.env.AI_AGENT_URL || process.env.VITE_AI_AGENT_URL || 'http://localhost:2024';

// Helper to return JSON responses
function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get('intent') as string;

  try {
    switch (intent) {
      case 'upload': {
        const file = formData.get('file') as File;
        if (!file || !(file instanceof File)) {
          return json({ error: 'No file provided' }, { status: 400 });
        }

        if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
          return json({ error: 'Only PDF and image files are allowed' }, { status: 400 });
        }

        if (file.size > 10 * 1024 * 1024) {
          return json({ error: 'File size exceeds 10MB limit' }, { status: 400 });
        }

        const entityId = (formData.get('entity_id') as string | null) ?? undefined;
        if (!entityId) {
          return json(
            { error: 'entity_id is required. Ensure you are logged in.' },
            { status: 400 }
          );
        }

        // ---- 1. Store file in Supabase Storage for viewing/download ----
        const supabase = getServerSupabaseClient();
        const timestamp = Date.now();
        const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const storagePath = `${entityId ?? 'general'}/${timestamp}-${sanitizedName}`;

        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const { error: storageError } = await supabase.storage
          .from('invoices')
          .upload(storagePath, uint8Array, {
            contentType: file.type,
            upsert: false,
          });

        if (storageError) {
          console.error('Storage upload failed:', storageError);
          return json({ error: `File storage failed: ${storageError.message}` }, { status: 500 });
        }

        // ---- 2. Forward to AI Agent for extraction + record creation ----
        const agentForm = new FormData();
        agentForm.append('file', new Blob([uint8Array], { type: file.type }), file.name);
        if (entityId) agentForm.append('entity_id', entityId);
        agentForm.append('file_path', storagePath);

        const invoiceType = formData.get('invoice_type') as string | null;
        if (invoiceType) agentForm.append('invoice_type', invoiceType);

        const agentResponse = await fetch(`${AI_AGENT_URL}/accounting/invoices/process`, {
          method: 'POST',
          body: agentForm,
        });

        if (!agentResponse.ok) {
          const errText = await agentResponse.text();
          console.error('AI Agent error:', errText);
          return json({ error: 'AI processing failed', detail: errText }, { status: 502 });
        }

        const result = await agentResponse.json();
        return json({ success: true, ...result });
      }

      case 'updateStatus': {
        const invoiceId = formData.get('invoiceId') as string;
        const status = formData.get('status') as string;
        if (!invoiceId || !status) {
          return json({ error: 'invoiceId and status are required' }, { status: 400 });
        }

        const { invoice, error } = await updateInvoiceStatus(invoiceId, {
          status: status as import('~/types/invoice').InvoiceStatus,
        });

        if (error) return json({ error }, { status: 500 });

        // When marked as paid, create the payment settlement journal in the AI agent.
        // Non-fatal — the status change succeeds regardless of journal creation.
        if (status === 'PAID' && invoice?.entity_id) {
          try {
            await fetch(`${AI_AGENT_URL}/accounting/journals/invoice-payment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entity_id: invoice.entity_id, invoice_id: invoiceId }),
            });
          } catch {
            // Intentionally swallowed — journal can be recreated later if needed
          }
        }

        return json({ success: true, invoice });
      }

      case 'delete': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const { success, error } = await deleteInvoice(invoiceId);
        if (error) return json({ error }, { status: 500 });
        return json({ success: true });
      }

      case 'getUrl': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const { invoice, error } = await getInvoice(invoiceId);
        if (error || !invoice) return json({ error: error ?? 'Not found' }, { status: 404 });

        // file_path holds the Supabase storage path; source is now the platform label
        const storagePath = invoice.file_path;
        if (!storagePath)
          return json({ error: 'No file attached to this invoice' }, { status: 404 });

        const signedUrl = await getInvoiceUrl(storagePath);
        if (!signedUrl) return json({ error: 'Failed to generate URL' }, { status: 500 });

        return json({ success: true, signedUrl });
      }

      case 'download': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const { invoice, error } = await getInvoice(invoiceId);
        if (error || !invoice) return json({ error: error ?? 'Not found' }, { status: 404 });

        const storagePath = invoice.file_path;
        if (!storagePath)
          return json({ error: 'No file attached to this invoice' }, { status: 404 });

        const signedUrl = await getInvoiceUrl(storagePath, 60);
        if (!signedUrl) return json({ error: 'Failed to generate download URL' }, { status: 500 });

        return redirect(signedUrl);
      }

      case 'createProducts': {
        const invoiceId = formData.get('invoiceId') as string;
        const entityId = formData.get('entity_id') as string;
        const lineItemIdsJson = formData.get('lineItemIds') as string;
        const overridesJson = formData.get('overrides') as string | null;

        if (!invoiceId || !entityId || !lineItemIdsJson) {
          return json(
            { error: 'invoiceId, entity_id, and lineItemIds are required' },
            { status: 400 }
          );
        }

        let lineItemIds: string[];
        try {
          lineItemIds = JSON.parse(lineItemIdsJson);
        } catch {
          return json({ error: 'lineItemIds must be valid JSON array' }, { status: 400 });
        }

        let overrides: Record<string, { name: string; sku: string }> | undefined;
        if (overridesJson) {
          try {
            overrides = JSON.parse(overridesJson);
          } catch {
            // ignore malformed overrides — not fatal
          }
        }

        const agentResp = await fetch(`${AI_AGENT_URL}/accounting/invoices/${invoiceId}/products`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_id: entityId, line_item_ids: lineItemIds, overrides }),
        });

        if (!agentResp.ok) {
          const errText = await agentResp.text();
          return json({ error: 'Product creation failed', detail: errText }, { status: 502 });
        }

        const result = await agentResp.json();
        return json({ success: true, ...result });
      }

      case 'updateInvoice': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'invoiceId is required' }, { status: 400 });
        }

        const body: Record<string, unknown> = {};
        const invoiceType = formData.get('invoice_type') as string | null;
        const notes = formData.get('notes') as string | null;
        const lineGlJson = formData.get('line_item_gl_accounts') as string | null;

        if (invoiceType) body.invoice_type = invoiceType;
        if (notes !== null && notes !== undefined) body.notes = notes;
        if (lineGlJson) {
          try {
            body.line_item_gl_accounts = JSON.parse(lineGlJson);
          } catch {
            return json({ error: 'line_item_gl_accounts must be valid JSON' }, { status: 400 });
          }
        }

        const agentResp = await fetch(`${AI_AGENT_URL}/accounting/invoices/${invoiceId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!agentResp.ok) {
          const errText = await agentResp.text();
          return json({ error: 'Invoice update failed', detail: errText }, { status: 502 });
        }

        const result = await agentResp.json();
        return json({ success: true, invoice: result });
      }

      default:
        return json({ error: 'Invalid intent' }, { status: 400 });
    }
  } catch (error) {
    console.error('Invoice action error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// Loader for fetching invoices list + stats
export async function loader() {
  const [{ invoices }, stats] = await Promise.all([listInvoices(), getInvoiceStats()]);
  return json({ invoices, stats });
}
