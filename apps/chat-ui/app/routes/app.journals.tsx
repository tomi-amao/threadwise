/**
 * Journals Route (Protected)
 *
 * The double-entry ledger: browse every journal, review the drafts the system could not finish,
 * reverse a mistake, and write a manual journal. Reads run as the signed-in user (row-level
 * security). Reversing and posting a draft go to the agent, which owns the ledger and the period
 * locks; a manual journal is validated here and written in one atomic call.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary';
import { JournalsPage } from '~/components/journals/JournalsPage';
import { getUserEntity } from '~/lib/api/entity.server';
import {
  createManualJournal,
  getJournalDetail,
  getJournalsData,
  postDraft,
  reverseJournal,
  suggestForDrafts,
  type JournalActionResult,
} from '~/lib/api/journals.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export const meta: MetaFunction = () => [
  { title: 'Journals - ThreadWise' },
  { name: 'description', content: 'The double-entry ledger: browse, review and adjust' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const supabase = getRequestSupabaseClient(request);
  const openId = new URL(request.url).searchParams.get('journal');

  const [data, detail, entityResult] = await Promise.all([
    getJournalsData(supabase),
    openId ? getJournalDetail(supabase, openId) : Promise.resolve(null),
    supabase.from('entities').select('year_end_day, year_end_month').limit(1).maybeSingle(),
  ]);

  // Used for the "Financial year" presets of the date picker (calendar year when unset).
  const entityRow = entityResult.data as unknown as Record<string, unknown> | null;
  const fiscalYearEnd = {
    day: (entityRow?.year_end_day as number | undefined) ?? 31,
    month: (entityRow?.year_end_month as number | undefined) ?? 12,
  };
  return { data, detail, fiscalYearEnd };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUser(request);
  const supabase = getRequestSupabaseClient(request);
  const entity = await getUserEntity(request);
  if (!entity) return { ok: false, error: 'No business found for your account' };

  const form = await request.formData();
  const id = String(form.get('journalId') ?? '');
  let result: JournalActionResult;
  switch (String(form.get('intent') ?? '')) {
    case 'create':
      result = await createManualJournal(supabase, entity.id, form);
      break;
    case 'reverse':
      result = await reverseJournal(supabase, entity.id, id);
      break;
    case 'postDraft':
      result = await postDraft(supabase, entity.id, id, String(form.get('accountId') ?? ''));
      break;
    case 'suggest': {
      let ids: string[] = [];
      try {
        ids = (JSON.parse(String(form.get('journalIds') ?? '[]')) as string[]).slice(0, 200);
      } catch {
        /* none */
      }
      result = await suggestForDrafts(entity.id, ids);
      break;
    }
    default:
      result = { ok: false, error: 'Unknown action' };
  }
  return result;
}

export default function JournalsRoute() {
  const { data, detail, fiscalYearEnd } = useLoaderData<typeof loader>();
  return <JournalsPage data={data} detail={detail} fiscalYearEnd={fiscalYearEnd} />;
}

export function ErrorBoundary() {
  return <RouteErrorBoundary what="journals" />;
}
