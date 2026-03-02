/**
 * Home Route (Landing Page)
 *
 * Public-facing home page for ThreadWise.
 * Describes the product and provides signup/login CTAs.
 */

import type { MetaFunction } from 'react-router';
import { LandingPage } from '~/components/landing';

export const meta: MetaFunction = () => {
  return [
    { title: 'ThreadWise - AI-Powered Business Intelligence' },
    {
      name: 'description',
      content:
        'Replace complex dashboards with natural conversations. Ask questions about your finances, get instant insights, and make smarter decisions.',
    },
  ];
};

export default function Index() {
  return <LandingPage />;
}
