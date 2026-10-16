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

| Path            | Purpose                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `env.ts`        | Loads `.env.test`; the local-only safety guard                                        |
| `seed/seed.ts`  | Deterministic seed (random seed fixed; dates are relative to the run)                 |
| `write-env.ts`  | Builds `.env.test` from the running local stack                                       |
| `auth.setup.ts` | Signs in once through the UI and saves the session                                    |
| `fixtures.ts`   | `test` with the no-hosted-traffic guard, `expectNoHorizontalOverflow`, `readManifest` |
| `*.spec.ts`     | Tests, run at desktop (1280), tablet (768) and mobile (390)                           |

## Writing a page's tests

Import `test` and `expect` from `./fixtures`, not `@playwright/test`. Assert on counts and
structure from `readManifest()`, not on dates or exact money (server code uses the real
clock). Theme projects (light and dark) are added with the Phase 0 theme switch.

## Known issues the tests document

`test.fixme` marks real defects found while writing tests. Currently: the dashboard header
shows "Your Business" because loaders can't see the browser's `localStorage` session.
