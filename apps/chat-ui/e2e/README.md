# End-to-end tests

Playwright tests that run against a **local** Supabase stack with a seeded test user.
Nothing here can touch the hosted project: every entry point refuses to run unless
`SUPABASE_URL` is `localhost` / `127.0.0.1`, and a fixture fails any test whose browser
contacts `*.supabase.co`.

## One-time setup

```bash
brew install supabase/tap/supabase     # and start Docker Desktop
pnpm install
pnpm --filter threadwise-chat-ui exec playwright install chromium
```

## Every session

```bash
pnpm db:start      # supabase start (applies supabase/migrations)
pnpm e2e:env       # writes apps/chat-ui/.env.test from `supabase status`
pnpm e2e:seed      # test user + one business with orders, payments, banks, transactions
pnpm e2e           # runs the suite (starts its own dev server on :5180)
```

Reset to a clean, freshly seeded database at any time with `pnpm db:fresh`.
The seed refuses to run twice; that is what `db:fresh` is for.

## Layout

| Path                        | Purpose                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.ts`                    | Loads `.env.test`; the local-only safety guard                                                                                                        |
| `seed/seed.ts`, `ledger.ts` | Deterministic seed: a business with orders, payments, bank lines, invoices, a ledger, collections, and a rival business. Writes `.seed-manifest.json` |
| `write-env.ts`              | Builds `.env.test` from the running local stack                                                                                                       |
| `auth.setup.ts`             | Signs in once through the UI and saves the session                                                                                                    |
| `fixtures.ts`               | `test` with the no-hosted-traffic guard, `expectNoHorizontalOverflow`, `readManifest`                                                                 |
| `helpers/db.ts`             | Service-role reads, snapshots and restores for tests that change data                                                                                 |
| `stand-in-agent.ts`         | Answers the server-side calls to the AI agent (invoices, stock, journals)                                                                             |
| `*.spec.ts`                 | Read-only tests, run at desktop (1280), tablet (768) and mobile (390), in light and dark                                                              |
| `*-edit.spec.ts`            | Tests that change data: run last, in the `mutations` project, and restore what they changed                                                           |

## Writing a page's tests

Import `test` and `expect` from `./fixtures`, not `@playwright/test`. Assert on counts and
structure from `readManifest()`, not on dates or exact money (server code uses the real clock).
Every page spec also runs axe and `expectNoHorizontalOverflow`, with each drawer open too.

- Pages that fade content in are checked at rest: `page.emulateMedia({ reducedMotion: 'reduce' })`,
  and for dialogs wait for `document.getAnimations()` to finish, or axe reads blended colours.
- While a drawer is open the page behind it is hidden from assistive technology, so wait for the
  dialog rather than the page heading.
- A mutation test restores what it changed (see `helpers/db.ts`) and must never remove a seeded
  row or change the seeded user's password (that signs every session out; use a throwaway user).
- The browser's own calls to the agent (Integrations) are mocked in the spec with `page.route`,
  limited to the agent's address (the app's own modules also live under `/integrations/`).
- `pnpm db:fresh` after changing the seed; it refuses to run twice otherwise.
