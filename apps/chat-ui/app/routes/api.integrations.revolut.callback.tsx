/**
 * Where Revolut sends the browser after the user allows (or refuses) access: the redirect URI
 * saved in Revolut Business beside the certificate.
 *
 * It checks the state against the cookie the connect route set (same browser, started in the
 * last 10 minutes), then asks the agent, as the signed-in user, to exchange the one-time code.
 * The agent checks the state's signature and that its business is this user's, stores only the
 * refresh token (in the Vault) and marks the integration signed in.
 */

import type { LoaderFunctionArgs } from 'react-router';
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
  const query = new URL(request.url).searchParams;
  const expected = (await revolutStateCookie.parse(request.headers.get('Cookie'))) as string | null;

  if (query.get('error')) return backToIntegrations('error', 'access_denied');
  const code = query.get('code');
  if (!code) return backToIntegrations('error', 'missing_code');
  if (!expected) return backToIntegrations('error', 'sign_in_expired');
  const returned = query.get('state');
  if (returned && returned !== expected) return backToIntegrations('error', 'state_mismatch');

  const token = await requestAccessToken(request);
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/oauth/revolut/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state: expected }),
    });
  } catch {
    return backToIntegrations('error', 'agent_unreachable');
  }
  if (!response.ok) return backToIntegrations('error', (await agentReason(response)) ?? 'failed');

  const { upgraded } = (await response.json()) as { upgraded?: boolean };
  return backToIntegrations(upgraded ? 'upgraded' : 'connected');
}
