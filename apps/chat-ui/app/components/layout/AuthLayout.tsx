/**
 * Auth Layout Component
 *
 * Layout for the sign-in and sign-up pages: the form on the page, and beside it a ruled sheet
 * that says what you are signing in to. Redirects to the dashboard when already signed in.
 */

import { Navigate, Outlet, Link } from 'react-router';
import { Wordmark } from '~/components/landing/LandingHeader';
import { ThemeToggle } from '~/components/ui/theme-toggle';
import { useAuth } from '~/providers/AuthProvider';

const STEPS = [
  ['01', 'Connect', 'Shopify, Squarespace, PayPal and Revolut. Nothing to retype.'],
  ['02', 'Check', 'Anything it cannot place waits as a draft until you choose where it goes.'],
  ['03', 'Open any figure', 'Down to the orders, bank lines and journals behind it.'],
];

export function AuthLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background" role="status">
        <p className="eyebrow">Loading…</p>
      </div>
    );
  }

  if (user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1fr_1.05fr]">
      <aside className="ledger-paper hero-glow relative hidden overflow-hidden border-r lg:block">
        <div aria-hidden className="absolute inset-y-0 left-9 w-px bg-ramp-1/45" />
        <div className="relative flex h-full flex-col justify-between px-16 py-12 xl:px-20">
          <Link
            to="/"
            aria-label="ThreadWise, home"
            className="w-fit rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Wordmark />
          </Link>
          <div>
            <div className="eyebrow">Books for people who make things</div>
            <p className="mt-5 max-w-[520px] font-serif text-[clamp(38px,4vw,56px)] font-light leading-[1.02] tracking-[-0.035em]">
              Know what you made. <span className="text-accent-text">See how we know.</span>
            </p>
            <ol className="mt-12 max-w-[440px] space-y-6">
              {STEPS.map(([n, title, body]) => (
                <li key={n} className="border-t border-border-strong pt-4">
                  <span className="font-mono text-[11px] tracking-[0.08em] text-text-2">{n}</span>
                  <div className="mt-1 font-serif text-[22px] leading-tight">{title}</div>
                  <p className="mt-1 text-[15px] text-text-2">{body}</p>
                </li>
              ))}
            </ol>
          </div>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Every table of your data sits behind row-level security.
          </p>
        </div>
      </aside>

      <main className="relative flex flex-col px-5 py-8 sm:px-10">
        <div className="flex items-center justify-between lg:justify-end">
          <Link
            to="/"
            aria-label="ThreadWise, home"
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <Wordmark />
          </Link>
          <ThemeToggle compact />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
