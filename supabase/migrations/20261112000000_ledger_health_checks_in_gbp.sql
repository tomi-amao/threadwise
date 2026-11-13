-- Ledger health checks count every line in pounds.
--
-- 20261108000000_ledger_guards summed journal lines' debit and credit as they are stored. A line in
-- another currency stores its own currency's amount there and its value in pounds in
-- gbp_equivalent, so a €554.25 refund on Revolut GBP (1014) counted as £554.25 instead of its
-- £479.97, and cash_ties_to_bank reported £74.28 that was not there.
--
-- The amounts now use the rule the balance sheet (apps/chat-ui reports.server.ts) and the chat
-- agent (tools/data_tools.py) already use: a GBP line counts its debit and credit, any other line
-- counts its gbp_equivalent on the side it is on, and a line with no gbp_equivalent counts
-- nothing. The check therefore agrees with the balance sheet a person is looking at.
--
-- journals_balanced_exactly still compares each journal's own debits and credits: a journal is in
-- one currency, and that is what the balance trigger checks.
--
-- excluded_transactions_unposted no longer counts currency conversions. A conversion moves money
-- between the business's own accounts, so both of its legs are kept off the transaction list on
-- purpose while its fx_conversion journal moves the money between the cash accounts; reporting
-- it hid the exclusions that are real mistakes.

create or replace view public.ledger_health_checks
with (security_invoker = true) as
with line_gbp as (
  select l.journal_id, l.account_id,
         case when upper(coalesce(l.currency, 'GBP')) = 'GBP' then l.debit
              when l.debit > 0 then coalesce(l.gbp_equivalent, 0)
              else 0 end as debit,
         case when upper(coalesce(l.currency, 'GBP')) = 'GBP' then l.credit
              when l.credit > 0 then coalesce(l.gbp_equivalent, 0)
              else 0 end as credit
  from journal_line_items l
), journal_totals as (
  select l.journal_id, sum(l.debit) as debit, sum(l.credit) as credit
  from journal_line_items l
  group by 1
), penny_out as (
  select count(*) as n, coalesce(sum(t.debit - t.credit), 0) as amount
  from journal_totals t
  join journals j on j.id = t.journal_id
  where j.status <> 'reversed' and t.debit <> t.credit
), excluded_posted as (
  select count(distinct j.id) as n, coalesce(sum(l.debit), 0) as amount
  from journals j
  join financial_transactions f on f.id = j.source_id and j.source_type = 'financial_transaction'
  join line_gbp l on l.journal_id = j.id
  where j.status = 'posted' and (f.excluded_reason is not null or f.status = 'excluded')
    and j.journal_type <> 'fx_conversion'
), misc as (
  select count(distinct j.id) as n, coalesce(sum(l.debit - l.credit), 0) as amount
  from line_gbp l
  join journals j on j.id = l.journal_id
  join chart_of_accounts a on a.id = l.account_id
  where j.status = 'posted' and a.account_number = '8090'
), bank as (
  select b.entity_id, upper(b.currency) as cur, sum(b.balance) as balance
  from bank_accounts b
  where b.source = 'revolut' and upper(b.currency) in ('GBP', 'EUR', 'USD')
  group by 1, 2
), cash_account(cur, account_number) as (
  -- account_mapping.resolve_cash_account for Revolut
  values ('GBP', '1014'), ('EUR', '1015'), ('USD', '1016')
), ledger as (
  select j.entity_id, a.account_number, sum(l.debit - l.credit) as balance
  from line_gbp l
  join journals j on j.id = l.journal_id
  join chart_of_accounts a on a.id = l.account_id
  where j.status = 'posted' and a.account_number in ('1014', '1015', '1016')
  group by 1, 2
), not_yet_posted as (
  -- Counted Revolut transactions not in the ledger yet, on the cash account their journal will
  -- use: their own currency's, or GBP for a foreign charge paid from the GBP account.
  select f.entity_id, t.cur,
         sum((case when upper(f.currency_code) = t.cur then f.amount else f.base_amount end)
             * case when f.direction = 'in' then 1 else -1 end) as amount,
         count(*) as n
  from financial_transactions f
  cross join lateral (
    select case when upper(f.currency_code) in ('EUR', 'USD') and f.fx_rate is null
                then upper(f.currency_code) else 'GBP' end as cur
  ) t
  where f.source = 'revolut'
    and f.excluded_reason is null and f.status <> 'excluded'
    and not exists (
      select 1 from journals j
      where j.source_type = 'financial_transaction' and j.source_id = f.id
        and j.status = 'posted'
    )
  group by 1, 2
), tie as (
  select bank.cur, bank.balance as bank, coalesce(ledger.balance, 0) as ledger,
         coalesce(p.amount, 0) as not_posted,
         bank.balance - coalesce(ledger.balance, 0) - coalesce(p.amount, 0) as difference
  from bank
  join cash_account using (cur)
  left join ledger on ledger.entity_id = bank.entity_id
                  and ledger.account_number = cash_account.account_number
  left join not_yet_posted p on p.entity_id = bank.entity_id and p.cur = bank.cur
), cash as (
  select count(*) filter (where abs(difference) > 1) as n,
         coalesce(sum(difference) filter (where abs(difference) > 1), 0) as amount,
         string_agg(
           cur || ': bank ' || round(bank, 2) || ', ledger ' || round(ledger, 2)
             || ', not yet posted ' || round(not_posted, 2) || ', unexplained '
             || round(difference, 2),
           '; ' order by cur
         ) as detail
  from tie
)
select 'journals_balanced_exactly'::text as check_name,
       case when (select n from penny_out) = 0 then 'ok' else 'warn' end as severity,
       (select n from penny_out)::integer as item_count,
       (select round(amount, 2) from penny_out) as amount,
       'Journals whose debits and credits differ by the 1p rounding the ledger allows'::text
         as detail
union all
select 'excluded_transactions_unposted',
       case when (select n from excluded_posted) = 0 then 'ok' else 'fail' end,
       (select n from excluded_posted)::integer,
       (select round(amount, 2) from excluded_posted),
       'Posted journals of transactions marked excluded: the books count money the transaction '
         || 'list says did not move. Reverse the journal or include the transaction again.'
union all
select 'uncategorised_expenses',
       case when (select n from misc) = 0 then 'ok' else 'warn' end,
       (select n from misc)::integer,
       (select round(amount, 2) from misc),
       'Posted journals on 8090 Miscellaneous Expense, which should be reclassified before a '
         || 'period is closed.'
union all
select 'cash_ties_to_bank',
       case when (select n from cash) = 0 then 'ok' else 'fail' end,
       (select n from cash)::integer,
       (select round(amount, 2) from cash),
       'Revolut cash accounts (1014 to 1016) in pounds against the bank balance, allowing for '
         || 'counted transactions not yet posted. '
         || coalesce((select detail from cash), 'No accounts.');
