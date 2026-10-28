/**
 * GET /api/transactions: one page of transactions for the list (filters as query parameters,
 * named as the agent's /accounting/transactions named them); with ?id=<transaction> that one
 * transaction, its journal and its attachments, for the drawer; with ?attachment=<id> a redirect
 * to that attachment's file. Read with the signed-in user's session, so row-level security
 * applies; edits still go to the agent.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getUserEntity } from '~/lib/api/entity.server';
import {
  getAttachmentUrl,
  getTransactionDetail,
  listTransactions,
} from '~/lib/api/transactions.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

const MAX_PAGE_SIZE = 200;

const positiveInt = (value: string | null, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const attachment = params.get('attachment');
  try {
    const entity = await getUserEntity(request);
    const supabase = getRequestSupabaseClient(request);

    if (attachment) {
      const url = entity && (await getAttachmentUrl(supabase, entity.id, attachment));
      if (!url) return Response.json({ error: 'Attachment not found' }, { status: 404 });
      return Response.redirect(url, 302);
    }

    if (id) {
      const detail = entity && (await getTransactionDetail(supabase, entity.id, id));
      if (!detail) return Response.json({ error: 'Transaction not found' }, { status: 404 });
      return Response.json(detail);
    }

    const page = positiveInt(params.get('page'), 1);
    const pageSize = Math.min(positiveInt(params.get('page_size'), 50), MAX_PAGE_SIZE);
    if (!entity) {
      return Response.json({
        entity_id: null,
        transactions: [],
        total_count: 0,
        page,
        page_size: pageSize,
        total_pages: 1,
      });
    }
    return Response.json(
      await listTransactions(supabase, entity.id, {
        search: params.get('search') ?? undefined,
        source: params.get('source') ?? undefined,
        direction: params.get('direction') ?? undefined,
        transactionType: params.get('transaction_type') ?? undefined,
        txnStatus: params.get('txn_status') ?? undefined,
        dateFrom: params.get('date_from') ?? undefined,
        dateTo: params.get('date_to') ?? undefined,
        page,
        pageSize,
      })
    );
  } catch (error) {
    console.error('Transactions loader error:', error);
    const what = attachment ? 'the attachment' : id ? 'the transaction' : 'transactions';
    return Response.json({ error: `Could not load ${what}` }, { status: 500 });
  }
}
