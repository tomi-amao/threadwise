/**
 * Login Route
 *
 * Authentication page for existing users.
 */

import type { MetaFunction } from 'react-router';
import { LoginForm } from '~/components/auth';

export const meta: MetaFunction = () => {
  return [
    { title: 'Sign In - ThreadWise' },
    { name: 'description', content: 'Sign in to your ThreadWise account' },
  ];
};

export default function LoginPage() {
  return <LoginForm />;
}
