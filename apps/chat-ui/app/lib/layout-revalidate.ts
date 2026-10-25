/**
 * `shouldRevalidate` for the root and app layouts.
 *
 * Their loaders only read the theme and assistant-panel cookies (and an environment flag), and
 * the client updates its own state when either cookie changes, so a navigation never needs them
 * again. Without this, a change that skips the page's own loader (a tab in the URL) still costs
 * a round trip to the server for these two. A submission or an explicit revalidate (same URL)
 * still reloads them.
 */

import type { ShouldRevalidateFunctionArgs } from 'react-router';

export function shouldRevalidateLayout({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
}
