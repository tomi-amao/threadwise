import { Link } from 'react-router';
import { Chip } from '~/components/ui/chip';
import { Meter } from '~/components/ui/meter';
import { Panel, PanelLink } from '~/components/ui/panel';
import type { BankAccountSummary } from '~/types/dashboard';
import { money, pct, share } from './format';

export function CashPanel({
  accounts,
  currency,
}: {
  accounts: BankAccountSummary[];
  currency: string;
}) {
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const shownCurrency = accounts[0]?.currency || currency;

  return (
    <Panel
      testId="panel-cash"
      className="xl:col-span-4"
      title="Bank accounts"
      note="Live balances."
      action={<PanelLink to="/reports">Cash flow</PanelLink>}
    >
      {accounts.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-2">
          No bank accounts connected.{' '}
          <Link to="/integrations" className="text-accent-text underline underline-offset-4">
            Connect a bank
          </Link>
        </p>
      ) : (
        <>
          <div className="mb-4 font-serif text-[30px] tabular-nums">
            {money(total, shownCurrency)}
          </div>
          <ul className="grid gap-4">
            {accounts.map(a => (
              <li key={a.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{a.name || `${a.source} account`}</span>
                    <Chip>{a.source}</Chip>
                  </div>
                  <span className="tabular-nums">{money(a.balance, a.currency, 2)}</span>
                </div>
                <Meter
                  className="mt-2"
                  value={total > 0 ? a.balance / total : 0}
                  label={`${pct(share(a.balance, total))} of total cash`}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
