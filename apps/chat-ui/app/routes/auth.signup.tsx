/**
 * Signup Route
 *
 * Registration page for new users.
 */

import type { MetaFunction } from 'react-router';
import { SignupForm } from '~/components/auth';

export const meta: MetaFunction = () => {
  return [
    { title: 'Create Account - ThreadWise' },
    {
      name: 'description',
      content: 'Create your ThreadWise account and start your business intelligence journey',
    },
  ];
};

export default function SignupPage() {
  return <SignupForm />;
}
