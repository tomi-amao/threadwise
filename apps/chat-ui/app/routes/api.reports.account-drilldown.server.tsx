import type { LoaderFunctionArgs } from 'react-router';
import { getAccountDrilldown, type ReportStatement } from '~/lib/api/reports.server';

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId');
  const statement = url.searchParams.get('statement');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const requestKey = url.searchParams.get('requestKey') || '';

  if (!accountId) {
    return json({ requestKey, error: 'accountId is required' }, { status: 400 });
  }

  if (statement !== 'pnl' && statement !== 'balance') {
    return json({ requestKey, error: 'statement must be pnl or balance' }, { status: 400 });
  }

  try {
    const drilldown = await getAccountDrilldown({
      accountId,
      statement: statement as ReportStatement,
      from,
      to,
    });

    return json({ requestKey, drilldown });
  } catch (error) {
    return json(
      {
        requestKey,
        error: error instanceof Error ? error.message : 'Failed to load report account drilldown',
      },
      { status: 500 }
    );
  }
}
