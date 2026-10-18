/**
 * Profit and loss, and the balance sheet. Both are read from the double-entry ledger (posted
 * journals only), so every line opens the journals behind it.
 */

import { EmptyState } from '~/components/ui/empty-state';
import { Panel } from '~/components/ui/panel';
import { Statement, type StatementRow } from '~/components/ui/statement';
import { Term } from '~/components/ui/term';
import type { AccountLine, ReportsData } from '~/lib/api/reports.server';
import { hasBalanceSheet, hasProfitAndLoss, money, type DrilldownTarget } from './model';

const SECTION_DEFINITIONS: Record<string, string> = {
  revenue:
    'Income earned. Revenue accounts carry credit balances; discounts and returns are netted off.',
  cogs: 'Direct cost of the products sold. These accounts carry debit balances.',
  expense: 'Costs of running the business. These accounts carry debit balances.',
};

export function ProfitLossTab({
  data,
  onSelect,
}: {
  data: ReportsData;
  onSelect: (target: DrilldownTarget) => void;
}) {
  const { accountingPnL } = data;
  if (!hasProfitAndLoss(data)) {
    return (
      <EmptyState
        eyebrow="Profit and loss"
        title="No journals in this period."
        description="The profit and loss is built from posted journals. Generate journals from your integrations, or add one by hand."
      />
    );
  }

  const rows: StatementRow[] = [];
  for (const section of accountingPnL.sections) {
    rows.push({
      kind: 'section',
      label: <Term definition={SECTION_DEFINITIONS[section.type] ?? ''}>{section.label}</Term>,
    });
    for (const account of section.accounts) {
      rows.push({
        kind: 'line',
        label: `${account.code} · ${account.name}`,
        amount: account.balance,
        indent: true,
        onSelect: account.id
          ? () =>
              onSelect({
                accountId: String(account.id),
                accountName: account.name,
                accountCode: account.code,
                statement: 'pnl',
              })
          : undefined,
        // The name must contain the visible text (code and name), then say what the button does.
        selectLabel: `${account.code} · ${account.name}, view journals`,
      });
    }
    rows.push({
      kind: 'total',
      label: `Total ${section.label.toLowerCase()}`,
      amount: section.total,
    });
    if (section.type === 'cogs') {
      rows.push({
        kind: 'total',
        label: (
          <Term definition="Revenue less cost of goods sold: profit before running costs.">
            Gross profit
          </Term>
        ),
        amount: accountingPnL.grossProfit,
      });
    }
  }
  rows.push({
    kind: 'grand',
    label: (
      <Term definition="Gross profit less operating expenses: the bottom line for the period.">
        Net income
      </Term>
    ),
    amount: accountingPnL.netIncome,
  });

  return (
    <Panel
      title="Profit and loss"
      note="From posted journals, for the period you chose. Select a line to see its journals."
    >
      <Statement rows={rows} />
    </Panel>
  );
}

function accountRows(
  accounts: AccountLine[],
  onSelect: (target: DrilldownTarget) => void
): StatementRow[] {
  return accounts.map(account => ({
    kind: 'line' as const,
    label: `${account.code} · ${account.name}`,
    amount: account.balance,
    indent: true,
    // The synthetic retained-earnings line has no account behind it.
    onSelect: account.id
      ? () =>
          onSelect({
            accountId: String(account.id),
            accountName: account.name,
            accountCode: account.code,
            statement: 'balance',
          })
      : undefined,
    // The name must contain the visible text (code and name), then say what the button does.
    selectLabel: `${account.code} · ${account.name}, view journals`,
  }));
}

export function BalanceSheetTab({
  data,
  onSelect,
}: {
  data: ReportsData;
  onSelect: (target: DrilldownTarget) => void;
}) {
  const { balanceSheet } = data;
  if (!hasBalanceSheet(data)) {
    return (
      <EmptyState
        eyebrow="Balance sheet"
        title="No balances yet."
        description="The balance sheet is built from posted journals."
      />
    );
  }

  const rows: StatementRow[] = [
    {
      kind: 'section',
      label: (
        <Term definition="What the business owns. Asset accounts carry debit balances: a positive figure is value held.">
          Assets
        </Term>
      ),
    },
    ...accountRows(balanceSheet.assets, onSelect),
    { kind: 'total', label: 'Total assets', amount: balanceSheet.totalAssets },
    {
      kind: 'section',
      label: (
        <Term definition="What the business owes. Liability accounts carry credit balances: a positive figure is money owed.">
          Liabilities
        </Term>
      ),
    },
    ...accountRows(balanceSheet.liabilities, onSelect),
    { kind: 'total', label: 'Total liabilities', amount: balanceSheet.totalLiabilities },
    {
      kind: 'section',
      label: (
        <Term definition="What is left for the owners once liabilities are taken from assets: money paid in, plus profit kept (retained earnings, which is worked out from the whole history because the year-end is not closed in the ledger).">
          Equity
        </Term>
      ),
    },
    ...accountRows(balanceSheet.equity, onSelect),
    { kind: 'total', label: 'Total equity', amount: balanceSheet.totalEquity },
    {
      kind: 'grand',
      label: (
        <Term definition="Total liabilities plus total equity. In balanced books this equals total assets.">
          Liabilities and equity
        </Term>
      ),
      amount: balanceSheet.totalLiabilities + balanceSheet.totalEquity,
    },
  ];

  const asOf = data.dateRange.to
    ? new Date(data.dateRange.to).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  return (
    <Panel
      title="Balance sheet"
      note={`${asOf ? `As at ${asOf}` : 'As at today'}: everything posted up to then. Select a line to see its journals.`}
    >
      <Statement rows={rows} />
      {Math.abs(balanceSheet.balanceCheck) >= 0.01 && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-[14px] text-destructive"
        >
          Assets ({money(balanceSheet.totalAssets)}) do not equal liabilities and equity (
          {money(balanceSheet.totalLiabilities + balanceSheet.totalEquity)}): the books are out by{' '}
          {money(Math.abs(balanceSheet.balanceCheck))}. A journal is probably unbalanced or missing
          a side.
        </p>
      )}
    </Panel>
  );
}
