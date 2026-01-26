/**
 * Invoices Route (Protected)
 *
 * Invoice management page with upload and list functionality.
 */

import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useRevalidator } from 'react-router';
import { InvoicesSection } from '~/components/invoices';
import { listInvoices, getInvoiceStats } from '~/lib/api/invoices.server';
import type { Invoice, InvoiceStats } from '~/types/invoice';

export const meta: MetaFunction = () => {
  return [
    { title: 'Invoices - ThreadWise' },
    { name: 'description', content: 'Manage your invoices' },
  ];
};

export async function loader({ request }: LoaderFunctionArgs): Promise<{
  invoices: Invoice[];
  stats: InvoiceStats;
}> {
  const [invoicesResult, stats] = await Promise.all([listInvoices(), getInvoiceStats()]);

  return {
    invoices: invoicesResult.invoices,
    stats,
  };
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
