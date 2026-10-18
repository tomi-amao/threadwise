import { getServerSupabaseClient } from '~/lib/supabase';
import { fetchAllRows } from './paginate.server';

type SupabaseClient = ReturnType<typeof getServerSupabaseClient>;

type BankAccountRow = {
  id: string;
  name: string | null;
  currency: string | null;
  balance: number | string | null;
  source: string | null;
  updated_at: string | null;
};

type BankTransactionRow = {
  bank_account_id: string | null;
  base_amount: number | string | null;
  amount: number | string | null;
  direction: string | null;
  occurred_at: string | null;
};

export interface DerivedBankAccountBalance {
  id: string;
  name: string | null;
  currency: string | null;
  source: string | null;
  balance: number;
}

export interface DerivedBankBalances {
  accounts: DerivedBankAccountBalance[];
  totalBalance: number;
  balanceAsOf: string | null;
  isLive: boolean;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`;
}

export async function getDerivedBankBalances(
  supabase: SupabaseClient,
  options: { asOf?: string | null } = {}
): Promise<DerivedBankBalances> {
  const balanceAsOf = options.asOf ? endOfDay(options.asOf) : null;
  const { data: bankAccounts, error: bankAccountsError } = await supabase
    .from('bank_accounts')
    .select('id, name, currency, balance, source, updated_at, state')
    .eq('state', 'active');

  if (bankAccountsError) {
    throw new Error(`Failed to load bank accounts: ${bankAccountsError.message}`);
  }

  const activeBankAccounts = (bankAccounts || []) as BankAccountRow[];
  if (activeBankAccounts.length === 0) {
    return {
      accounts: [],
      totalBalance: 0,
      balanceAsOf,
      isLive: true,
    };
  }

  const accountIds = activeBankAccounts.map(account => account.id);
  const earliestSnapshot =
    activeBankAccounts
      .map(account => account.updated_at)
      .filter((value): value is string => Boolean(value))
      .sort()[0] || null;
  const lowerBound =
    [balanceAsOf, earliestSnapshot].filter((value): value is string => Boolean(value)).sort()[0] ||
    null;

  // Every transaction after the snapshot, not just the API's first 1,000 (see paginate.server.ts).
  // A silently truncated list here understates or overstates the bank balance.
  const bankTransactions = await fetchAllRows<BankTransactionRow>(
    'bank transactions',
    (from, to) => {
      let query = supabase
        .from('financial_transactions')
        .select('bank_account_id, base_amount, amount, direction, occurred_at')
        .in('bank_account_id', accountIds)
        .neq('status', 'excluded')
        .order('id');
      if (lowerBound) query = query.gt('occurred_at', lowerBound);
      return query.range(from, to);
    }
  );

  const relevantTransactions = bankTransactions;

  const snapshotByAccountId = new Map(
    activeBankAccounts.map(account => [
      account.id,
      {
        updatedAt: account.updated_at ? new Date(account.updated_at).getTime() : null,
      },
    ])
  );
  const balanceByAccountId = new Map(
    activeBankAccounts.map(account => [account.id, Number(account.balance || 0)])
  );

  for (const txn of relevantTransactions) {
    const bankAccountId = txn.bank_account_id;
    if (!bankAccountId) continue;

    const snapshot = snapshotByAccountId.get(bankAccountId);
    if (!snapshot) continue;

    const occurredAt = txn.occurred_at ? new Date(txn.occurred_at).getTime() : null;
    if (snapshot.updatedAt !== null && occurredAt !== null && occurredAt <= snapshot.updatedAt) {
      continue;
    }

    const amount = Number(txn.base_amount || txn.amount || 0);
    const signedAmount = txn.direction === 'in' ? amount : -amount;
    balanceByAccountId.set(
      bankAccountId,
      (balanceByAccountId.get(bankAccountId) || 0) + signedAmount
    );
  }

  if (balanceAsOf) {
    const balanceAsOfTs = new Date(balanceAsOf).getTime();
    for (const txn of relevantTransactions) {
      const bankAccountId = txn.bank_account_id;
      if (!bankAccountId || !txn.occurred_at) continue;

      const occurredAt = new Date(txn.occurred_at).getTime();
      if (occurredAt <= balanceAsOfTs) continue;

      const amount = Number(txn.base_amount || txn.amount || 0);
      const signedAmount = txn.direction === 'in' ? amount : -amount;
      balanceByAccountId.set(
        bankAccountId,
        (balanceByAccountId.get(bankAccountId) || 0) - signedAmount
      );
    }
  }

  const accounts = activeBankAccounts
    .map(account => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
      source: account.source,
      balance: roundMoney(balanceByAccountId.get(account.id) || 0),
    }))
    .sort((left, right) => right.balance - left.balance);

  return {
    accounts,
    totalBalance: roundMoney(accounts.reduce((sum, account) => sum + account.balance, 0)),
    balanceAsOf,
    isLive: !balanceAsOf || balanceAsOf >= new Date().toISOString(),
  };
}
