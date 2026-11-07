/**
 * "Connect with Revolut": start the Revolut Business sign-in for the signed-in user's business.
 *
 * A form on the Integrations page submits here (GET): `client_id`, and either `source_id` (sign
 * an existing Revolut integration in, keeping its data) or `account` and `name` (a new one). This
 * asks the agent, as the user, for Revolut's consent URL and its signed state, keeps the state in
 * an HttpOnly cookie for the callback to check, and redirects to Revolut. The business comes from
 * the user's token on the agent, never from this URL.
 */

import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requestAccessToken } from '~/lib/api/agent-auth.server';
import { getApiBaseUrl } from '~/lib/api/base-url';
import {
  agentReason,
  backToIntegrations,
  revolutStateCookie,
} from '~/lib/api/revolut-sign-in.server';
import { requireUser } from '~/lib/supabase-server';

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const token = await requestAccessToken(request);
  const query = new URL(request.url).searchParams;
  const text = (name: string) => query.get(name)?.trim() || undefined;

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/oauth/revolut/authorize-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: text('client_id') ?? '',
        source_id: text('source_id'),
        external_account_id: text('account'),
        display_name: text('name'),
      }),
    });
  } catch {
    return backToIntegrations('error', 'agent_unreachable');
  }
  if (!response.ok) return backToIntegrations('error', (await agentReason(response)) ?? 'failed');

  const { url, state } = (await response.json()) as { url?: string; state?: string };
  // Only ever send the browser to Revolut.
  if (!url || !state || !/^https:\/\/([a-z0-9-]+\.)*revolut\.com\//.test(url))
    return backToIntegrations('error', 'failed');
  return redirect(url, { headers: { 'Set-Cookie': await revolutStateCookie.serialize(state) } });
}
