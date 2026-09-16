/**
 * Route Error Boundary
 *
 * Shared full-page error state for routes whose loader fetches one
 * unified block of data with no meaningful partial view to fall back
 * to (dashboard, reports, tax) — showing fabricated empty/zero data
 * here would be actively misleading, so these routes render this
 * instead of the page.
 */

import { isRouteErrorResponse, useRouteError } from 'react-router';
import { WarningCircle, ArrowClockwise } from 'phosphor-react';

interface RouteErrorBoundaryProps {
  /** What failed to load, e.g. "dashboard", "reports", "tax summary". */
  what: string;
}

export function RouteErrorBoundary({ what }: RouteErrorBoundaryProps) {
  const error = useRouteError();

  let message = `Something went wrong loading the ${what}.`;
  if (isRouteErrorResponse(error)) {
    message = error.data?.message || error.statusText || message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 text-center">
        <WarningCircle size={40} weight="fill" className="text-red-400 mx-auto mb-4" />
        <h1 className="text-lg font-semibold text-foreground mb-2">
          Couldn&apos;t load the {what}
        </h1>
        <p className="text-sm text-muted-foreground mb-6">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <ArrowClockwise size={16} />
          Try again
        </button>
      </div>
    </div>
  );
}
