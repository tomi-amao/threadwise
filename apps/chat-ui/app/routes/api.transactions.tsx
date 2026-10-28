/**
 * GET /api/transactions: one page of transactions for the list (filters as query parameters,
 * named as the agent's /accounting/transactions named them), or with ?id=<transaction> that one
 * transaction and its journal, for the drawer. Read with the signed-in user's session, so
 * row-level security applies; edits still go to the agent.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getUserEntity } from '~/lib/api/entity.server';
import { getTransactionDetail, listTransactions } from '~/lib/api/transactions.server';
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
  try {
    const entity = await getUserEntity(request);
    const supabase = getRequestSupabaseClient(request);

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
    return Response.json(
      { error: id ? 'Could not load the transaction' : 'Could not load transactions' },
      { status: 500 }
    );
  }
}
