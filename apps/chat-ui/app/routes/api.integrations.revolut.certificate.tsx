/**
 * Download the public certificate a business uploads in Revolut Business (Settings, APIs,
 * Business API) to set up the Revolut sign-in. It holds only ThreadWise's public key; the
 * private key stays on the agent. Asked of the agent as the signed-in user.
 */

import { data, type LoaderFunctionArgs } from 'react-router';
import { requestAccessToken } from '~/lib/api/agent-auth.server';
import { getApiBaseUrl } from '~/lib/api/base-url';
import { requireUser } from '~/lib/supabase-server';

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const token = await requestAccessToken(request);
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/oauth/revolut/certificate`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw data('The certificate could not be fetched. Try again.', { status: 502 });
  }
  if (!response.ok)
    throw data('Revolut sign-in is not set up on this server.', { status: response.status });
  return new Response(await response.text(), {
    headers: {
      'Content-Type': 'application/x-pem-file',
      'Content-Disposition': 'attachment; filename="threadwise-revolut.cer"',
      'Cache-Control': 'no-store',
    },
  });
}
