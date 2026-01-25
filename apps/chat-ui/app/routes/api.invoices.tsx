/**
 * Invoice API Route
 *
 * Handles invoice operations:
 * - POST: Upload, update, delete, get URL
 * - Integrates with LangGraph for AI document extraction
 */

import type { ActionFunctionArgs } from 'react-router';
import { redirect } from 'react-router';
import {
  createInvoice,
  updateInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceUrl,
  listInvoices,
  getInvoiceStats,
} from '~/lib/api/invoices.server';
import { embedInvoiceFile } from '~/lib/api/embeddings.server';
import { createClient } from '@supabase/supabase-js';

// LangGraph API URL
const LANGGRAPH_API_URL = process.env.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';

// Helper to return JSON responses
function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

// Get Supabase client for storage operations
function getSupabaseClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    'https://iojdlaqvohuebsexmbad.supabase.co';
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

  return createClient(supabaseUrl, supabaseKey);
}

// Extracted document data from LangGraph
interface ExtractedDocumentData {
  document_category: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  line_items: Array<{
    description: string;
    quantity: number | null;
    unit_price: number | null;
    total_price: number | null;
  }>;
  confidence_score: number;
}

// Call LangGraph server to extract document data
async function extractDocumentData(
  base64Content: string,
  mimeType: string,
  fileName: string
): Promise<{ data: ExtractedDocumentData | null; error: string | null }> {
  try {
    // Create a thread for this extraction
    console.debug('[extractDocumentData] Start', {
      fileName,
      mimeType,
      base64Length: base64Content.length,
    });

    const model_content_type = mimeType === 'application/pdf' ? 'file' : 'image';

    const threadResponse = await fetch(`${LANGGRAPH_API_URL}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { source: 'invoice_upload', fileName } }),
    });

    console.debug('[extractDocumentData] Thread response status:', threadResponse.status);

    if (!threadResponse.ok) {
      console.error('Failed to create thread:', await threadResponse.text());
      return { data: null, error: 'Failed to create extraction thread' };
    }

    const thread = await threadResponse.json();
    console.debug('[extractDocumentData] Thread created:', thread);

    // Send the file to LangGraph for extraction
    // The message includes a file attachment that will trigger the document_extraction pathway
    const runResponse = await fetch(`${LANGGRAPH_API_URL}/threads/${thread.thread_id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistant_id: 'threadwise-financial-agent',
        input: {
          messages: [
            {
              role: 'human',
              content: [
                {
                  type: 'text',
                  text: `Please extract all invoice information from this document: ${fileName}`,
                },
                {
                  type: model_content_type,
                  source_type: 'base64',
                  mime_type: mimeType,
                  data: base64Content,
                },
              ],
            },
          ],
          model: 'chat', // Use local model for extraction
        },
        config: {
          configurable: {
            thread_id: thread.thread_id,
          },
        },
      }),
    });

    console.debug('[extractDocumentData] Run response status:', runResponse.status);

    if (!runResponse.ok) {
      console.error('Failed to run extraction:', await runResponse.text());
      return { data: null, error: 'Failed to run document extraction' };
    }

    // Wait for the run to complete and get results
    const run = await runResponse.json();

    // Poll for completion (with timeout)
    const maxWaitTime = 60000; // 60 seconds
    const pollInterval = 1000; // 1 second
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const statusResponse = await fetch(
        `${LANGGRAPH_API_URL}/threads/${thread.thread_id}/runs/${run.run_id}`
      );

      console.debug('[extractDocumentData] Polling run status:', statusResponse.status);

      if (!statusResponse.ok) {
        console.error('Failed to check run status:', await statusResponse.text());
        break;
      }

      const runStatus = await statusResponse.json();
      console.debug('[extractDocumentData] Run status:', runStatus.status);

      if (runStatus.status === 'success') {
        // Get the final state to extract document data
        const stateResponse = await fetch(`${LANGGRAPH_API_URL}/threads/${thread.thread_id}/state`);
        console.debug('[extractDocumentData] State response status:', stateResponse.status);

        if (stateResponse.ok) {
          const state = await stateResponse.json();
          // The extracted_document field contains our structured data
          if (state.values?.extracted_document) {
            return { data: state.values.extracted_document, error: null };
          }
        }
        break;
      } else if (runStatus.status === 'error') {
        console.error('Extraction run failed:', runStatus.error);
        return { data: null, error: 'Document extraction failed' };
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }
    console.warn('[extractDocumentData] Extraction timed out');

    return { data: null, error: 'Extraction timed out' };
  } catch (error) {
    console.error('Error calling LangGraph:', error);
    return { data: null, error: error instanceof Error ? error.message : 'Unknown error' };
  }
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

        // Validate file type
        if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
          return json({ error: 'Only PDF and image files are allowed' }, { status: 400 });
        }

        // Validate file size (10MB max)
        if (file.size > 10 * 1024 * 1024) {
          return json({ error: 'File size exceeds 10MB limit' }, { status: 400 });
        }

        // Upload to Supabase Storage
        const supabase = getSupabaseClient();
        const timestamp = Date.now();
        const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filePath = `uploads/${timestamp}-${sanitizedName}`;

        // Convert File to ArrayBuffer for upload
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('invoices')
          .upload(filePath, uint8Array, {
            contentType: file.type,
            upsert: false,
          });

        if (uploadError) {
          console.error('Upload error:', uploadError);
          return json({ error: uploadError.message }, { status: 500 });
        }

        // Create invoice record with initial extraction status
        const { invoice, error: createError } = await createInvoice({
          file_name: file.name,
          file_path: uploadData.path,
          file_size: file.size,
          mime_type: file.type,
          status: 'pending',
        });

        if (createError) {
          // Try to delete uploaded file if record creation fails
          await supabase.storage.from('invoices').remove([uploadData.path]);
          return json({ error: createError }, { status: 500 });
        }

        // Convert file to base64 for LangGraph extraction
        const base64Content = Buffer.from(uint8Array).toString('base64');

        // Call LangGraph for document extraction (async, don't block response)
        // We'll update the invoice record with extracted data when complete
        extractDocumentData(base64Content, file.type, file.name)
          .then(async ({ data: extractedData, error: extractionError }) => {
            if (extractedData && invoice) {
              // Update invoice with extracted data
              const updatePayload: Record<string, unknown> = {
                extraction_status: 'completed',
                extraction_confidence: extractedData.confidence_score,
                document_category: extractedData.document_category,
              };

              // Only update fields if extracted successfully
              if (extractedData.vendor_name) {
                updatePayload.vendor_name = extractedData.vendor_name;
              }
              if (extractedData.invoice_number) {
                updatePayload.invoice_number = extractedData.invoice_number;
              }
              if (extractedData.invoice_date) {
                updatePayload.invoice_date = extractedData.invoice_date;
              }
              if (extractedData.due_date) {
                updatePayload.due_date = extractedData.due_date;
              }
              if (extractedData.total_amount !== null) {
                updatePayload.amount = extractedData.total_amount;
              }
              if (extractedData.currency) {
                updatePayload.currency = extractedData.currency;
              }
              if (extractedData.subtotal !== null) {
                updatePayload.subtotal = extractedData.subtotal;
              }
              if (extractedData.tax_amount !== null) {
                updatePayload.tax_amount = extractedData.tax_amount;
              }
              if (extractedData.line_items && extractedData.line_items.length > 0) {
                updatePayload.line_items = extractedData.line_items;
              }

              await updateInvoice(invoice.id, updatePayload);
              console.log(`Invoice ${invoice.id} updated with extracted data`);
            } else if (extractionError) {
              // Mark extraction as failed
              if (invoice) {
                await updateInvoice(invoice.id, {
                  extraction_status: 'failed',
                });
              }
              console.error(`Extraction failed for invoice ${invoice?.id}:`, extractionError);
            }
          })
          .catch(err => {
            console.error('Extraction background task error:', err);
            if (invoice) {
              updateInvoice(invoice.id, { extraction_status: 'failed' }).catch(() => {});
            }
          });

        // Update initial status to processing
        if (invoice) {
          await updateInvoice(invoice.id, { extraction_status: 'processing' });
        }

        // Get signed URL for embedding
        const supabaseForUrl = getSupabaseClient();
        const { data: signedUrlData } = await supabaseForUrl.storage
          .from('invoices')
          .createSignedUrl(uploadData.path, 3600);

        // Embed the file asynchronously (don't block the response)
        let embeddingStatus: 'pending' | 'success' | 'failed' = 'pending';
        if (signedUrlData?.signedUrl) {
          embedInvoiceFile(signedUrlData.signedUrl, file.type)
            .then(result => {
              if (result.success) {
                console.log(`Embedding succeeded for invoice ${invoice?.id}`);
              } else {
                console.error(`Embedding failed for invoice ${invoice?.id}:`, result.error);
              }
            })
            .catch(err => {
              console.error('Embedding background task error:', err);
            });
          embeddingStatus = 'pending';
        } else {
          console.warn('Could not get signed URL for embedding');
          embeddingStatus = 'failed';
        }

        return json({
          success: true,
          invoice: { ...invoice, extraction_status: 'processing' },
          embeddingStatus,
        });
      }

      case 'getStatus': {
        // Poll for invoice processing status - used to check if extraction/embedding is complete
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const { invoice, error } = await getInvoice(invoiceId);

        if (error || !invoice) {
          return json({ error: error || 'Invoice not found' }, { status: 404 });
        }

        return json({
          success: true,
          invoice,
          isProcessing:
            invoice.extraction_status === 'processing' || invoice.extraction_status === 'pending',
        });
      }

      case 'update': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const updateData: Record<string, string | number | undefined> = {};

        const vendor_name = formData.get('vendor_name');
        if (vendor_name) updateData.vendor_name = vendor_name as string;

        const invoice_number = formData.get('invoice_number');
        if (invoice_number) updateData.invoice_number = invoice_number as string;

        const amount = formData.get('amount');
        if (amount) updateData.amount = parseFloat(amount as string);

        const status = formData.get('status');
        if (status) updateData.status = status as string;

        const invoice_date = formData.get('invoice_date');
        if (invoice_date) updateData.invoice_date = invoice_date as string;

        const due_date = formData.get('due_date');
        if (due_date) updateData.due_date = due_date as string;

        const notes = formData.get('notes');
        if (notes) updateData.notes = notes as string;

        const { invoice, error } = await updateInvoice(invoiceId, updateData);

        if (error) {
          return json({ error }, { status: 500 });
        }

        return json({ success: true, invoice });
      }

      case 'delete': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const { success, error } = await deleteInvoice(invoiceId);

        if (error) {
          return json({ error }, { status: 500 });
        }

        return json({ success: true });
      }

      case 'getUrl': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        // Get invoice to get file path
        const { invoices } = await listInvoices();
        const invoice = invoices.find(i => i.id === invoiceId);

        if (!invoice) {
          return json({ error: 'Invoice not found' }, { status: 404 });
        }

        const signedUrl = await getInvoiceUrl(invoice.file_path);

        if (!signedUrl) {
          return json({ error: 'Failed to generate URL' }, { status: 500 });
        }

        return json({ success: true, signedUrl });
      }

      case 'download': {
        const invoiceId = formData.get('invoiceId') as string;
        if (!invoiceId) {
          return json({ error: 'Invoice ID required' }, { status: 400 });
        }

        const { invoices } = await listInvoices();
        const invoice = invoices.find(i => i.id === invoiceId);

        if (!invoice) {
          return json({ error: 'Invoice not found' }, { status: 404 });
        }

        const signedUrl = await getInvoiceUrl(invoice.file_path, 60);

        if (!signedUrl) {
          return json({ error: 'Failed to generate download URL' }, { status: 500 });
        }

        // Redirect to signed URL for download
        return redirect(signedUrl);
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

// Loader for fetching invoices
export async function loader() {
  const [{ invoices }, stats] = await Promise.all([listInvoices(), getInvoiceStats()]);

  return json({ invoices, stats });
}
