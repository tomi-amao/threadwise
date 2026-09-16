/**
 * Transactions Route (Protected)
 *
 * Browse, search, and update financial transactions with journal detail view.
 */

import type { MetaFunction } from 'react-router';
import { TransactionsPage } from '~/components/transactions';

export const meta: MetaFunction = () => {
  return [
    { title: 'Transactions - ThreadWise' },
    { name: 'description', content: 'Browse and manage financial transactions' },
  ];
};

export default function TransactionsRoute() {
  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <TransactionsPage />
    </div>
  );
}
