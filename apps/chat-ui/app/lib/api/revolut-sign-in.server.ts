/**
 * Revolut sign-in, the app's side: the cookie that ties Revolut's callback to the browser that
 * started the sign-in, and the redirect back to the Integrations page.
 *
 * The agent signs the `state` (business, integration, client ID; 10 minutes). The connect route
 * keeps a copy in this cookie and the callback refuses a state that does not match it, so a
 * sign-in started elsewhere cannot be finished in this browser (login CSRF). HttpOnly (scripts
 * cannot read it), SameSite=Lax (sent on Revolut's top-level redirect back, not on cross-site
 * requests), scoped to the Revolut routes, Secure outside local development.
 */

import { createCookie, redirect } from 'react-router';

export const revolutStateCookie = createCookie('tw_revolut_sign_in', {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/api/integrations/revolut',
  maxAge: 600,
});

/** Back to the Integrations page with `?revolut=<result>`, clearing the sign-in cookie. */
export async function backToIntegrations(result: string, reason?: string): Promise<Response> {
  const params = new URLSearchParams({ revolut: result });
  if (reason) params.set('reason', reason);
  return redirect(`/integrations?${params}`, {
    headers: { 'Set-Cookie': await revolutStateCookie.serialize('', { maxAge: 0 }) },
  });
}

/** The short reason code from an agent error body ({ detail: { reason } }), if it has one. */
export async function agentReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { detail?: { reason?: unknown } };
    const reason = body?.detail?.reason;
    return typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}
