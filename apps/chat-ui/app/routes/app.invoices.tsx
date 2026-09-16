/**
 * Invoices Route (Protected)
 *
 * Invoice management page with upload and list functionality.
 */

import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useRevalidator } from 'react-router';
import { InvoicesSection } from '~/components/invoices';
import { getInvoiceStats } from '~/lib/api/invoices.server';
import type { Invoice, InvoiceStats } from '~/types/invoice';

export const meta: MetaFunction = () => {
  return [
    { title: 'Invoices - ThreadWise' },
    { name: 'description', content: 'Manage your invoices' },
  ];
};

export async function loader({ request: _request }: LoaderFunctionArgs): Promise<{
  invoices: Invoice[];
  stats: InvoiceStats;
}> {
  // Auth lives in localStorage, not cookies, so the server can't hold a user
  // session. The InvoicesSection component fetches invoices client-side using
  // the authenticated browser Supabase client (which satisfies RLS).
  // We return empty initial data here so the page shell renders immediately.
  const empty: InvoiceStats = {
    total: 0,
    sales: { total: 0, open: 0, paid: 0, overdue: 0, outstanding: 0 },
    purchases: { total: 0, open: 0, paid: 0, overdue: 0, payable: 0 },
  };
  return { invoices: [], stats: empty };
}

export default function InvoicesPage() {
  const { invoices, stats } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const handleRefresh = () => {
    revalidator.revalidate();
  };

  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">Invoices</h1>
        <p className="text-muted-foreground mt-2">
          Upload, manage, and track your invoices with AI-powered extraction.
        </p>
      </div>

      <InvoicesSection invoices={invoices} stats={stats} onRefresh={handleRefresh} />
    </div>
  );
}
