/**
 * App Layout Route
 *
 * Parent route for authenticated pages. All child routes require authentication and share
 * the sidebar layout and the assistant panel. The loader reads the panel's open state and
 * width from its cookie, so the first render already makes room for an open panel.
 */

import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { AppLayout } from '~/components/layout';
import { assistantEnabled } from '~/lib/assistant-flag';
import { parsePanel } from '~/lib/assistant-panel';
import { shouldRevalidateLayout } from '~/lib/layout-revalidate';

export const shouldRevalidate = shouldRevalidateLayout;

export function loader({ request }: LoaderFunctionArgs) {
  return {
    panel: parsePanel(request.headers.get('cookie')),
    assistant: assistantEnabled(process.env),
  };
}

export default function AppLayoutRoute() {
  const { panel, assistant } = useLoaderData<typeof loader>();
  return <AppLayout initialPanel={panel} assistant={assistant} />;
}
