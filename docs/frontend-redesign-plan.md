# Frontend redesign plan

Status: proposal · Branch: `feat/frontend-redesign` · Oct 13, 2026

## Goal

Move the whole chat-ui application onto the design language in
[design-language.md](design-language.md): a white page, cream surfaces, plum ink,
one amber accent, Fraunces for headlines, Geist for UI, Geist Mono for evidence.
Frontend only. No backend, loader or API contract changes.

The five preview pages (`/dashboard-v2`, `/transactions-v2`, `/inventory-v2`,
`/reports-v2`, `/collections-v2`) have been built, opened in Chrome and measured.
This plan turns what they taught us into a rollout.

## What the previews proved

**Keep**

- One page shape works everywhere: eyebrow, serif headline as a sentence, one
  four-number stat strip, then tabs or a single list. It fixed the clutter on
  Collections, which was the original complaint.
- Drawers beat permanent side forms. Add/edit flows move out of the page into
  slide-overs, and the page keeps one amber action.
- Hairline borders and almost no shadow hold up in both themes.
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
  header variant (see Open decisions).
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

### Phase 0: Decisions and foundations

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
5. **Charts.** Decide the library question (see Open decisions), then build the
   shared bar, line and stacked-share charts with real tooltips and keyboard focus.
6. **Shell.** Re-theme `AppLayout`, `Sidebar` and the mobile header. This closes
   the dark-sidebar-beside-cream-page seam seen in every preview.
7. **Quality gates** (see below) set up before any page is converted.

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

### Phase 3: Statement pages

Reports, Journals, Tax, Reclassification.

- Restore the ⓘ definitions as a first-class `Term` component, not inline notes.
- Replace the preview's mock derivations with the real `getReportsData` shape;
  re-use the drilldown API routes.
- Keep export packs and the account drilldown.
- Charts move to the shared chart components.

### Phase 4: Collections

Last of the core pages because it is the largest (2,881 lines plus the plan panel)
and the preview is the least complete. Parity gaps to close first:

- Collaboration terms (custom terms, partner payout labels).
- Supplier-currency / live-FX handling on plan lines.
- Scenario presets.
- Export pack.
- The cost-linking flow with inferred expense account.
  Do this one as several small PRs (index, detail overview, products/costs, plan) rather
  than one.

### Phase 5: Product surfaces outside the data pages

- **Chat.** The core of the product and not yet designed. Needs its own short design
  pass: message layout, tool-call rows (the doc's "› calls tool_name" pattern),
  and generative UI (charts and tables pushed mid-stream) using the shared chart and
  table components so chat output matches the pages.
- **Integrations, Account.** Settings-style pages; mostly forms and cards.
- **Auth and onboarding.** Login, signup, onboarding modal.
- **Landing.** The design doc is a marketing-site description, so this is the most
  literal application of it.

### Phase 6: Cleanup

Delete the `-v2` preview routes and `collections-v2`-style folders, the old
components, and unused tokens. Remove legacy route aliases. Update `CLAUDE.md`
and `design-language.md` with the decisions made here (contrast, amber, plum,
white page).

## Migration mechanics

- Build the new page against the **existing loader data**; do not change loaders.
- Each page lands as: new components, then a one-line change in `routes.ts` to point
  the path at the new route module. The old module stays on disk until the page
  is signed off, then is deleted in Phase 6.
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

There is no frontend test runner today. Recommend adding Playwright for smoke and
screenshot checks per route as part of Phase 0, because this redesign touches every
screen and manual checking will not scale. This is the one tooling addition proposed.

## Risks

- **Scale of Collections and Reports.** Over 5,000 lines between them. Mitigated by
  doing them after the pattern is proven and splitting into small PRs.
- **Token remap side effects.** Changing the app-wide tokens re-themes every page at
  once, including ones not yet redesigned. Mitigate by landing tokens behind the
  theme switch first and checking unconverted pages for regressions.
- **Dropped functionality.** The previews intentionally simplified. The parity
  checklist is the control.
- **Lint and typecheck backlog.** Pre-existing failures (see `CLAUDE.md`) mean the
  Husky hook may block commits; keep new code clean and do not widen the backlog.
- **Fonts.** Three families increase first-load weight. Self-host, subset, and preload.

## Open decisions for you

1. **Sidebar:** light, dark, or follows theme? Recommended: follows theme, light by default.
2. **Dark mode:** first-class and at parity (recommended), or secondary?
3. **Header density:** keep the large hero on every page, or use a compact header
   (eyebrow + headline + inline actions) on dense tool pages like Transactions
   and Inventory? Recommended: hero on Dashboard, Reports and Collections index;
   compact elsewhere.
4. **Card cream:** keep `#FBF6F1`, or lighten (about `#FDFAF7`) to keep the page from
   feeling grey-beige on white?
5. **Charts:** keep Nivo and theme it, or standardise on small custom SVG charts
   (lighter, fully on-brand, but we own tooltips and accessibility)?
6. **Legacy routes:** delete old pages as each new one ships (recommended), or keep
   `/x-legacy` for one release?
7. **Copy tone:** the doc asks for specific, honest, number-led copy. Do we rewrite
   page copy as we go, or keep current wording and revisit?
8. **Playwright:** OK to add as a dev dependency in Phase 0?

## Suggested order of work

1. Decide the open items above.
2. Phase 0 (tokens, fonts, theme switch, primitives, shell, gates).
3. Phase 1 Dashboard, review, adjust the primitives.
4. Phases 2 to 4 in order; Phase 5 chat design can start in parallel once Phase 0 lands.
5. Phase 6 cleanup.
