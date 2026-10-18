/**
 * App Layout Route
 *
 * Parent route for authenticated pages. All child routes require authentication and share
 * the sidebar layout and the assistant panel. The loader reads the panel's open state and
 * width from its cookie, so the first render already makes room for an open panel.
 */

import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { AppLayout } from '~/components/layout';
import { parsePanel } from '~/lib/assistant-panel';

export function loader({ request }: LoaderFunctionArgs) {
  return { panel: parsePanel(request.headers.get('cookie')) };
}

export default function AppLayoutRoute() {
  const { panel } = useLoaderData<typeof loader>();
  return <AppLayout initialPanel={panel} />;
}
