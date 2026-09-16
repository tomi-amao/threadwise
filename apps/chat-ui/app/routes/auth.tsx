/**
 * Auth Layout Route
 *
 * Parent route for authentication pages (login, signup).
 * Uses pathless layout with 'auth' prefix.
 */

import { AuthLayout } from '~/components/layout';

export default function AuthLayoutRoute() {
  return <AuthLayout />;
}
