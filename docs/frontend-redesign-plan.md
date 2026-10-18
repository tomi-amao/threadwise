# Frontend redesign plan

Status: decisions made, ready for Phase 0 · Branch: `feat/frontend-redesign` · Oct 13, 2026

## Progress

| Phase         | State                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 Foundations | Done (Oct 17)                     | Tokens, self-hosted fonts, cookie theme, component kit, themed Nivo wrappers, re-themed shell, Playwright (width x theme) with contrast, axe and overflow gates. Gallery at `/ui-kit` (dev only).                                                                                                                                                                                                                                                                                                                        |
| 1 Dashboard   | Done, layout revised after review | Full-width command-centre layout: compact header, six KPI tiles (two with sparklines), then a 12-column panel grid so the headline numbers, revenue trend and order breakdown share the first screen. Parity with the old page; tests in both themes. Cookie-based auth shipped with it, so loaders can identify the user. Typecheck baseline went from 30 to 6 errors (`module: ESNext` plus Vite client types). Shared `Panel`, `KpiTile`, `Sparkline` and dense `DataTable` are the pattern for the other tool pages. |
| 2 Table pages | Done                              | All six pages done: Transactions, Inventory, Invoices, Orders, Customers, Products. Next: Phase 3.                                                                                                                                                                                                                                                                                                                                                                                                                       |

Follow-ups from the security pass (before Phase 3):

- **Done:** migrations `20261017000000_row_level_security` and `20261017000001_lock_down_functions`
  (apply with `supabase db push`; they are idempotent to re-read but not to re-run). Dashboard,
  Inventory, Invoices, Orders, Customers, Products, Reports, Tax and Journals now read as the
  signed-in user. The old Reclassification page read one hard-coded business's books whoever was
  signed in (it has since been retired, see Phase 3). `e2e/rls.spec.ts` tests the boundary from
  outside.
- **Found and fixed on the way:** the public `anon` key had ALL privileges on every table and view
  (and 14 tables had RLS off); views returned every business's rows; and every database function,
  including the SECURITY DEFINER ones that read and replace stored API keys and post journals, was
  callable with the public key.
- **Done in Phase 4:** Collections and its print pack now read and write as the signed-in user
  (their tables already had owner policies for every operation). The old page also summed every
  business's order lines into each collection's revenue; the sales rollup is now a database
  function that runs as the caller (`20261018000000_collection_sales`).
- **Not done:** the FastAPI agent trusts the `entity_id` the browser sends it (Transactions calls
  it straight from the browser). Fixing that means the agent verifying the user's Supabase JWT.
- **Not done:** the app's own writes through the service key (a manual journal, the reports
  exclusion, tax adjustments and period status, the invoice payment match) are gated on a
  user-session read of the same row, but the right end state is the agent doing them behind an
  authenticated call.

Follow-ups from Phase 2 (Orders, Customers, Products):

- **Silent truncation, gone.** The old Orders page showed the first 100 of 1,200 orders; Customers
  computed lifetime value from a read capped at 1,000 rows; Products read line items the same
  way. All three now read everything. Products also lists products that have never sold, which the
  old page hid (it only listed what appeared on an order).
- **Shared list pattern:** `Pager`, `useListUrlState` (search, page, param changes), `JumpTo`,
  `DataTable surface="page"` and `getUserEntity` are used by Inventory, Invoices, Orders,
  Customers and Products. A new list page is a model file, a page, a drawer and a loader.
- **Product revenue is before refunds** (refunds sit on the order, not the line) and excludes
  cancelled orders. The customer and order pages take refunds off.
- **Reads are now RLS** (see the security pass above); the entity filters stay as a second layer.
- **The AI insights on a product** call the LangGraph server from the browser, as before. They are
  tested against a stand-in for its two endpoints.

Follow-ups from Phase 2 (Invoices):

- **Reimagined, not restyled.** The page is organised by the invoice's life (To review, Open,
  Paid) rather than Sale/Purchase tabs: tiles say where the money stands (owed to you, you owe,
  overdue, to review), Jump to goes to what is late or waiting, and one drawer replaces three
  modals (review lines and accounts, decide stock, finalise, mark paid, void, delete). Overdue is
  derived from the due date: the database only has OVERDUE if a person sets it.
- **Backend refactor (ai_agent).** The lifecycle is now enforced (`services/invoice_rules.py`,
  60 tests): an open invoice can no longer return to DRAFT with its journal posted, VOID and
  CANCELLED reverse the journals they posted, PAID to OPEN voids the payment journal, only a
  clean draft/void/cancelled invoice can be deleted, line edits are scoped to the invoice (any
  line id could be re-coded before), and editing GL accounts no longer posts a journal for a
  draft. Three stock endpoints became one (`POST /invoices/{id}/stock`). The upload default is
  `create_journal=False`.
- **Security.** The old `/api/invoices` loader returned every business's invoices to anyone, and
  `delete` removed any invoice by id. Every read and write now starts from the invoice as the
  signed-in user (RLS) and takes the entity from that row.
- **Amounts only add invoices in the business's own currency.** The agent does not convert
  foreign invoices when it journals, so a converted headline would disagree with the ledger.
  Foreign-currency invoices are listed and counted but flagged as not included.
- **Not done:** "mark paid" still keys on `metadata.invoice_id` to find the bank payment, so
  invoices paid by Revolut (no invoice number in metadata) need the "mark paid anyway" path.
  A picker that lets the user choose the matching transaction is the real fix.

Follow-ups from Phase 2 (Inventory):

- **Numbers changed, on purpose.** The old page read products, items, movements, stock and order
  lines through a plain `select()`, so past 1,000 rows it silently dropped data; all are now paged
  (`fetchAllRows`). Two definitions were also corrected: sales synthesised from order lines are
  only added for items with no recorded SALE movements (they were double-counted), and valuation
  counts purchases only. Movements are dated by `movement_date`, not the row's `created_at`.
  Expect "Invested" and the movements list to differ from the old page.
- **Not done:** the inline gift/write-off fast path in the table. Disposals are recorded from the
  item drawer only. Add it if the drawer proves too slow for bulk entry.
- **Inventory has no stand-in-free path to the real agent in tests.** Recording a disposal calls the
  FastAPI agent server-side; the e2e suite runs `e2e/stand-in-agent.ts`, which writes only the
  movement (no journal). The journal side is covered by the agent's own tests, not here.
- Tests that change data live in `e2e/*-edit.spec.ts`, run in the `mutations` project after every
  read-only test, and restore what they touched.

Follow-ups from Phase 1:

- **Fixed:** reads silently capped at the API's 1,000 rows (`.limit(10000)` cannot raise `max_rows`).
  `fetchAllRows` now pages the dashboard, revenue-metrics (also used by Reports) and bank-balance
  reads, with tests against a seed of 1,200 orders and 1,100 transactions. Other loaders that
  `select()` whole tables should adopt it as their pages convert.
- **Done in the working tree, not yet committed:** the old localStorage browser client and
  `getAuthenticatedServerClient` are removed from `lib/supabase.ts` (nothing called them). That file
  also has separate key-name edits that are not part of this work, so it is left for them to commit.
- Only the dashboard's entity lookup is user-scoped. Its other queries (and most other loaders) use
  the service-role key, which bypasses row-level security. Fine for one business per database,
  wrong for more.
- `app.invoices.tsx` has a stale comment saying auth lives in localStorage.

## Goal

Move the whole chat-ui application onto the design language in
[design-language.md](design-language.md): a white page, cream surfaces, plum ink,
one amber accent, Fraunces for headlines, Geist for UI, Geist Mono for evidence.
Frontend only. No backend, loader or API contract changes.

The five preview pages (`/dashboard-v2`, `/transactions-v2`, `/inventory-v2`,
`/reports-v2`, `/collections-v2`) have been built, opened in Chrome and measured.
This plan turns what they taught us into a rollout.

## Decisions (resolved Oct 13)

| #   | Question       | Decision                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sidebar        | Follows the theme. **Light by default.**                                                                                                                                                                                                                                                                                                                    |
| 2   | Header density | **Compact header** on dense pages (Transactions, Inventory, Orders, Customers, Products, Invoices, Journals). **Hero only where strictly necessary:** Reports, Collections index, Landing. (The Dashboard began with a hero and was reworked: it is a tool you glance at, so it uses a compact header and a dense full-width panel grid.) |
| 3   | Charts         | **Keep Nivo, theme it, and improve it** (shared wrappers, tokens, real tooltips, keyboard and text alternatives). No custom-SVG rewrite.                                                                                                                                                                                                                    |
| 4   | Testing        | **Add Playwright** in Phase 0 and **write tests as each page changes**.                                                                                                                                                                                                                                                                                     |
| 5   | Legacy pages   | **Delete each old page as its replacement ships and is verified**, not in a final sweep.                                                                                                                                                                                                                                                                    |
| 6   | Card cream     | **`#FCF8F4`** on a **`#FFFFFF`** page. Alt band `#F8F1EA`. A step lighter than the preview's `#FBF6F1`: still 1.06:1 against white, every text pair still passes 4.5:1 (muted text 5.0:1), and warmer than `#FDFAF7`, which is nearly white and leaves cards relying on their border alone.                                                                 |
| 7   | Dark mode      | **Full parity, light default** (see below).                                                                                                                                                                                                                                                                                                                 |

**What "full parity" means for dark mode.** Dark is not a lesser, best-effort skin. Every
page, drawer, dialog, chart and empty state ships in both themes, from the same tokens, with
the same layouts. In practice that is three rules: no hard-coded colours (only tokens, so a
theme can never be missed); the contrast gate runs for both themes; and every Playwright
page test runs in both themes. It does _not_ mean separate dark designs or a "System"
setting. There is one Light/Dark toggle, light is the default, and the choice is stored in
a cookie.

## What the previews proved

**Keep**

- One page shape works everywhere: eyebrow, serif headline as a sentence, one
  four-number stat strip, then tabs or a single list. It fixed the clutter on
  Collections, which was the original complaint.
- Drawers beat permanent side forms. Add/edit flows move out of the page into
  slide-overs, and the page keeps one amber action.
- Hairline borders and almost no shadow hold up in both themes.
- A compact header is needed on dense pages; the hero is for pages where one number or
  one sentence is the point.
- Statement tables with bracketed deductions suit finance pages.
- Computed headline sentences ("Three products carry 19% of sales") are more useful
  than static page titles.
- White page with cream surfaces (decided Oct 12) reads cleaner than cream on cream.

**Change**

- Muted text from the doc (`#8C7F88`) is 3.5:1 on cream. Use `#756872` light and
  `#8E8E94` dark (both pass 4.5:1).
- Amber carried too many meanings (action, status, money in). Amber is for actions
  and active state only. Money in is plum (`#5F4682` light, `#B9A2D4` dark).
- Loss and problem states need their own colour. Use a muted brick (`#A8432C`
  light, `#E0806A` dark), never amber.
- The large hero costs a lot of height on tool pages. Dense pages need a compact
  header variant (decided: compact on dense pages, hero only where strictly necessary).
- Reports lost its ⓘ definitions in the preview. Accounting pages must keep them.

**Bugs the previews surfaced, to design out**

- A reset rule with higher specificity than component styles made selected pills
  unreadable. Use `:where()` for resets, or Tailwind layers, so components always win.
- Pill rows, a legend and unwrapped tables pushed pages wider than a phone. Every
  grid or flex child needs `min-width: 0`, and tables get a scroll wrapper by default.
- Theme is restored from `localStorage` after hydration, so the page flashes light
  first. Move the preference to a cookie read on the server.

## Principles

1. **Tokens, not per-page CSS.** The previews scope everything under `.cv2-*`. The
   real thing makes the palette the app's theme, so existing components re-theme
   without edits.
2. **Build primitives once.** The previews copy-paste patterns. Promote them to
   shared components before the second real page uses them.
3. **No big-bang.** Each page ships behind its own route swap and can be reverted alone.
4. **Parity before polish.** A redesigned page must do everything the old one did
   (checklist per page below) before the old one is removed.
5. **Both themes, all widths, from day one.** Light, dark, and 390 / 768 / 1280px
   are acceptance criteria, not follow-ups.

## Current state (what we are redesigning)

| Area              | Files                                                                                         | Size               | Notes                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| Shell             | `layout/AppLayout`, `Sidebar`, `SidebarProvider`                                              | ~400 lines         | Dark sidebar, mobile header, forced `dark` class on `<html>`                 |
| Theme             | `globals.css`, `tailwind.config.ts`, `root.tsx`                                               | small              | shadcn-style tokens, Inter font, `className="dark"` hard-coded               |
| UI kit            | `components/ui/*`                                                                             | 11 files           | button, input, dialog, select, searchable-select, date-range-picker, tooltip |
| Dashboard         | `routes/app.dashboard` + `components/dashboard/*`                                             | 35 + ~800          | 9 separate cards; preview done                                               |
| Transactions      | `components/transactions/*`                                                                   | ~1,300             | Client-side fetch + pagination; preview done                                 |
| Inventory         | `routes/app.inventory`                                                                        | 1,643              | Four tabs, inline editing; preview done                                      |
| Reports           | `routes/app.reports`                                                                          | 2,544              | Nivo charts, drilldown drawers; preview done                                 |
| Collections       | `routes/app.collections` + `components/collections`                                           | 2,881 + plan panel | Largest and most complex; preview done (partial parity)                      |
| Not yet previewed | orders, products, customers, invoices, journals, tax, reclassification, integrations, account | 250 to 1,700 each  |                                                                              |
| Not yet previewed | chat, auth, landing                                                                           |                    | Chat is the core product; landing is the doc's natural home                  |

## Phases

### Phase 0: Foundations

Exit: every page can opt into the new look by changing nothing but its route module.

1. **Theme tokens.** Define the palette as the app theme in `globals.css`
   (`--background: #fff`, `--card: #fbf6f1`, and so on), mapped through `@theme`.
   Add the extra tokens the previews needed: `--in`, `--neg`, `--accent-tint`,
   the amber ramp, plum tint. Existing `bg-card`, `text-muted-foreground` and
   `border-border` utilities then re-theme automatically.
2. **Fonts.** Replace Inter with Fraunces (light, optical size), Geist and Geist Mono.
   Self-host or preload to avoid layout shift. Set `font-serif`, `font-sans`,
   `font-mono` in Tailwind.
3. **Theme switching.** Light is the default, dark is first-class. Preference lives
   in a cookie, applied on the server render (no flash). Remove the hard-coded
   `className="dark"`. Toast theme follows.
4. **Primitives** in `components/ui/`, built with Tailwind and the tokens:
   `Eyebrow`, `Heading`, `StatStrip`, `Chip`, `Segmented`, `Tabs`, `Meter`,
   `DataTable` (with scroll wrapper), `Statement`, `Drawer`, `EmptyState`, `Field`.
   `Drawer` is built on Radix Dialog (already a dependency) for focus trap, focus
   restore and Escape.
5. **Charts (Nivo, themed).** Keep `@nivo/*`. Build one themed wrapper per chart type
   (bar, line, pie/share) that reads colours from the tokens (amber ramp, plum, brick), so
   they follow the theme with no per-chart colour props. Improve on today's charts: real
   tooltips matching the primitives, keyboard-reachable data points, a text summary for
   screen readers, consistent axes (`£12k` formatting, dashed gridlines, zero line) and
   sensible empty and single-point states.
6. **Shell.** Re-theme `AppLayout`, `Sidebar` and the mobile header so the sidebar follows
   the theme (light by default), which closes the dark-sidebar-beside-white-page seam seen
   in every preview. Add the Light/Dark toggle here, plus a `CompactHeader` and `Hero`
   page-header pair so pages pick one.
7. **Playwright** (see Testing) and the **quality gates** set up before any page is
   converted.

### Phase 1: Prove it on one page: Dashboard

Smallest route (35 lines, nine presentational components) and the one every user
sees first.

- Wire the preview layout to the real `getDashboardData` loader (types already match).
- Keep the onboarding modal, refresh, and the "updated at" stamp.
- Resolve the density question here, since it sets the pattern for dense pages.
- Exit: parity checklist green, light and dark, three widths.

### Phase 2: Table-and-drawer pages

Transactions, Inventory, then the unpreviewed list pages (Orders, Customers,
Products, Invoices) which all follow the same shape.

- **Transactions:** move filtering and paging back to the real API (the preview does
  both client-side). Decide how day-grouping behaves across page boundaries. Keep
  the URL-addressable drawer (`?transactionId=`).
- **Inventory:** keep inline gift/write-off as a fast path as well as in the drawer.
  Keep the item-type, link-to-product and unit-cost actions.
- Exit: one shared list-page pattern, documented, that new pages copy.

### Phase 3: Statement pages (done)

Reports, Tax and Journals were redesigned; Reclassification was retired.

- **Reports:** four tabs (revenue, profit and loss, balance sheet, cash) over one date range;
  every figure drills to the entries behind it. Fixed reads that silently dropped rows past
  PostgREST's 1,000-row cap.
- **Tax:** computation per accounting period with a `Term` definition on each figure, review
  queue, manual adjustments, mark filed / put back, company details, VAT, director's loan and
  provision panels, CT600 working paper. Writes are validated in `lib/api/tax-actions.server.ts`.
- **Journals:** ledger browser (search, status, source, type, date range) with a drawer showing
  each journal's lines, a Needs review tab for drafts (choose the account, or ask the agent to
  suggest one, then post), reversing a journal (the agent enforces period locks), and a manual
  journal builder that cannot post until it balances. The old manual-only page and its
  service-key `api/journals` route are gone.
- **Reclassification retired.** It was a "temporary page" for two one-off clean-ups: setting unit
  costs on products with sales but no costed stock (the Inventory page does this now) and linking
  supplier bank payments to invoices. The second is now a general "Match a payment" section in the
  Invoice drawer. Its route files are in git history if anything is wanted back.
- Restore the ⓘ definitions as a first-class `Term` component, not inline notes (done).

- Restore the ⓘ definitions as a first-class `Term` component, not inline notes.
- Replace the preview's mock derivations with the real `getReportsData` shape;
  re-use the drilldown API routes.
- Keep export packs and the account drilldown.
- Charts move to the shared chart components.

### Phase 4: Collections (done)

Rebuilt from the `/collections-v2` preview on the shared kit (so it sits in the app shell, follows
the theme switch and is centred like every other page), with every feature of the old page.

- **Index** (`/collections`): hero, four portfolio numbers, search, status filter and sort in the
  URL, one row per collection with revenue, costs, trend and margin.
- **Collection** (`/collections/:id`): Overview (profit, weekly revenue, budget, where the money
  went, best sellers, plan against actual), Plan, Products, Costs. Edits happen in drawers.
- **Plan** keeps all the old behaviour: five collaboration types and their terms, custom terms,
  partner currency with a live rate, supplier cost in another currency converted once at entry,
  gifted units, estimated and to-be-determined costs, who-gets-paid, partner payment due, upfront
  outlay, Conservative/Base/Optimistic scenarios, and the printable pack. New: lines and costs can
  be edited (they could only be deleted and re-added), and a collection's details can be edited.
- **Backend:** reads in `lib/api/collections.server.ts`, writes in `collections-actions.server.ts`
  (validated, and every child row is looked up under the collection in the URL). Sales come from
  `collection_sales_rollup` instead of downloading every order line. Cost-linking searches
  transactions on demand (with the category inferred from the journal) instead of loading them
  all. The old page's debug panel and its "what this collection answers" filler are gone.
- **Fixed on the way:** `planned` was offered as a status but the database refused it
  (`20261018000001_collection_status_planned`); cancelled and refunded orders no longer count as
  sales.
- The `/collections-v2` preview and its mock data are deleted.

### Phase 5: Product surfaces outside the data pages (done, except chat)

- **Chat:** not touched. It is being reimagined separately.
- **Landing:** rebuilt around one idea, "the books, shown working". Ruled-paper layout with an
  amber margin line and a double rule under every total (the accounting convention for a grand
  total). A sale you can follow from the order to the profit figure; a profit and loss you can
  open; and three instruments built on the real engine, so visitors can test the claims by hand:
  the collection planner (`computePlanProjections`), UK corporation tax with marginal relief, and
  the VAT threshold. Copy is plain and states limits ("what it does not do"); the sample
  figures are labelled, and there are no logos, testimonials or invented statistics.
- **Sign in, sign up, onboarding:** on the shared kit, with a show/hide password field. Two bugs
  fixed: new accounts never saw onboarding (the business row did not exist when the sign-in
  event fired, and nothing reloaded it), and the onboarding's country step had no field, so it
  could not be finished.
- **Account:** profile, business, appearance and password, each saving on its own. Change
  password is new.
- **Integrations:** each source is a card with its state and, when a person is needed, a callout
  with the action beside it. Connecting a source is a drawer; removing asks first in a dialog
  (it was `window.confirm`). The sync and load-data menus are one accessible component. The four
  progress toasts and modals keep their behaviour and moved onto the theme tokens. It still
  talks to the agent from the browser (see the open item on the agent trusting the browser).

### Phase 6: Cleanup

Pages are deleted as they ship (see Migration mechanics), so this phase only removes what
is left: the `-v2` preview routes and folders, orphaned components and unused tokens.
Update `CLAUDE.md` and `design-language.md` with the decisions made here (contrast, amber,
plum, white page and `#FCF8F4` cards, compact vs hero headers).

## Migration mechanics

- Build the new page against the **existing loader data**; do not change loaders.
- Each page lands as: new components, then a one-line change in `routes.ts` to point
  the path at the new route module. Once the page passes its parity checklist, its
  Playwright tests and the quality gates, **the old route module and any components only it
  used are deleted in the same PR** (or the next, if you want a verification window).
  Nothing legacy is kept around for a release.
- Preview routes stay reachable during the work so the new and old can be compared
  side by side.
- Mock data modules (`*-v2/data.ts`) are throwaway. Real adapters read loader
  data; keep the derivation helpers that are genuinely UI logic (grouping,
  bracketed deductions).

## Quality gates (each page)

| Gate                   | How                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Parity                 | Per-page checklist of old behaviours, ticked in the PR                                                   |
| Contrast               | Script that computes WCAG ratios for every text/background token pair, in both themes; fails under 4.5:1 |
| No horizontal overflow | The iframe-at-390px overflow script used on the previews, run for every route and tab                    |
| Responsive             | Check at 390, 768, 1280px                                                                                |
| Themes                 | Light and dark, including every drawer and dialog                                                        |
| Accessibility          | Drawers trap and restore focus; rows are reachable by keyboard; charts have text alternatives            |
| Types / lint / build   | `pnpm typecheck` (do not add errors to the existing ~8), ESLint on touched files, `pnpm build`           |

## Testing (Playwright)

There is no frontend test runner today. Playwright is added in Phase 0 and each page's
tests ship in the same PR as the page. Per page:

- **Smoke:** loads with no console errors; key sections and the page's one amber action
  are present.
- **Flows:** the behaviours in that page's parity checklist (open and close each drawer,
  apply a filter, switch tabs, submit an edit).
- **Themes:** every test runs in light and dark.
- **Widths:** assert no horizontal overflow at 390, 768 and 1280px.
- **Accessibility:** `@axe-core/playwright` scan per route and per open drawer; drawers
  restore focus on close.
- **Visual:** a screenshot per route and theme, kept as the baseline for later changes.

**Test data: resolved (Oct 16).** The app sits behind Supabase login and loaders run on the
server, so browser tests cannot stub their data. The suite therefore runs against a throwaway
**local Supabase stack** with a seeded test user:

- `supabase/migrations/20261014000000_baseline.sql` rebuilds the schema from scratch (the
  repo previously held only additive migrations). The older migrations are in
  `supabase/archive/`.
- `pnpm db:start`, `pnpm e2e:env`, `pnpm e2e:seed`, `pnpm e2e` (or `pnpm db:fresh` to reset
  and re-seed). Setup and layout are documented in `apps/chat-ui/e2e/README.md`.
- Safety: every entry point refuses to run unless `SUPABASE_URL` is local, the test web
  server never reuses an existing one, and a fixture fails any test whose browser contacts a
  hosted Supabase project.
- CI: `.github/workflows/e2e.yml` starts the same local stack (not yet exercised on a PR).
- Seed data grows with each phase: Dashboard data exists now; Inventory, Reports and
  Collections add their own rows when those pages are converted.

First finding from the suite: the Dashboard header shows "Your Business" because loaders
cannot see the browser's `localStorage` session. Recorded as a `test.fixme`; the redesign
should move to cookie-based auth for loaders.

## Risks

- **Scale of Collections and Reports.** Over 5,000 lines between them. Mitigated by
  doing them after the pattern is proven and splitting into small PRs.
- **Token remap side effects.** Changing the app-wide tokens re-themes every page at
  once, including ones not yet redesigned. Mitigate by landing tokens behind the
  theme switch first and checking unconverted pages for regressions.
- **Deleting as we go.** Removing a legacy page on ship means no easy fallback. The
  parity checklist and Playwright flows are the safety net; revert the PR if one is missed.
- **Dropped functionality.** The previews intentionally simplified. The parity
  checklist is the control.
- **Lint and typecheck backlog.** Pre-existing failures (see `CLAUDE.md`) mean the
  Husky hook may block commits; keep new code clean and do not widen the backlog.
- **Fonts.** Three families increase first-load weight. Self-host, subset, and preload.

## Suggested order of work

1. Settle the Playwright test-data approach (above).
2. Phase 0 (tokens, fonts, theme switch, primitives, themed charts, shell, Playwright, gates).
3. Phase 1 Dashboard (with its tests), review, adjust the primitives.
4. Phases 2 to 4 in order; Phase 5 chat design can start in parallel once Phase 0 lands.
5. Phase 6 cleanup.
