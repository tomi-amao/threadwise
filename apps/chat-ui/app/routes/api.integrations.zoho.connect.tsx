/**
 * "Connect with Zoho": start the Zoho Calendar sign-in for the signed-in user's business.
 *
 * A link or redirect cannot carry an Authorization header, so the page links here (same site,
 * session cookie). This asks the agent, as the user, for the Zoho consent URL and redirects to
 * it. The business comes from the user's token on the agent, never from this URL.
 */

import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requestAccessToken } from '~/lib/api/agent-auth.server';
import { getApiBaseUrl } from '~/lib/api/base-url';
import { requireUser } from '~/lib/supabase-server';

const back = (reason: string) => redirect(`/integrations?zoho_calendar=error&reason=${reason}`);

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const token = await requestAccessToken(request);

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/oauth/zoho_calendar/authorize-url`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return back('agent_unreachable');
  }
  if (!response.ok) return back('not_configured');

  const { url } = (await response.json()) as { url?: string };
  return url ? redirect(url) : back('not_configured');
}
