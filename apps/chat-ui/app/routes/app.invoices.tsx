/**
 * Invoices Route (Protected)
 *
 * The loader reads the signed-in user's invoices (row-level security applies). The page does
 * the rest; changes go through /api/invoices.
 */

import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { InvoicesPage } from '~/components/invoices';
import { getUserEntity, listInvoices } from '~/lib/api/invoices.server';

export const meta: MetaFunction = () => [
  { title: 'Invoices - ThreadWise' },
  { name: 'description', content: 'Upload, review and track what you owe and what you are owed' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const [invoices, entity] = await Promise.all([listInvoices(request), getUserEntity(request)]);
  // "Today" comes from the server so overdue is the same on the server render and in the browser.
  return {
    invoices,
    currency: entity?.currency ?? 'GBP',
    today: new Date().toISOString().slice(0, 10),
  };
}

export default function InvoicesRoute() {
  const { invoices, today, currency } = useLoaderData<typeof loader>();
  return <InvoicesPage invoices={invoices} today={today} currency={currency} />;
}
