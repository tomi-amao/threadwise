/**
 * Tax Route (Protected)
 *
 * UK corporation tax per accounting period, and the CT600 working paper. Reads run as the
 * signed-in user (row-level security). The writes (adjustments, marking a period filed, company
 * details) are validated in lib/api/tax-actions.server.ts, and happen only after the user's own
 * session could read the row they change.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary';
import { TaxPage } from '~/components/tax/TaxPage';
import { getUserEntity } from '~/lib/api/entity.server';
import { getTaxData } from '~/lib/api/tax.server';
import {
  addAdjustment,
  deleteAdjustment,
  markFiled,
  reopenPeriod,
  saveCompanyDetails,
  type TaxActionResult,
} from '~/lib/api/tax-actions.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export const meta: MetaFunction = () => [
  { title: 'Tax - ThreadWise' },
  { name: 'description', content: 'UK corporation tax position and CT600 preparation' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const data = await getTaxData(getRequestSupabaseClient(request));
  return { data };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUser(request);
  const supabase = getRequestSupabaseClient(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  let result: TaxActionResult;
  switch (intent) {
    case 'markFiled':
      result = await markFiled(supabase, form);
      break;
    case 'reopen':
      result = await reopenPeriod(supabase, form);
      break;
    case 'addAdjustment':
      result = await addAdjustment(supabase, form);
      break;
    case 'deleteAdjustment':
      result = await deleteAdjustment(supabase, form);
      break;
    case 'saveCompanyDetails': {
      const entity = await getUserEntity(request);
      result = entity
        ? await saveCompanyDetails(supabase, entity.id, form)
        : { ok: false, error: 'No business found for your account' };
      break;
    }
    default:
      result = { ok: false, error: 'Unknown action' };
  }
  return result;
}

export default function TaxRoute() {
  const { data } = useLoaderData<typeof loader>();
  return <TaxPage data={data} />;
}

export function ErrorBoundary() {
  return <RouteErrorBoundary what="tax summary" />;
}
