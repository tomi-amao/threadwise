/**
 * Dashboard Route (Protected)
 *
 * Main dashboard view with KPIs, charts, and business analytics.
 */

import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';
import { DashboardView } from '~/components/dashboard/DashboardView';
import { getDashboardData } from '~/lib/api/dashboard.server';
import type { DashboardData } from '~/types/dashboard';

export const meta: MetaFunction = () => {
  return [
    { title: 'Dashboard - ThreadWise' },
    { name: 'description', content: 'Your business intelligence dashboard' },
  ];
};

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<{ dashboard: DashboardData }> {
  const dashboard = await getDashboardData(request);
  return { dashboard };
}

export default function DashboardPage() {
  const { dashboard } = useLoaderData<typeof loader>();
  return <DashboardView data={dashboard} />;
}
