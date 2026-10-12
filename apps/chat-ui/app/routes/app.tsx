/**
 * App Layout Route
 *
 * Parent route for authenticated pages.
 * All child routes require authentication and share the sidebar layout.
 */

import { AppLayout } from '~/components/layout';

export default function AppLayoutRoute() {
  return <AppLayout />;
}
