import { Wallet } from 'phosphor-react';
import type { BankAccountSummary } from '~/types/dashboard';

interface BankAccountsProps {
  accounts: BankAccountSummary[];
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export function BankAccounts({ accounts }: BankAccountsProps) {
  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Bank Accounts</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Total: {formatCurrency(totalBalance, accounts[0]?.currency || 'GBP')}
          </p>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">
          No bank accounts connected
        </div>
      ) : (
        <div className="space-y-2.5">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border/50"
            >
              <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <Wallet size={16} className="text-cyan-500" weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">
                  {account.name || `${account.source} Account`}
                </p>
                <p className="text-xs text-muted-foreground capitalize">{account.source}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-foreground">
                  {formatCurrency(account.balance, account.currency)}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase">{account.currency}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
