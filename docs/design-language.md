# Design Language Guide

Oct 10, 2026 · @Ignorant

## Overview

(.dev) looks like a quiet editorial magazine for developers: warm cream paper, deep plum ink, one amber accent, and a light-weight serif headline set against a clean sans and a monospace for technical labels. Values below were read from the live light theme; a dark theme also exists and is noted in the palette.

The principles that make it feel distinctive:

- **Warm, not stark.** Backgrounds are cream (#FBF6F1) and text is a purple-black (#241B2C), never pure white or black.
- **Serif for emotion, sans for function, mono for evidence.** Headlines are Fraunces Light; UI and body are Geist; eyebrows, numbers and commands are Geist Mono.
- **One accent colour, used sparingly.** Amber highlights a phrase in the headline, the primary button and active borders.
- **Hairline structure.** Cards are separated by 1px plum-tinted borders at low opacity, with almost no shadows.
- **Product shown as UI, not screenshots.** Features are illustrated with small mock panels (agent prompts, PR comments, health scores) built from real components.
- **Specific, honest copy.** Claims carry numbers and sample sizes, such as 31.6% fewer agent tokens and 0.74 bug-prediction AUC.

## Color palette

The palette is cream, plum and amber. Neutrals are tinted purple rather than grey, which is what gives the page its warmth.

| Role                    | Light theme | Dark theme | Used for                                                        |
| ----------------------- | ----------- | ---------- | --------------------------------------------------------------- |
| Page background         | #FFFFFF     | #0E0E0F    | Body and most sections (as built: white, with cream cards)      |
| Secondary background    | #FCF8F4     | #141416    | Cards, panels, sidebar (as built)                               |
| Surface / card          | #FCF8F4     | #191A1C    | Cards, search box, mock panels (as built)                       |
| Text primary            | #241B2C     | #F2F2F3    | Headlines, body, nav active                                     |
| Text secondary          | #5E5360     | #B4B4B9    | Nav links, supporting paragraphs                                |
| Text muted              | #756872     | #8E8E94    | Eyebrows, captions, footnotes (darkened for contrast)           |
| Accent (text)           | #96590F     | #F59520    | Headline highlight, links, active chips (darkened for contrast) |
| Accent fill             | #F59520     | #F59520    | Primary button (hover #F7A94D)                                  |
| Accent tint             | #F595201F   | #F5952029  | Soft badges, highlights                                         |
| Secondary accent (plum) | #A98FC4     | #A98FC4    | Illustrations, decorative shapes                                |
| Border default          | #58436C1F   | #FFFFFF12  | Card and section hairlines                                      |
| Border strong           | #58436C38   | #FFFFFF26  | Hover and emphasis                                              |
| Button outline          | #241B2C26   | n/a        | Secondary pill buttons                                          |

Amber also has a five-step tint ramp for data and charts: #F59520, #F5B465, #F4C690, #F4D3ad, #F4DCC2. The hero has a soft peach radial glow behind the headline and a faint lilac wash at the left edge, which keeps the cream background from feeling flat.

## Typography

Three Google-available families do all the work: **Fraunces** (serif, headlines), **Geist** (sans, body and UI) and **Geist Mono** (labels, numbers, code). Headlines use a light weight (300) with tight negative tracking, which is the single biggest contributor to the editorial feel.

| Style                   | Font       | Size                     | Weight                   | Tracking | Notes                                     |
| ----------------------- | ---------- | ------------------------ | ------------------------ | -------- | ----------------------------------------- |
| H1 (hero)               | Fraunces   | 60.7px, line-height 1.02 | 300                      | -2.1px   | Second half of the line coloured #A16215  |
| H2 (section)            | Fraunces   | 40.5px, line-height 1.08 | 300                      | -1px     | Dark plum #241B2C                         |
| H3 (card/feature)       | Fraunces   | 28px, line-height 1.08   | 300                      | -0.56px  |                                           |
| Body                    | Geist      | 15px, line-height 1.5    | 400                      | normal   | Hero lead paragraph is larger, about 22px |
| Nav and buttons         | Geist      | 15px                     | 500 (buttons), 400 (nav) | normal   | Nav links in #5E5360                      |
| Eyebrow / section label | Geist Mono | 12px, line-height 1.5    | 400                      | +0.96px  | UPPERCASE, #8C7F88                        |
| Step numbers (01, 02)   | Geist Mono | 11px                     | 400                      | +0.88px  | #776A78                                   |
| Version tag, commands   | Geist Mono | 15px                     | 400                      | normal   | Tag in amber #A16215                      |

Pattern to copy: every section opens with an uppercase mono eyebrow (for example WHY AI VELOCITY STALLS), then a light serif H2 written as a full sentence, then one short grey paragraph. Headlines are centred in the hero and left-aligned inside content sections.

## Layout and spacing

The layout is generous and calm: wide containers, big vertical gaps, and a centred single column for the hero.

- **Containers:** content max-width 1280px (64px side padding) for most sections, up to 1536px (32px padding) for wide bands; text blocks are narrower and centred.
- **Section rhythm:** about 112px of vertical padding per section. Backgrounds alternate between cream (#FBF6F1) and white (#FFFFFF) so sections separate without heavy dividers.
- **Top of page:** a thin announcement bar (mono version tag + amber underlined link, dismissible), then a 1px-bordered header, then the hero.
- **Hero:** eyebrow, two-line serif headline, 3-line lead paragraph, a wide white search/input pill with an amber button inside, then small grey helper text. Roughly 800px tall.
- **Grids:** feature areas use 3 columns of cards (about 280px each, 14px radius); stats use a 4-up row; the problem section is 3 numbered columns; audience cards are 2 columns.
- **Corner radii:** large containers 16px, cards 14px, buttons 14px, nav and secondary buttons fully pill-shaped (9999px).
- **Depth:** almost flat. Separation comes from 1px borders in plum at 12% opacity (#58436C1F) and, occasionally, a soft large blur shadow under the hero input.

## Components

| Component            | How it is built                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Announcement bar     | Full-width, tinted cream-peach strip; mono 15px version tag in amber (v0.55.0), short message, underlined amber link, close X at right                                                                                                                        |
| Header               | Logo (owl mark + lowercase "" in Geist 500) left; nav links (Product and Solutions with chevrons, Pricing, Docs, Blog) in #5E5360; right side has a GitHub star pill with count, Discord icon button, Sign in text link and a pill-outlined Start free button |
| Primary button       | Amber fill #F59520, dark plum text, Geist 500 15px, 14px radius, subtle disabled state in pale peach                                                                                                                                                          |
| Secondary button     | Transparent, 1px border #241B2C at 15% opacity, fully rounded pill, dark text                                                                                                                                                                                 |
| Input                | White pill with 1px hairline border, large soft shadow, search icon at left, button nested at right                                                                                                                                                           |
| Text link with arrow | Plain dark text with a small arrow ("See an example →"); in-section links such as "Learn more" use the same quiet style                                                                                                                                       |
| Eyebrow label        | Uppercase Geist Mono 12px, 0.96px tracking, muted plum-grey                                                                                                                                                                                                   |
| Stat tile            | Large serif number, short bold label, grey caption with sample size underneath                                                                                                                                                                                |
| Numbered column      | Mono "01 / 02 / 03", serif title with a full stop ("Agents guess."), grey explanatory paragraph                                                                                                                                                               |
| Feature card         | White or transparent card, 14px radius, 1px plum hairline, mini-UI illustration on top, serif H3, one-line description, "See ..." link                                                                                                                        |
| Mock UI panels       | Small white panels with mono headers (docs, pull request, code health), tiny status chips (stale, updating, fresh), a code snippet with line numbers, and a score such as 7.4 / 10                                                                            |
| Agent prompt list    | Rows prefixed with a "›" prompt in mono, followed by a muted "calls tool_name" line                                                                                                                                                                           |
| Code / command block | Mono text on a white or inset surface with a $ prompt, used in the 3-step How it works section                                                                                                                                                                |
| FAQ                  | Question rows with expand chevrons, hairline dividers, no card backgrounds                                                                                                                                                                                    |
| Final CTA            | Repeats the hero input pattern with a short serif headline, "Index a repo free."                                                                                                                                                                              |

## Imagery, icons, motion and effects

- **Illustration style:** a soft, hand-drawn lilac plant or shrub shape sits at the edge of the hero, and the logo is a geometric owl line mark. These organic plum shapes soften an otherwise technical page.
- **Product visuals:** instead of screenshots, the site draws small interface mock-ups with real type, chips and numbers. Mock panels use white surfaces, mono headings and status colours kept within the amber and plum family.
- **Icons:** thin-stroke, monochrome line icons (search, chevrons, GitHub, Discord, arrows) in the text colour; no filled or multicolour icons.
- **Background effects:** a faint peach radial gradient behind the hero headline and a pale lilac wash at the left edge. No heavy gradients or glassmorphism.
- **Motion (observed state):** dashboard panels show live-feeling states (fresh, updating, stale) and the page uses gentle fades and hover states; hover raises border opacity to the "strong" border and the amber button lightens to #F7A94D. Keep motion subtle and functional.
- **Social proof:** a quiet row labelled USED BY DEVELOPERS AT with company logos, plus an "Explore real codebases" strip of repository cards with language, file count and indexed date in mono.

## Copy tone and how to reuse this design

**Tone.** Plain, confident and specific. Headlines are full sentences with a full stop ("Fast to write. Slow to trust."). Problems are named in two or three words ("Agents guess."). Proof is always numeric and sourced, and the site admits where it loses ("We also publish the rows we lose."). Avoid hype words; show a number or a real example instead.

**Starter tokens** for your own site (light theme):

```css
:root {
  --bg: #fbf6f1;
  --bg-alt: #fbf4ee;
  --surface: #ffffff;
  --text: #241b2c;
  --text-2: #5e5360;
  --text-muted: #8c7f88;
  --accent: #f59520; /* fills, buttons */
  --accent-text: #a16215; /* highlighted words, links */
  --accent-hover: #f7a94d;
  --plum: #a98fc4;
  --border: #58436c1f;
  --border-strong: #58436c38;
  --radius-card: 14px;
  --radius-lg: 16px;
  --radius-pill: 9999px;
  --font-serif: 'Fraunces', Georgia, serif;
  --font-sans: 'Geist', system-ui, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, monospace;
}
body {
  background: var(--bg);
  color: var(--text);
  font: 400 15px/1.5 var(--font-sans);
}
h1,
h2,
h3 {
  font-family: var(--font-serif);
  font-weight: 300;
  letter-spacing: -0.035em;
  line-height: 1.05;
}
h1 {
  font-size: 60px;
}
h2 {
  font-size: 40px;
}
h3 {
  font-size: 28px;
}
h1 em {
  color: var(--accent-text);
  font-style: normal;
}
.eyebrow {
  font: 400 12px/1.5 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.btn-primary {
  background: var(--accent);
  color: var(--text);
  font-weight: 500;
  border-radius: var(--radius-card);
  padding: 12px 20px;
}
.btn-secondary {
  border: 1px solid #241b2c26;
  border-radius: var(--radius-pill);
  padding: 10px 20px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}
section {
  padding: 112px 0;
}
```

Recipe: cream page, serif light headline with the last phrase in amber-brown, mono eyebrow above every section, hairline-bordered white cards, one amber button per view, and numbers with sources. Fraunces, Geist and Geist Mono are all free on Google Fonts. Do not copy the logo, owl mark, illustrations or wording; reuse only the system.

## As built: decisions made during the redesign

The sections above describe the reference site. This section records where the app deliberately
differs, and the rules the pages follow. Tokens live in `apps/chat-ui/app/globals.css` and are the
source of truth; components use tokens only, never raw colours, so a theme can never be missed.

### Colour

- **White page, cream cards.** The page is `#FFFFFF`; cards, panels and the sidebar are `#FCF8F4`;
  table rows sit on the page, in `--row` (`#FDFAF6`), so a table reads as lines on paper rather
  than a second card. A row the colour of the page vanishes into it, which is why `--row` exists.
- **Contrast is a gate, not a preference.** Every page test runs axe at three widths in both
  themes. Three values moved from the reference to pass WCAG AA (4.5:1) for small text: muted text
  (`#756872`; the reference's `#8C7F88` is 3.5:1 on cream), accent text (`#96590F`; `#A16215` is
  4.24:1 on the active-chip tint), and the dark theme's muted text.
- **One job per colour.** Amber is for actions and active state only. Money in uses plum
  (`--income`, a deep plum for text, a light one in dark mode). Problems use brick
  (`--destructive`), never amber. Translucent tints are laid over a solid card colour (a gradient
  of the tint on `bg-card`), because a translucent chip picks up the hovered row's own tint and
  can fall below 4.5:1.
- **Dark is a peer, not a skin.** Every token has both values. Amber ramp steps darken toward
  brown in dark mode so charts keep their order.

### Headers

- **Compact header** (eyebrow, modest serif title, inline actions) on every dense tool page, so
  the table or panels start near the top.
- **Hero** only where one sentence is the point: the Collections index, the Reports page, the
  landing page. The Dashboard began with a hero and was reworked, because it is a tool you glance
  at.
- Part of the title in `<em>` takes the accent text colour. Never a gradient on text.

### The kit (`app/components/ui`)

Panel, KpiTile, Stat and StatStrip, DataTable (`surface="page"` for rows on the page, with an
amber-tinted header band), Statement (label left, amount right, brackets for deductions, a double
rule under a total), Tabs, Segmented, Chip, JumpTo, Pager, Term, Field, NativeSelect,
SearchableSelect, PasswordInput, SplitMenu, Drawer, Dialog, EmptyState, Meter, Sparkline,
DateRangePicker, ThemeToggle. `/ui-kit` (development and tests only) shows each of them. Build a
page from these before inventing a component; if one is missing, add it to the kit.

### Patterns every page follows

- **State in the URL.** Tab, filters, search, page, sort and the open drawer are search params, so
  a view can be shared, survives a refresh, and the back button means something.
- **Drawers for detail and edits; dialogs only to confirm.** Nothing destructive happens without a
  dialog that says what will happen. No `window.confirm`.
- **Every figure explains itself.** Accounting words are wrapped in `Term` (a definition one hover
  or focus away, real text in the page, Escape dismisses it). Every total can be opened down to
  the entries behind it.
- **Honest empty, loading and error states.** An empty list says what to do next. A projection is
  labelled as one wherever it appears. A failed load shows an error, never zeros that look like
  results.
- **Read as the user.** Pages read through the signed-in user's session so row-level security
  decides what they see; see `CLAUDE.md`.

### Accessibility rules that came out of testing

- A control's accessible name must contain its visible text (axe `label-content-name-mismatch`),
  so a button that opens "Online sales" is named "Online sales, view journals", not "View entries".
- A screen-reader-only table header is positioned against its table's scroll box, not the page,
  or it widens the page on a phone when the table scrolls sideways.
- Hidden tooltips are `display: none`, not just transparent: an invisible popup near the right
  edge still makes a phone scroll sideways.
- Entrance animations fade text in, and axe reads the blended colour. Tests check at rest (reduced
  motion, and wait for animations to finish). `prefers-reduced-motion` turns animation off.
- Radix hides the page from assistive technology while a drawer is open, so tests wait for the
  dialog, not the page heading, in that state.

### The assistant panel

- **A panel, not a page.** It docks on the right where the page can keep its designed width
  (1700px and wider: sidebar, 1024px of page, panel), and the page makes room. Narrower, it
  overlays the page with a scrim (a modal: focus stays inside, Escape closes it); on a phone it is
  a full-height sheet. Pages lay out by viewport breakpoints, so pushing one narrower than it was
  designed for squeezes a desktop layout into a tablet-sized box. `/chat` is the same
  conversation full width.
- **Open state and width are a cookie**, like the theme, so the first render already makes room.
  Width is resizable by dragging the left edge or with the arrow keys on it.
- **Focus**: opening moves it to the composer; closing returns it to what opened the panel.
  ⌘/Ctrl+J toggles it from anywhere.
- **Page awareness.** Above the composer a chip says what the next question is about ("Looking
  at: Invoices, INV-0042") and can be taken off. Drawers are modal, so a drawer that shows a
  record offers **Ask about this**: it closes and the panel opens with that record in the chip.
  The record stays the context while the user is on that page.
- **A proposed change** is a card that says what changes (from, to), says "Nothing changes until
  you approve it", and has one button to approve and one to leave it. The composer is read-only
  until it is settled. A proposal the browser cannot read is never shown as approvable.
- **Memory** is a view in the panel listing what the assistant was asked to remember, with a
  delete on each item. Nothing is saved without approving it in the conversation first.
- **When it goes wrong it says why, in plain words**: asking too fast, a busy or unavailable
  model, a question that needed too much. The provider's own message is never shown (it can quote
  the prompt). After 25 seconds a turn says it is taking longer than usual and offers Stop.
- **Privacy is stated where the conversation starts**: what is sent to the model provider and how
  long conversations are kept; the conversations view can delete one or all of them (with a
  confirmation).
- **It can be switched off** (`ASSISTANT_ENABLED`): off means nothing of it shows anywhere, including
  the drawers' "Ask about this" and the product insights.
- **Cards under an answer** are built from tool results, never from the model's text, on the kit
  (Statement, DataTable, the chart theme) with pence shown. Every card ends with a quiet Source
  row: what was read, the period, and a link to the page. Follow-up chips show under the latest
  answer only.

### Motion

Subtle and functional: a short fade or rise on entrance, a stamp on a posted entry, a bar filling.
Hover raises the border to the strong colour. Nothing loops except a spinner.

### Landing page

The reference site is a developer tool; this one is books for people who make things, so the page
is laid out like the account book it is about: ruled paper, an amber margin line, a double rule
under every total. Its centrepiece is a sale you can follow from the order to the profit figure,
and it ends in three small instruments built on the real engine (the collection planner, UK
corporation tax, the VAT threshold) so a visitor can test the claims by hand. Copy follows the
reference's rules: plain, specific, and honest about limits ("what it does not do"). Figures are
labelled as sample; there are no logos, testimonials or invented statistics.
