/**
 * Integrations Route (Protected)
 *
 * Connect and sync the sources the books are built from. The page talks to the agent from the
 * browser; see components/integrations/IntegrationsPage.tsx.
 */

import type { MetaFunction } from 'react-router';
import { IntegrationsPage } from '~/components/integrations/IntegrationsPage';

export const meta: MetaFunction = () => [
  { title: 'Integrations - ThreadWise' },
  { name: 'description', content: 'Connect and sync the sources your books are built from' },
];

export default function IntegrationsRoute() {
  return <IntegrationsPage />;
}
