/** Landing header: the wordmark, the sections, and the two ways in. */

import { Link } from 'react-router';
import { ThemeToggle } from '~/components/ui/theme-toggle';

/** A stitch: the thread in ThreadWise, drawn as a running stitch with a loop. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 24" fill="none" aria-hidden className={className}>
      <path
        d="M2 18 H10 M14 18 H22 M26 18 H34"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M6 18 C6 6, 18 4, 20 10 C22 16, 30 14, 34 4"
        stroke="var(--ramp-1)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <Mark className="h-6 w-10 text-foreground" />
      <span className="font-serif text-[24px] font-normal tracking-[-0.03em]">ThreadWise</span>
    </span>
  );
}

const NAV = [
  ['#sale', 'How it works'],
  ['#plan', 'Plan a drop'],
  ['#tax', 'Tax'],
  ['#honest', 'Straight talk'],
  ['#faq', 'Questions'],
] as const;

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-16">
        <Link
          to="/"
          aria-label="ThreadWise, home"
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Wordmark />
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-7 lg:flex">
          {NAV.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="rounded-sm text-[15px] text-text-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5 sm:gap-3">
          <ThemeToggle compact className="hidden sm:inline-flex" />
          <Link
            to="/login"
            className="whitespace-nowrap rounded-sm px-1 text-[15px] text-text-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            className="inline-flex h-10 items-center whitespace-nowrap rounded-full border border-foreground/20 px-4 text-[15px] sm:px-5 font-medium transition-colors hover:border-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
