/**
 * Home Route (Landing Page)
 *
 * Public-facing home page for ThreadWise.
 * The books, shown working: a sale you can follow, and the planner and tax maths to try.
 */

import type { MetaFunction } from 'react-router';
import { LandingPage } from '~/components/landing';

export const meta: MetaFunction = () => {
  return [
    { title: 'ThreadWise - Know what you made. See how we know.' },
    {
      name: 'description',
      content:
        'Double-entry books for people who make things. Connect Shopify, PayPal and your bank, and open any figure down to the orders and bank lines behind it.',
    },
  ];
};

export default function Index() {
  return <LandingPage />;
}
