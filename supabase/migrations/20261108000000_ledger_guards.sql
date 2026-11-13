-- The ledger's rules, enforced by the database rather than left to every piece of code that
-- writes a journal.
--
-- Until now a journal balanced because each journal builder in the agent computed balanced
-- lines; upsert_journal_with_lines accepted whatever it was given, only the accrual builder
-- checked, and accounting_health_checks noticed an unbalanced posted journal only after it was in
-- the books. Every write path (upsert_journal_with_lines, post_draft_journal, the invoice split
-- functions, the e2e seed and its restore helper, a direct write with the service key) now passes
-- through the same two checks:
--
-- 1. A journal balances: its debits equal its credits to within 1p, whatever its status. This is
--    the tolerance the agent allows (BALANCE_TOLERANCE): twenty accrual journals in production
--    are a penny out from fee rounding, so an exact rule would stop such payments being journaled
--    at all. The new journals_balanced_exactly check lists them.
--    It is a deferred constraint trigger, checked when the transaction commits, so a journal can
--    be written line by line (or its lines replaced) inside one transaction. A write in several
--    transactions must keep each journal's lines together.
-- 2. A line posts only to a posting account: not a header, and active. post_draft_journal used
--    to accept any account id for the line it fixes.
--
-- And four more health checks, so what the books get wrong is visible:
--   journals_balanced_exactly         journals out by the 1p the rule allows          (warn)
--   excluded_transactions_unposted    posted journals of transactions marked excluded (fail)
--   uncategorised_expenses            posted to 8090 Miscellaneous                    (warn)
--   cash_ties_to_bank                 Revolut cash accounts against the bank balance  (fail)
--
-- Existing rows are not re-checked: every journal in production balances to within 1p and none
-- posts to a header or inactive account, so nothing already stored is refused.

-- ── 1. Journals balance ──────────────────────────────────────────────────────────────────────

create or replace function public.assert_journal_balanced(p_journal_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $$
declare
  v_debit numeric;
  v_credit numeric;
begin
  if p_journal_id is null or not exists (select 1 from journals where id = p_journal_id) then
    return; -- the journal itself was deleted (its lines go with it)
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
    from journal_line_items
   where journal_id = p_journal_id;

  if abs(v_debit - v_credit) > 0.01 then
    raise exception 'Journal % does not balance: debits %, credits %', p_journal_id,
      round(v_debit, 2), round(v_credit, 2)
      using errcode = 'check_violation',
            hint = 'A journal''s debits must equal its credits (to within 1p).';
  end if;
end;
$$;

create or replace function public.journal_lines_must_balance()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform assert_journal_balanced(new.journal_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.journal_id is distinct from new.journal_id) then
    perform assert_journal_balanced(old.journal_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_journal_lines_balance on public.journal_line_items;
create constraint trigger trg_journal_lines_balance
  after insert or update or delete on public.journal_line_items
  deferrable initially deferred
  for each row execute function public.journal_lines_must_balance();

-- ── 2. Lines post only to posting accounts ───────────────────────────────────────────────────

create or replace function public.journal_line_account_must_post()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_account record;
begin
  select account_number, name, is_header, status into v_account
    from chart_of_accounts where id = new.account_id;
  if not found then
    return new; -- the foreign key refuses it
  end if;
  if v_account.is_header then
    raise exception 'Account % (%) is a header account and cannot be posted to',
      v_account.account_number, v_account.name
      using errcode = 'check_violation';
  end if;
  if v_account.status <> 'active' then
    raise exception 'Account % (%) is %, so it cannot be posted to',
      v_account.account_number, v_account.name, v_account.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_journal_line_account on public.journal_line_items;
create trigger trg_journal_line_account
  before insert or update of account_id on public.journal_line_items
  for each row execute function public.journal_line_account_must_post();

-- Trigger functions only; nobody calls them directly.
revoke execute on function public.assert_journal_balanced(uuid) from public, anon, authenticated;
revoke execute on function public.journal_lines_must_balance() from public, anon, authenticated;
revoke execute on function public.journal_line_account_must_post() from public, anon, authenticated;

-- ── 3. Health checks ─────────────────────────────────────────────────────────────────────────
-- The existing checks keep their definition under a new name; accounting_health_checks is them
-- plus the ledger checks below, so its columns and every reader stay the same.

alter view public.accounting_health_checks rename to accounting_health_checks_inventory;

create view public.ledger_health_checks
with (security_invoker = true) as
with journal_totals as (
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
  join journal_line_items l on l.journal_id = j.id
  where j.status = 'posted' and (f.excluded_reason is not null or f.status = 'excluded')
), misc as (
  select count(distinct j.id) as n, coalesce(sum(l.debit - l.credit), 0) as amount
  from journal_line_items l
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
  from journal_line_items l
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
       'Revolut cash accounts (1014 to 1016) against the bank balance, allowing for counted '
         || 'transactions not yet posted. ' || coalesce((select detail from cash), 'No accounts.');

create view public.accounting_health_checks
with (security_invoker = true) as
select check_name, severity, item_count, amount, detail from public.accounting_health_checks_inventory
union all
select check_name, severity, item_count, amount, detail from public.ledger_health_checks;

comment on view public.accounting_health_checks is
  'Assertions about ledger and inventory integrity, one row per check. Any row with '
  'severity=''fail'' means the books are wrong or an automated process has stopped working; '
  '''warn'' rows are known gaps. Query this rather than remembering which individual view to '
  'look at.';

revoke all on public.accounting_health_checks_inventory from anon;
revoke all on public.ledger_health_checks from anon;
revoke all on public.accounting_health_checks from anon;
grant select on public.ledger_health_checks to authenticated, service_role;
grant select on public.accounting_health_checks to authenticated, service_role;
