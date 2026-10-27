/**
 * Reports Route (Protected)
 *
 * Revenue, profit and loss, balance sheet and cash for a date range. Every read runs as the
 * signed-in user (row-level security); the one write, leaving a transaction out of the spend
 * figures (or putting it back), is gated on the same row being readable by the user.
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
  ShouldRevalidateFunctionArgs,
} from 'react-router';
import { useLoaderData } from 'react-router';
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary';
import { ReportsPage } from '~/components/reports/ReportsPage';
import { getReportsData } from '~/lib/api/reports.server';
import { getServerSupabaseClient } from '~/lib/supabase';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export const meta: MetaFunction = () => [
  { title: 'Reports - ThreadWise' },
  { name: 'description', content: 'Revenue, profit and loss, balance sheet and cash' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;

  await requireUser(request);
  // The signed-in user's own session: row-level security limits every read to their business.
  const supabase = getRequestSupabaseClient(request);
  const [data, entityResult] = await Promise.all([
    getReportsData(supabase, from, to),
    supabase.from('entities').select('year_end_day, year_end_month').limit(1).single(),
  ]);

  // Used only to compute the "Financial year" date-range presets. Falls back
  // to a calendar year (31 December) when no accounting reference date is
  // configured, so the presets still make sense for an entity without one.
  // Cast: the generated Supabase types predate these columns (see
  // tax.server.ts's identical cast), so the row is otherwise an error union.
  const entityRow = entityResult.data as unknown as Record<string, unknown> | null;
  const fiscalYearEnd = {
    day: (entityRow?.year_end_day as number | undefined) ?? 31,
    month: (entityRow?.year_end_month as number | undefined) ?? 12,
  };

  return { data, fiscalYearEnd };
}

// The loader reads only `from` and `to`; the tab and the drawers (account, detail, safe) are
// views over data already on the page. Loading it all again costs seconds, so switching between
// them must not. A submission, or a revalidate on an unchanged URL (Refresh, the exclude
// toggle), still reloads.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const range = (url: URL) => [url.searchParams.get('from'), url.searchParams.get('to')];
  const [curFrom, curTo] = range(currentUrl);
  const [nextFrom, nextTo] = range(nextUrl);
  return curFrom !== nextFrom || curTo !== nextTo ? defaultShouldRevalidate : false;
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUser(request);
  // Reads (and so the ownership check) run as the user; the write itself is service-role only,
  // because users have no write policy on transactions. It happens only after the user's own
  // session could read the row.
  const supabase = getRequestSupabaseClient(request);

  let body: Record<string, string>;
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = (await request.json()) as Record<string, string>;
    } else {
      const fd = await request.formData();
      body = Object.fromEntries(fd.entries()) as Record<string, string>;
    }
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { intent } = body;
  if (intent !== 'toggleExpenseExclusion') {
    return json({ error: `Unknown intent: ${String(intent)}` }, { status: 400 });
  }

  const transactionId = (body.transactionId || '').trim();
  if (!transactionId) {
    return json({ error: 'transactionId is required' }, { status: 400 });
  }

  const shouldExclude = String(body.excluded || '').toLowerCase() === 'true';

  const { data: currentTxn, error: fetchError } = await supabase
    .from('financial_transactions')
    .select('status, metadata')
    .eq('id', transactionId)
    .single();

  if (fetchError || !currentTxn) {
    return json({ error: fetchError?.message ?? 'Transaction not found' }, { status: 404 });
  }

  const currentStatus = String(currentTxn.status || '').toLowerCase();
  const currentMetadata =
    currentTxn.metadata && typeof currentTxn.metadata === 'object'
      ? (currentTxn.metadata as Record<string, unknown>)
      : {};

  let updatePayload: {
    status: string;
    excluded_reason: string | null;
    metadata: Record<string, unknown>;
  };

  if (shouldExclude) {
    const previousStatus =
      currentStatus && currentStatus !== 'excluded'
        ? currentStatus
        : typeof currentMetadata.reports_prev_status === 'string'
          ? String(currentMetadata.reports_prev_status).toLowerCase()
          : null;

    updatePayload = {
      status: 'excluded',
      excluded_reason: 'Excluded from reports drawer',
      metadata: {
        ...currentMetadata,
        ...(previousStatus ? { reports_prev_status: previousStatus } : {}),
      },
    };
  } else {
    const storedPreviousStatus =
      typeof currentMetadata.reports_prev_status === 'string'
        ? String(currentMetadata.reports_prev_status).toLowerCase()
        : '';
    const restoredStatus =
      storedPreviousStatus && storedPreviousStatus !== 'excluded'
        ? storedPreviousStatus
        : 'pending';
    const restMetadata = { ...currentMetadata };
    delete restMetadata.reports_prev_status;

    updatePayload = {
      status: restoredStatus,
      excluded_reason: null,
      metadata: restMetadata,
    };
  }

  const { error } = await getServerSupabaseClient()
    .from('financial_transactions')
    .update(updatePayload)
    .eq('id', transactionId);

  if (error) {
    return json({ error: error.message }, { status: 500 });
  }

  return json({ ok: true, transactionId, excluded: shouldExclude });
}

export default function ReportsRoute() {
  const { data, fiscalYearEnd } = useLoaderData<typeof loader>();
  return <ReportsPage data={data} fiscalYearEnd={fiscalYearEnd} />;
}

export function ErrorBoundary() {
  return <RouteErrorBoundary what="reports" />;
}
