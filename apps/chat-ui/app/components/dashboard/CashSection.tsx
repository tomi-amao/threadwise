import { Link } from 'react-router';
import { Chip } from '~/components/ui/chip';
import { EmptyState } from '~/components/ui/empty-state';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Meter } from '~/components/ui/meter';
import type { BankAccountSummary } from '~/types/dashboard';
import { Section, SeeAll } from './Section';
import { money, pct, share } from './format';

export function CashSection({
  accounts,
  currency,
}: {
  accounts: BankAccountSummary[];
  currency: string;
}) {
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const n = accounts.length;

  return (
    <Section
      band
      eyebrow="Cash"
      title={
        n > 0 ? (
          <>
            {money(total, accounts[0]?.currency || currency)}{' '}
            <em>
              across {n} {n === 1 ? 'account' : 'accounts'}.
            </em>
          </>
        ) : (
          <>
            Cash, <em>once a bank is connected.</em>
          </>
        )
      }
      note="Live balances from connected banks and PayPal."
      action={<SeeAll to="/reports">Cash flow</SeeAll>}
    >
      {n === 0 ? (
        <div className="rounded-2xl border bg-card">
          <EmptyState
            title="No bank accounts connected."
            action={
              <Link to="/integrations" className="text-accent-text underline underline-offset-4">
                Connect a bank
              </Link>
            }
          />
        </div>
      ) : (
        <ul className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {accounts.map(a => (
            <li
              key={a.id}
              className="min-w-0 rounded-2xl border bg-card p-6 transition-colors hover:border-border-strong"
            >
              <div className="flex items-center justify-between gap-3">
                <Eyebrow>{a.source}</Eyebrow>
                <Chip>{a.currency}</Chip>
              </div>
              <div className="mb-1 mt-3.5 font-serif text-4xl tabular-nums">
                {money(a.balance, a.currency, 2)}
              </div>
              <div className="text-text-2">{a.name || `${a.source} account`}</div>
              <Meter
                className="mt-4"
                value={total > 0 ? a.balance / total : 0}
                label={`${pct(share(a.balance, total))} of total cash`}
              />
              <div className="mt-2 font-mono text-xs text-muted-foreground">
                {pct(share(a.balance, total)).toUpperCase()} OF TOTAL
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
