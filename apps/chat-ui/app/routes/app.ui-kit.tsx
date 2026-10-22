/**
 * Design-system gallery (development and tests only; see routes.ts).
 *
 * Every shared primitive in both themes on one page. Used by the Playwright suite for
 * theme, contrast, overflow and accessibility checks, and by humans to eyeball changes.
 */

import { useState } from 'react';
import type { MetaFunction } from 'react-router';
import { Button } from '~/components/ui/button';
import { Chip, type ChipTone } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { Drawer } from '~/components/ui/drawer';
import { EmptyState } from '~/components/ui/empty-state';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { KpiTile } from '~/components/ui/kpi-tile';
import { Meter } from '~/components/ui/meter';
import { CompactHeader, Hero, Page, PageSection } from '~/components/ui/page-header';
import { Panel, PanelLink } from '~/components/ui/panel';
import { Segmented } from '~/components/ui/segmented';
import { Stat, StatStrip } from '~/components/ui/stat-strip';
import { Statement } from '~/components/ui/statement';
import { Tabs } from '~/components/ui/tabs';
import { ThemeToggle } from '~/components/ui/theme-toggle';
import { BarChart, LineChart, ShareChart } from '~/components/charts';
import { AssistantCard } from '~/components/assistant/cards';
import {
  parseClarify,
  parseProposal,
  parseUiMessage,
  type ParsedUi,
} from '~/components/assistant/catalogue';
import { ClarifyPrompt, FollowUpChips, ProposalCard } from '~/components/assistant/chips';
import contract from '~/components/assistant/ui-contract.json';

export const meta: MetaFunction = () => [{ title: 'UI kit - ThreadWise' }];

const MONTHS = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
const SALES = [21400, 34800, 12600, 9800, 15200, 58200, 17900, 12300, 10400, 16800, 47300, 14200];
const TONES: ChipTone[] = ['active', 'planned', 'done', 'draft', 'negative', 'income', 'plain'];

/** Every example in the UI contract, through the same validation the thread uses. */
const ASSISTANT_EXAMPLES: ParsedUi[] = Object.entries(contract.examples).flatMap(([name, list]) =>
  (list as unknown[]).flatMap((props, i) => {
    const ui = parseUiMessage({ id: `${name}-${i}`, name, props });
    return ui ? [ui] : [];
  })
);
const CLARIFY_EXAMPLE = parseClarify(contract.interrupt_examples.clarify[0]);
const PROPOSAL_EXAMPLE = parseProposal(contract.interrupt_examples.proposal[0]);

function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <PageSection className="mt-14" data-testid={id}>
      <Eyebrow>{title}</Eyebrow>
      <div className="mt-4">{children}</div>
    </PageSection>
  );
}

export default function UiKit() {
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const [tab, setTab] = useState<'overview' | 'plan' | 'costs'>('overview');
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  return (
    <Page>
      <CompactHeader
        eyebrow="Design system"
        title={
          <>
            Every part, <em>both themes.</em>
          </>
        }
        description="Development-only gallery of the shared components."
        actions={<ThemeToggle />}
      />

      <Block id="hero" title="Hero">
        <div className="overflow-hidden rounded-2xl border">
          <Hero
            titleAs="h2"
            eyebrow="Reports · Jan 1 to Oct 17"
            title={
              <>
                Where the money <em>actually went.</em>
              </>
            }
            lead="One short paragraph in the secondary text colour."
          />
        </div>
      </Block>

      <Block id="buttons" title="Buttons and inputs">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="mt-5 grid max-w-xl gap-4 sm:grid-cols-2">
          <Field label="Counterparty" hint="Shown on the statement.">
            <Input placeholder="Porto Knitwear" />
          </Field>
          <Field label="Amount">
            <Input type="number" placeholder="1200" />
          </Field>
        </div>
      </Block>

      <Block id="chips" title="Chips">
        <div className="flex flex-wrap gap-2">
          {TONES.map(t => (
            <Chip key={t} tone={t} dot>
              {t}
            </Chip>
          ))}
        </div>
      </Block>

      <Block id="navigation" title="Segmented and tabs">
        <div className="flex flex-wrap items-center gap-4">
          <Segmented
            label="Direction"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'in', label: 'In' },
              { value: 'out', label: 'Out' },
            ]}
          />
        </div>
        <Tabs
          className="mt-6"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'plan', label: 'Plan' },
            { id: 'costs', label: 'Costs', count: 12 },
          ]}
        />
      </Block>

      <Block id="stats" title="Stat strip and meter">
        <StatStrip>
          <Stat
            label="Revenue"
            value="£152,325"
            title="Across all collections"
            caption="2,724 units sold"
          />
          <Stat label="Costs" value="£67,550" title="Attributed spend" caption="17 transactions" />
          <Stat
            label="Gross profit"
            value="£84,775"
            title="Revenue less costs"
            tone="income"
            caption="55.7% margin"
          />
          <Stat
            label="Over budget"
            value="−£1,200"
            title="Marketing"
            tone="negative"
            caption="Spend exceeded plan"
          />
        </StatStrip>
        <div className="mt-5 grid max-w-md gap-4">
          <Meter value={0.62} label="62% of budget used" />
          <Meter value={1} over label="Budget exceeded" />
        </div>
      </Block>

      <Block id="dashboard-parts" title="KPI tiles and panels">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiTile label="Gross revenue" value="£268,837" caption="1,200 orders" trend={SALES} />
          <KpiTile label="Net revenue" value="£311,171" caption="After fees and refunds" />
          <KpiTile
            label="Orders"
            value="1,200"
            caption="Avg £224.03"
            trend={SALES.map(v => Math.round(v / 70))}
          />
          <KpiTile label="In the bank" value="−£4,200" caption="2 accounts" tone="negative" />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel
            flush
            title="Top products"
            note="Three products carry 61% of sales."
            action={<PanelLink to="/products">All products</PanelLink>}
          >
            <DataTable bare dense label="Top products">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Wool Overshirt</td>
                  <td className="text-right tabular-nums">£58,900</td>
                </tr>
                <tr>
                  <td>Heavy Knit Cardigan</td>
                  <td className="text-right tabular-nums">£40,768</td>
                </tr>
              </tbody>
            </DataTable>
          </Panel>
          <Panel
            title="Bank accounts"
            note="Live balances."
            action={<PanelLink to="/reports">Cash flow</PanelLink>}
          >
            <Meter value={0.62} label="62% of total cash" />
          </Panel>
        </div>
      </Block>

      <Block id="table" title="Data table">
        <DataTable label="Collections">
          <thead>
            <tr>
              <th>Collection</th>
              <th>Status</th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Autumn Layers 26</td>
              <td>
                <Chip tone="active" dot>
                  Active
                </Chip>
              </td>
              <td className="text-right tabular-nums">£43,611</td>
              <td className="text-right tabular-nums">64.9%</td>
            </tr>
            <tr>
              <td>Winter Capsule</td>
              <td>
                <Chip tone="planned" dot>
                  Planned
                </Chip>
              </td>
              <td className="text-right tabular-nums">—</td>
              <td className="text-right tabular-nums">—</td>
            </tr>
          </tbody>
        </DataTable>
      </Block>

      <Block id="statement" title="Statement">
        <div className="max-w-xl rounded-2xl border p-6">
          <Statement
            rows={[
              { kind: 'section', label: 'Revenue' },
              {
                kind: 'line',
                label: 'Online sales',
                amount: 202400,
                indent: true,
                onSelect: () => undefined,
                selectLabel: 'View Online sales entries',
              },
              { kind: 'line', label: 'Discounts', amount: 14100, deduct: true, indent: true },
              { kind: 'total', label: 'Net sales', amount: 188300 },
              { kind: 'grand', label: 'Net income', amount: -4200 },
            ]}
          />
        </div>
      </Block>

      <Block id="charts" title="Charts (Nivo, themed)">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border p-5">
            <BarChart
              ariaLabel="Monthly gross revenue"
              data={MONTHS.map((label, i) => ({ label, value: SALES[i] }))}
            />
          </div>
          <div className="rounded-2xl border p-5">
            <LineChart
              ariaLabel="Total sales against net income"
              series={[
                { id: 'Total sales', data: MONTHS.map((x, i) => ({ x, y: SALES[i] })) },
                {
                  id: 'Net income',
                  data: MONTHS.map((x, i) => ({ x, y: Math.round(SALES[i] * 0.3) })),
                },
              ]}
            />
          </div>
          <div className="rounded-2xl border p-5 lg:col-span-2">
            <ShareChart
              ariaLabel="Payment methods"
              data={[
                { id: 'card', label: 'Card', value: 154000 },
                { id: 'paypal', label: 'PayPal', value: 63800 },
                { id: 'apple', label: 'Apple Pay', value: 31900 },
                { id: 'klarna', label: 'Klarna', value: 16000 },
              ]}
            />
          </div>
        </div>
      </Block>

      <Block id="assistant" title="Assistant (generative UI)">
        <div className="grid gap-4 lg:grid-cols-2">
          {ASSISTANT_EXAMPLES.filter(ui => ui.name !== 'follow-ups').map(ui => (
            <AssistantCard key={ui.id} ui={ui} />
          ))}
        </div>
        <div className="mt-6 space-y-4">
          {ASSISTANT_EXAMPLES.map(ui =>
            ui.name === 'follow-ups' ? (
              <FollowUpChips key={ui.id} data={ui.props} onSelect={setSent} />
            ) : null
          )}
          {CLARIFY_EXAMPLE && (
            <ClarifyPrompt clarify={CLARIFY_EXAMPLE} onAnswer={a => setSent(a)} />
          )}
          {PROPOSAL_EXAMPLE && (
            <ProposalCard
              proposal={PROPOSAL_EXAMPLE}
              onDecide={decision => setSent(`Would ${decision}: ${PROPOSAL_EXAMPLE.title}`)}
            />
          )}
          <p role="status" className="text-sm text-text-2">
            {sent ? `Would send: ${sent}` : 'Click a suggestion to see what it sends.'}
          </p>
        </div>
      </Block>

      <Block id="overlays" title="Drawer and empty state">
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open drawer
        </Button>
        <div className="mt-6 rounded-2xl border">
          <EmptyState
            eyebrow="No products linked"
            title="Nothing in this collection yet."
            description="Use “Add product” to attach items from your catalogue."
            action={<Button variant="outline">Add product</Button>}
          />
        </div>
      </Block>

      <Drawer
        open={open}
        onOpenChange={setOpen}
        eyebrow="Add cost"
        title="Link a piece of spend."
        description="Add a cost to this collection."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Add cost</Button>
          </>
        }
      >
        <Field label="Vendor">
          <Input placeholder="Porto Knitwear" />
        </Field>
        <Field label="Amount (GBP)">
          <Input type="number" placeholder="1200" />
        </Field>
      </Drawer>
    </Page>
  );
}
