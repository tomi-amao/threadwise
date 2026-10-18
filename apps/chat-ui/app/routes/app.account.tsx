/**
 * Account Route (Protected)
 *
 * Profile, business details, appearance and password. Everything is read and saved through the
 * signed-in user's own session (row-level security limits it to their business).
 */

import type { MetaFunction } from 'react-router';
import { AccountPage } from '~/components/account/AccountPage';

export const meta: MetaFunction = () => [
  { title: 'Account - ThreadWise' },
  { name: 'description', content: 'Your profile, your business and how you sign in' },
];

export default function AccountRoute() {
  return <AccountPage />;
}
