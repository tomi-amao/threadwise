


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."account_status" AS ENUM (
    'active',
    'inactive',
    'archived'
);


ALTER TYPE "public"."account_status" OWNER TO "postgres";


CREATE TYPE "public"."account_type" AS ENUM (
    'asset',
    'liability',
    'equity',
    'revenue',
    'expense',
    'cogs'
);


ALTER TYPE "public"."account_type" OWNER TO "postgres";


CREATE TYPE "public"."contact_type" AS ENUM (
    'supplier',
    'customer',
    'both'
);


ALTER TYPE "public"."contact_type" OWNER TO "postgres";


CREATE TYPE "public"."financial_transaction_type" AS ENUM (
    'payout',
    'fee',
    'refund',
    'transfer',
    'fx',
    'chargeback',
    'adjustment',
    'expense'
);


ALTER TYPE "public"."financial_transaction_type" OWNER TO "postgres";


CREATE TYPE "public"."invoice_status" AS ENUM (
    'DRAFT',
    'OPEN',
    'PAID',
    'PARTIALLY_PAID',
    'OVERDUE',
    'CANCELLED',
    'VOID'
);


ALTER TYPE "public"."invoice_status" OWNER TO "postgres";


CREATE TYPE "public"."invoice_type" AS ENUM (
    'SALE',
    'PURCHASE'
);


ALTER TYPE "public"."invoice_type" OWNER TO "postgres";


CREATE TYPE "public"."journal_status" AS ENUM (
    'draft',
    'posted',
    'reversed'
);


ALTER TYPE "public"."journal_status" OWNER TO "postgres";


CREATE TYPE "public"."journal_type" AS ENUM (
    'accrual',
    'settlement',
    'adjustment',
    'reversal',
    'purchase',
    'expense',
    'payment',
    'funding',
    'sales_receipt',
    'refund',
    'fx_conversion',
    'receipt',
    'refund_settlement'
);


ALTER TYPE "public"."journal_type" OWNER TO "postgres";


CREATE TYPE "public"."reconciliation_status" AS ENUM (
    'matched',
    'unmatched',
    'partial',
    'disputed'
);


ALTER TYPE "public"."reconciliation_status" OWNER TO "postgres";


CREATE TYPE "public"."transaction_direction" AS ENUM (
    'in',
    'out'
);


ALTER TYPE "public"."transaction_direction" OWNER TO "postgres";


CREATE TYPE "public"."txn_direction" AS ENUM (
    'in',
    'out'
);


ALTER TYPE "public"."txn_direction" OWNER TO "postgres";


CREATE TYPE "public"."txn_source" AS ENUM (
    'revolut',
    'paypal',
    'stripe',
    'barclays',
    'hsbc',
    'manual',
    'other'
);


ALTER TYPE "public"."txn_source" OWNER TO "postgres";


CREATE TYPE "public"."txn_status" AS ENUM (
    'pending',
    'journalised',
    'reconciled',
    'excluded',
    'needs_review'
);


ALTER TYPE "public"."txn_status" OWNER TO "postgres";


CREATE TYPE "public"."txn_type" AS ENUM (
    'payment',
    'refund',
    'fee',
    'transfer',
    'fx_conversion',
    'interest',
    'reserve_hold',
    'reserve_release',
    'other'
);


ALTER TYPE "public"."txn_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_accounting_period_open"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  lock_date date;
  subject   date;
begin
  -- Explicit override for deliberate prior-period corrections.
  if coalesce(current_setting('app.allow_locked_period', true), 'off') = 'on' then
    return new;
  end if;

  -- On UPDATE, both the old and new dates matter: moving a journal *out* of a
  -- locked period changes that period's totals just as much as moving one in.
  subject := greatest(
    new.journal_date::date,
    case when tg_op = 'UPDATE' then old.journal_date::date else new.journal_date::date end
  );

  select max(l.locked_through) into lock_date
    from accounting_period_locks l
   where l.entity_id is null or l.entity_id = new.entity_id;

  if lock_date is null then
    return new;
  end if;

  -- Only posted journals move reported figures. Drafts are free to sit anywhere.
  if tg_op = 'UPDATE'
     and new.status = 'posted' and old.status = 'posted'
     and new.journal_date = old.journal_date then
    return new;   -- description/metadata edits are harmless
  end if;

  if (new.status = 'posted' or (tg_op = 'UPDATE' and old.status = 'posted'))
     and least(
           new.journal_date::date,
           case when tg_op = 'UPDATE' then old.journal_date::date
                else new.journal_date::date end
         ) <= lock_date then
    raise exception
      'Accounting period is locked through % — cannot % a posted journal dated %. '
      'These figures have been restated and reported. To make a deliberate '
      'correction: BEGIN; SET LOCAL app.allow_locked_period = ''on''; ... ; COMMIT;',
      lock_date, lower(tg_op), subject
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."assert_accounting_period_open"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backfill_sale_cost_snapshots"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(old.unit_cost, 0) = 0 and coalesce(new.unit_cost, 0) > 0 then
    update public.inventory_movements
    set unit_cost = new.unit_cost
    where inventory_item_id = new.id
      and transaction_type = 'SALE'
      and coalesce(unit_cost, 0) = 0;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."backfill_sale_cost_snapshots"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."backfill_sale_cost_snapshots"() IS 'Fills £0 SALE cost snapshots once an item''s unit_cost becomes known. Only fires on 0 -> positive; never restates history on a real cost change.';



CREATE OR REPLACE FUNCTION "public"."cleanup_api_key_on_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
BEGIN
  IF OLD.api_key_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = OLD.api_key_secret_id;
  END IF;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."cleanup_api_key_on_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_corporation_tax"("p_entity_id" "uuid") RETURNS TABLE("period_id" "uuid", "label" "text", "start_date" "date", "end_date" "date", "status" "text", "ledger_basis" boolean, "payment_due" "date", "filing_due" "date", "accounting_profit" numeric, "add_backs" numeric, "deductions" numeric, "adjusted_profit" numeric, "loss_brought_forward" numeric, "loss_relief_used" numeric, "taxable_profit" numeric, "loss_carried_forward" numeric, "effective_rate" numeric, "marginal_relief" numeric, "tax_due" numeric)
    LANGUAGE "plpgsql" STABLE
    AS $$
declare
  rec          record;
  fy           record;
  v_loss_pool  numeric := 0;
  v_adjusted   numeric;
  v_relief     numeric;
  v_ttp        numeric;
  v_total_days numeric;
  v_slice_days numeric;
  v_slice_ttp  numeric;
  v_slice_tax  numeric;
  v_tax        numeric;
  v_flat       numeric;
begin
  for rec in
    select r.*, p.ledger_basis as v_ledger,
           coalesce((select sum(a.amount) from tax_adjustments a
                      where a.period_id = r.period_id and a.direction = 'add_back'), 0) as v_add,
           coalesce((select sum(a.amount) from tax_adjustments a
                      where a.period_id = r.period_id and a.direction = 'deduction'), 0) as v_ded
      from accounting_period_results r
      join accounting_periods p on p.id = r.period_id
     where r.entity_id = p_entity_id
     order by r.start_date
  loop
    period_id    := rec.period_id;
    label        := rec.label;
    start_date   := rec.start_date;
    end_date     := rec.end_date;
    status       := rec.status;
    ledger_basis := rec.v_ledger;
    payment_due  := rec.payment_due;
    filing_due   := rec.filing_due;

    if not rec.v_ledger then
      accounting_profit := null; add_backs := null; deductions := null;
      adjusted_profit := null; loss_brought_forward := null;
      loss_relief_used := null; taxable_profit := null;
      loss_carried_forward := null; marginal_relief := null;
      effective_rate := null; tax_due := null;
      return next;
      continue;
    end if;

    v_adjusted := rec.accounting_profit + rec.v_add - rec.v_ded;
    v_relief   := case when v_adjusted > 0 then least(v_loss_pool, v_adjusted) else 0 end;
    v_ttp      := greatest(v_adjusted - v_relief, 0);
    v_loss_pool := v_loss_pool - v_relief + greatest(-v_adjusted, 0);

    v_total_days := (rec.end_date - rec.start_date) + 1;
    v_tax := 0;

    -- Apportion taxable profit across every financial year the period touches,
    -- by days, and tax each slice at that year's own rates.
    for fy in
      select cr.financial_year, cr.ends_on,
             greatest(cr.starts_on, rec.start_date) as slice_start,
             least(cr.ends_on, rec.end_date)        as slice_end
        from corporation_tax_rates cr
       where cr.starts_on <= rec.end_date and cr.ends_on >= rec.start_date
       order by cr.financial_year
    loop
      v_slice_days := (fy.slice_end - fy.slice_start) + 1;
      v_slice_ttp  := v_ttp * (v_slice_days / v_total_days);
      v_slice_tax  := ct_tax_for_slice(v_slice_ttp, v_slice_days, fy.ends_on);
      if v_slice_tax is null then
        v_tax := null;   -- an unpublished rate year poisons the whole figure
        exit;
      end if;
      v_tax := v_tax + v_slice_tax;
    end loop;

    -- Marginal relief is reported as the gap between the flat main-rate charge
    -- and the actual charge, so the computation can show it as its own line.
    v_flat := v_ttp * 0.25;
    accounting_profit    := round(rec.accounting_profit, 2);
    add_backs            := round(rec.v_add, 2);
    deductions           := round(rec.v_ded, 2);
    adjusted_profit      := round(v_adjusted, 2);
    loss_brought_forward := round(v_loss_pool + v_relief - greatest(-v_adjusted, 0), 2);
    loss_relief_used     := round(v_relief, 2);
    taxable_profit       := round(v_ttp, 2);
    loss_carried_forward := round(v_loss_pool, 2);
    tax_due              := round(v_tax, 2);
    marginal_relief      := case
                              when v_tax is null or v_ttp = 0 then 0
                              when v_flat - v_tax > 0.005 and v_tax / nullif(v_ttp,0) > 0.19
                                then round(v_flat - v_tax, 2)
                              else 0
                            end;
    effective_rate       := case when v_ttp > 0 and v_tax is not null
                                 then round(v_tax / v_ttp, 4) else 0 end;
    return next;
  end loop;
end;
$$;


ALTER FUNCTION "public"."compute_corporation_tax"("p_entity_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."compute_corporation_tax"("p_entity_id" "uuid") IS 'Corporation tax per accounting period: accounting profit -> adjustments -> loss relief -> taxable total profits -> tax. Profits are apportioned across every UK financial year the period touches and taxed at each year''s own rates, with thresholds pro-rated. Periods flagged ledger_basis = false return NULLs rather than figures derived from unreliable bookkeeping. Assumes one associated company and no franked investment income.';



CREATE OR REPLACE FUNCTION "public"."ct_tax_for_slice"("p_profit" numeric, "p_days" numeric, "p_fy_end" "date") RETURNS numeric
    LANGUAGE "plpgsql" STABLE
    AS $$
declare
  v_small numeric; v_main numeric; v_lower numeric;
  v_upper numeric; v_fraction numeric;
begin
  if p_profit <= 0 or p_days <= 0 then
    return 0;
  end if;

  select small_profits_rate, main_rate, lower_limit, upper_limit, marginal_relief_fraction
    into v_small, v_main, v_lower, v_upper, v_fraction
    from corporation_tax_rates
   where p_fy_end between starts_on and ends_on
   limit 1;

  if v_small is null then
    -- No published rate for this year: refuse to guess.
    return null;
  end if;

  v_lower := v_lower * (p_days / 365.0);
  v_upper := v_upper * (p_days / 365.0);

  if v_upper = 0 or p_profit <= v_lower then
    return p_profit * v_small;
  elsif p_profit > v_upper then
    return p_profit * v_main;
  else
    return (p_profit * v_main) - ((v_upper - p_profit) * coalesce(v_fraction, 0));
  end if;
end;
$$;


ALTER FUNCTION "public"."ct_tax_for_slice"("p_profit" numeric, "p_days" numeric, "p_fy_end" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ct_tax_for_slice"("p_profit" numeric, "p_days" numeric, "p_fy_end" "date") IS 'Corporation tax on one financial-year slice of an accounting period, with thresholds pro-rated to the slice length. Returns NULL when no rate is published for that year.';



CREATE OR REPLACE FUNCTION "public"."delete_api_key_secure"("p_source_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
DECLARE
  v_secret_id UUID;
BEGIN
  -- Get the secret ID
  SELECT api_key_secret_id INTO v_secret_id
  FROM external_sources
  WHERE id = p_source_id;
  
  -- Delete from vault if exists
  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;
  
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."delete_api_key_secure"("p_source_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_api_key_secure"("p_source_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
DECLARE
  v_api_key TEXT;
  v_secret_id UUID;
BEGIN
  -- Get the secret ID from external_sources
  SELECT api_key_secret_id INTO v_secret_id
  FROM external_sources
  WHERE id = p_source_id;
  
  -- If we have a vault secret, decrypt it
  IF v_secret_id IS NOT NULL THEN
    SELECT decrypted_secret INTO v_api_key
    FROM vault.decrypted_secrets
    WHERE id = v_secret_id;
    
    IF v_api_key IS NOT NULL THEN
      RETURN v_api_key;
    END IF;
  END IF;
  
  -- Fall back to legacy credentials column for migration
  SELECT credentials->>'api_key' INTO v_api_key
  FROM external_sources
  WHERE id = p_source_id;
  
  RETURN v_api_key;
END;
$$;


ALTER FUNCTION "public"."get_api_key_secure"("p_source_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_api_key_secure"("p_source_id" "uuid") IS 'Server-side only. Retrieves decrypted API key. Never expose to client.';



CREATE OR REPLACE FUNCTION "public"."get_entity_id_from_source"("p_source_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE
    AS $$
    SELECT entity_id FROM external_sources WHERE id = p_source_id;
$$;


ALTER FUNCTION "public"."get_entity_id_from_source"("p_source_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_legacy_sales_by_product"("excluded_order_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS TABLE("product_id" "uuid", "total_quantity" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT li.product_id, SUM(li.quantity)::bigint AS total_quantity
  FROM order_line_items li
  WHERE li.product_id IS NOT NULL
    AND (
      array_length(excluded_order_ids, 1) IS NULL
      OR li.order_id != ALL(excluded_order_ids)
    )
  GROUP BY li.product_id;
$$;


ALTER FUNCTION "public"."get_legacy_sales_by_product"("excluded_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_sync_stats_by_source"("p_source_id" "uuid") RETURNS TABLE("entity_type" "text", "unique_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT 
    entity_type,
    COUNT(DISTINCT external_id) as unique_count
  FROM external_raw_events
  WHERE source_id = p_source_id
  GROUP BY entity_type
  ORDER BY entity_type;
$$;


ALTER FUNCTION "public"."get_sync_stats_by_source"("p_source_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."post_draft_journal"("p_entity_id" "uuid", "p_journal_id" "uuid", "p_account_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_status journal_status;
  v_entity_id uuid;
  v_misc_account_id uuid;
  v_line_id uuid;
begin
  select status, entity_id into v_status, v_entity_id
  from journals
  where id = p_journal_id;

  if v_entity_id is null then
    raise exception 'Journal not found: %', p_journal_id;
  end if;
  if v_entity_id <> p_entity_id then
    raise exception 'Journal % does not belong to entity %', p_journal_id, p_entity_id;
  end if;
  if v_status <> 'draft' then
    raise exception 'Journal % is not a draft (status=%)', p_journal_id, v_status;
  end if;

  select id into v_misc_account_id
  from chart_of_accounts
  where account_number = '8090'
  limit 1;

  if v_misc_account_id is null then
    raise exception 'Uncategorised fallback account (8090) not found in chart of accounts';
  end if;

  select id into v_line_id
  from journal_line_items
  where journal_id = p_journal_id
    and account_id = v_misc_account_id
  limit 1;

  if v_line_id is null then
    raise exception
      'Journal % has no line posted to the uncategorised fallback account (8090) — nothing to fix',
      p_journal_id;
  end if;

  update journal_line_items
  set account_id = p_account_id
  where id = v_line_id;

  update journals
  set status = 'posted', posted_at = now()
  where id = p_journal_id;

  return p_journal_id;
end;
$$;


ALTER FUNCTION "public"."post_draft_journal"("p_entity_id" "uuid", "p_journal_id" "uuid", "p_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seed_chart_of_accounts"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    INSERT INTO chart_of_accounts
        (account_number, name, account_type, normal_balance, is_header, status)
    VALUES
        ('1000','Cash (Revolut GBP)','asset','debit',FALSE,'active'),
        ('1001','Cash (Revolut EUR)','asset','debit',FALSE,'active'),
        ('1100','Cash (PayPal)','asset','debit',FALSE,'active'),
        ('1200','Payment Gateway Clearing','asset','debit',FALSE,'active'),
        ('1300','Inventory','asset','debit',FALSE,'active'),
        ('1400','Accounts Receivable','asset','debit',FALSE,'active'),
        ('1500','Prepaid Expenses','asset','debit',FALSE,'active'),
        ('2000','Accounts Payable','liability','credit',FALSE,'active'),
        ('2100','VAT / Sales Tax Payable','liability','credit',FALSE,'active'),
        ('2200','Accrued Expenses','liability','credit',FALSE,'active'),
        ('3000','Owner''s Equity','equity','credit',FALSE,'active'),
        ('3100','Retained Earnings','equity','credit',FALSE,'active'),
        ('4000','Product Sales Revenue','revenue','credit',FALSE,'active'),
        ('4100','Shipping Revenue','revenue','credit',FALSE,'active'),
        ('4800','Discounts (Contra)','revenue','debit',FALSE,'active'),
        ('4900','Returns & Refunds (Contra)','revenue','debit',FALSE,'active'),
        ('5000','Product Purchase Cost','cogs','debit',FALSE,'active'),
        ('5100','Materials','cogs','debit',FALSE,'active'),
        ('5200','Inbound Freight & Shipping','cogs','debit',FALSE,'active'),
        ('5300','Customs & Import Duties','cogs','debit',FALSE,'active'),
        ('5400','Packaging','cogs','debit',FALSE,'active'),
        ('6000','Payment Processing Fees','expense','debit',FALSE,'active'),
        ('6100','Marketing & Advertising','expense','debit',FALSE,'active'),
        ('6200','Outbound Shipping & Delivery','expense','debit',FALSE,'active'),
        ('6300','Software & Subscriptions','expense','debit',FALSE,'active'),
        ('6400','Rent & Utilities','expense','debit',FALSE,'active'),
        ('6500','Payroll & Contractors','expense','debit',FALSE,'active'),
        ('6600','Professional Services','expense','debit',FALSE,'active'),
        ('6700','Insurance','expense','debit',FALSE,'active'),
        ('6800','Office Supplies & Admin','expense','debit',FALSE,'active'),
        ('6900','Bank Charges & FX Losses','expense','debit',FALSE,'active'),
        ('6950','Depreciation & Amortization','expense','debit',FALSE,'active'),
        ('6999','Miscellaneous Expense','expense','debit',FALSE,'active')
    ON CONFLICT (account_number) DO UPDATE SET
        name = EXCLUDED.name, account_type = EXCLUDED.account_type, normal_balance = EXCLUDED.normal_balance;
END;
$$;


ALTER FUNCTION "public"."seed_chart_of_accounts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."store_api_key_secure"("p_source_id" "uuid", "p_api_key" "text", "p_provider" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
DECLARE
  v_secret_id UUID;
  v_secret_name TEXT;
  v_old_secret_id UUID;
BEGIN
  -- Generate a unique name for the secret
  v_secret_name := 'api_key_' || p_provider || '_' || p_source_id::text;
  
  -- Get existing secret ID if any
  SELECT api_key_secret_id INTO v_old_secret_id
  FROM external_sources WHERE id = p_source_id;
  
  -- Delete old secret if exists
  IF v_old_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old_secret_id;
  END IF;
  
  -- Also delete by name to avoid conflicts
  DELETE FROM vault.secrets WHERE name = v_secret_name;
  
  -- Create new secret in vault
  SELECT vault.create_secret(
    p_api_key,
    v_secret_name,
    'API key for ' || p_provider || ' integration (source: ' || p_source_id::text || ')'
  ) INTO v_secret_id;
  
  -- Update external_sources with the secret reference
  UPDATE external_sources
  SET 
    api_key_secret_id = v_secret_id,
    api_key_status = 'pending',
    api_key_last_validated_at = NULL,
    api_key_error = NULL,
    credentials = NULL, -- Clear legacy plaintext credentials
    updated_at = NOW()
  WHERE id = p_source_id;
  
  RETURN v_secret_id;
END;
$$;


ALTER FUNCTION "public"."store_api_key_secure"("p_source_id" "uuid", "p_api_key" "text", "p_provider" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."store_api_key_secure"("p_source_id" "uuid", "p_api_key" "text", "p_provider" "text") IS 'Server-side only. Stores API key encrypted in Supabase Vault.';



CREATE OR REPLACE FUNCTION "public"."sync_journal_line_item_effective_date"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.effective_date IS NULL THEN
    NEW.effective_date := COALESCE(
      (SELECT journal_date FROM journals WHERE id = NEW.journal_id),
      now()
    );
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_journal_line_item_effective_date"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tax_deadlines"("p_entity_id" "uuid") RETURNS TABLE("period_id" "uuid", "label" "text", "kind" "text", "due_date" "date", "amount" numeric, "days_remaining" integer, "status" "text")
    LANGUAGE "sql" STABLE
    AS $$
  select
    t.period_id,
    t.label,
    k.kind,
    case k.kind when 'payment' then t.payment_due else t.filing_due end as due_date,
    case when k.kind = 'payment' and t.ledger_basis then t.tax_due else null end as amount,
    (case k.kind when 'payment' then t.payment_due else t.filing_due end - current_date)::integer
      as days_remaining,
    case
      when t.status = 'filed' or (k.kind = 'payment' and t.tax_due = 0) then 'satisfied'
      when (case k.kind when 'payment' then t.payment_due else t.filing_due end - current_date) < 0
        then 'overdue'
      when (case k.kind when 'payment' then t.payment_due else t.filing_due end - current_date) <= 90
        then 'due_soon'
      else 'upcoming'
    end as status
  from compute_corporation_tax(p_entity_id) t
  cross join (values ('payment'), ('filing')) as k(kind)
  where t.status <> 'open'
  order by due_date;
$$;


ALTER FUNCTION "public"."tax_deadlines"("p_entity_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."tg_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_api_key_status"("p_source_id" "uuid", "p_status" "text", "p_error" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE external_sources
  SET 
    api_key_status = p_status,
    api_key_last_validated_at = NOW(),
    api_key_error = p_error,
    updated_at = NOW()
  WHERE id = p_source_id;
END;
$$;


ALTER FUNCTION "public"."update_api_key_status"("p_source_id" "uuid", "p_status" "text", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_external_sources_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_external_sources_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_journal_with_lines"("p_entity_id" "uuid", "p_journal_date" "date", "p_journal_type" "text", "p_description" "text", "p_source_type" "text", "p_source_id" "uuid", "p_status" "text", "p_metadata" "jsonb", "p_line_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_journal_id uuid;
  v_posted_at timestamptz;
begin
  if p_line_items is null or jsonb_array_length(p_line_items) = 0 then
    raise exception 'Cannot create a % journal with no line items (source_type=%, source_id=%)',
      p_journal_type, p_source_type, p_source_id;
  end if;

  v_posted_at := case when p_status = 'posted' then now() else null end;

  insert into journals (
    entity_id, journal_date, journal_type, description,
    source_type, source_id, status, posted_at, metadata
  )
  values (
    p_entity_id, p_journal_date, p_journal_type::journal_type, p_description,
    p_source_type, p_source_id, p_status::journal_status, v_posted_at,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (entity_id, source_type, source_id, journal_type)
  do update set
    journal_date = excluded.journal_date,
    description = excluded.description,
    status = excluded.status,
    posted_at = excluded.posted_at,
    metadata = excluded.metadata
  returning id into v_journal_id;

  delete from journal_line_items where journal_id = v_journal_id;

  insert into journal_line_items (
    journal_id, account_id, debit, credit, currency, description,
    gbp_equivalent, effective_date
  )
  select
    v_journal_id,
    (item->>'account_id')::uuid,
    coalesce((item->>'debit')::numeric, 0),
    coalesce((item->>'credit')::numeric, 0),
    coalesce(item->>'currency', 'GBP'),
    item->>'description',
    nullif(item->>'gbp_equivalent', '')::numeric,
    p_journal_date
  from jsonb_array_elements(p_line_items) as item;

  if p_source_type = 'financial_transaction' and p_source_id is not null then
    update financial_transactions
    set journalised_at = now()
    where id = p_source_id;
  end if;

  return v_journal_id;
end;
$$;


ALTER FUNCTION "public"."upsert_journal_with_lines"("p_entity_id" "uuid", "p_journal_date" "date", "p_journal_type" "text", "p_description" "text", "p_source_type" "text", "p_source_id" "uuid", "p_status" "text", "p_metadata" "jsonb", "p_line_items" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."_backup_charcoal_merge" (
    "item_id" "uuid",
    "product_id" "uuid",
    "provider" "text",
    "variant_external_id" "text",
    "unit_cost" numeric(18,4),
    "available_quantity" integer,
    "movement_id" "uuid",
    "transaction_type" "text",
    "quantity" numeric,
    "mv_unit_cost" numeric,
    "notes" "text",
    "backed_up_at" timestamp with time zone
);


ALTER TABLE "public"."_backup_charcoal_merge" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_backup_charcoal_order_merge" (
    "id" "uuid",
    "product_id" "uuid",
    "variant_external_id" "text",
    "backed_up_at" timestamp with time zone
);


ALTER TABLE "public"."_backup_charcoal_order_merge" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_backup_phase1_items" (
    "id" "uuid",
    "sku" "text",
    "unit_cost" numeric(18,4),
    "backed_up_at" timestamp with time zone
);


ALTER TABLE "public"."_backup_phase1_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_backup_phase1_movements" (
    "id" "uuid",
    "inventory_item_id" "uuid",
    "transaction_type" "text",
    "quantity" numeric,
    "unit_cost" numeric,
    "backed_up_at" timestamp with time zone
);


ALTER TABLE "public"."_backup_phase1_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_backup_phase2_count" (
    "inventory_item_id" "uuid",
    "sku" "text",
    "on_hand_before" numeric,
    "unit_cost" numeric(18,4),
    "backed_up_at" timestamp with time zone
);


ALTER TABLE "public"."_backup_phase2_count" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."_backup_sale_movement_dates" (
    "id" "uuid",
    "old_created_at" timestamp with time zone,
    "backed_up_at" timestamp with time zone
);


ALTER TABLE "public"."_backup_sale_movement_dates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chart_of_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "account_type" "public"."account_type" NOT NULL,
    "parent_account_id" "uuid",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "account_number" character varying(20) NOT NULL,
    "normal_balance" character(6),
    "is_header" boolean DEFAULT false NOT NULL,
    "department" character varying(50),
    "tax_code" character varying(20),
    "status" "public"."account_status" DEFAULT 'active'::"public"."account_status" NOT NULL,
    CONSTRAINT "chk_normal_balance" CHECK (("normal_balance" = ANY (ARRAY['debit'::"bpchar", 'credit'::"bpchar"])))
);


ALTER TABLE "public"."chart_of_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."journal_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journal_id" "uuid" NOT NULL,
    "account_id" "uuid" NOT NULL,
    "debit" numeric(18,4) DEFAULT 0 NOT NULL,
    "credit" numeric(18,4) DEFAULT 0 NOT NULL,
    "currency" "text" NOT NULL,
    "description" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "effective_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "gbp_equivalent" numeric(20,4) DEFAULT NULL::numeric,
    CONSTRAINT "chk_debit_or_credit" CHECK (((("debit" > (0)::numeric) AND ("credit" = (0)::numeric)) OR (("credit" > (0)::numeric) AND ("debit" = (0)::numeric))))
);


ALTER TABLE "public"."journal_line_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."journal_line_items"."debit" IS 'Debit amount; 0 (never NULL) when the line is a credit. NOT NULL so that sum(debit - credit) is safe.';



COMMENT ON COLUMN "public"."journal_line_items"."credit" IS 'Credit amount; 0 (never NULL) when the line is a debit. NOT NULL so that sum(debit - credit) is safe.';



CREATE TABLE IF NOT EXISTS "public"."journals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "journal_date" timestamp with time zone NOT NULL,
    "journal_type" "public"."journal_type" NOT NULL,
    "description" "text",
    "source_type" "text",
    "source_id" "uuid",
    "status" "public"."journal_status" DEFAULT 'draft'::"public"."journal_status" NOT NULL,
    "posted_at" timestamp with time zone,
    "reversed_by_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."journals" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."clearing_account_breakdown" AS
 SELECT "j"."journal_type",
    "count"(*) AS "journal_count",
    "round"("sum"("li"."debit"), 2) AS "total_debit",
    "round"("sum"("li"."credit"), 2) AS "total_credit",
    "round"("sum"(("li"."debit" - "li"."credit")), 2) AS "net_contribution"
   FROM (("public"."journal_line_items" "li"
     JOIN "public"."journals" "j" ON (("j"."id" = "li"."journal_id")))
     JOIN "public"."chart_of_accounts" "a" ON (("a"."id" = "li"."account_id")))
  WHERE ((("a"."account_number")::"text" = '1012'::"text") AND ("j"."status" = 'posted'::"public"."journal_status"))
  GROUP BY "j"."journal_type"
  ORDER BY ("round"("sum"(("li"."debit" - "li"."credit")), 2)) DESC;


ALTER VIEW "public"."clearing_account_breakdown" OWNER TO "postgres";


COMMENT ON VIEW "public"."clearing_account_breakdown" IS 'Merchant Clearing (1012) balance broken down by contributing journal_type. Sum of net_contribution across all rows is the account''s current posted balance.';



CREATE TABLE IF NOT EXISTS "public"."inventory_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "provider" "text" NOT NULL,
    "raw_event_id" "uuid",
    "variant_external_id" "text" NOT NULL,
    "sku" "text",
    "is_unlimited" boolean DEFAULT false,
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "description" "text",
    "category" "text",
    "unit_cost" numeric(18,4) DEFAULT 0,
    "asset_account_id" "uuid",
    "cogs_account_id" "uuid",
    "available_quantity" integer DEFAULT 0 NOT NULL,
    "shopify_inventory_item_id" "text",
    "item_type" "text" DEFAULT 'sellable'::"text" NOT NULL,
    "quantity_source" "text" DEFAULT 'ledger'::"text" NOT NULL,
    CONSTRAINT "inventory_items_item_type_check" CHECK (("item_type" = ANY (ARRAY['sellable'::"text", 'sample'::"text", 'material'::"text"]))),
    CONSTRAINT "inventory_items_quantity_source_check" CHECK (("quantity_source" = ANY (ARRAY['shopify'::"text", 'ledger'::"text"]))),
    CONSTRAINT "inventory_items_shopify_quantity_source_check" CHECK ((("provider" <> 'shopify'::"text") OR ("quantity_source" = 'shopify'::"text")))
);


ALTER TABLE "public"."inventory_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."inventory_items"."provider" IS 'Data lineage only (where the row originated). Do NOT branch behaviour on this — use quantity_source or item_type.';



COMMENT ON COLUMN "public"."inventory_items"."created_at" IS 'Timestamp from the source system raw payload';



COMMENT ON COLUMN "public"."inventory_items"."item_type" IS 'sellable | sample | material. Samples/materials legitimately have product_id IS NULL — that is a valid state, not a data-quality error.';



COMMENT ON COLUMN "public"."inventory_items"."quantity_source" IS 'shopify = available_quantity is authoritative (kept current by sync); ledger = on-hand derived from inventory_movements. Read via the inventory_on_hand view, never re-implement.';



CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "transaction_type" "text" NOT NULL,
    "reference_id" "uuid",
    "reference_table" "text",
    "quantity" numeric NOT NULL,
    "unit_cost" numeric DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "movement_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "movement_date_source" "text" DEFAULT 'estimated'::"text" NOT NULL,
    "superseded_at" timestamp with time zone,
    "superseded_reason" "text",
    CONSTRAINT "inventory_movements_movement_date_source_check" CHECK (("movement_date_source" = ANY (ARRAY['order'::"text", 'invoice'::"text", 'backdated'::"text", 'estimated'::"text"])))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


COMMENT ON COLUMN "public"."inventory_movements"."movement_date" IS 'Economic date of the movement, NOT the row-insert date. Use this for all period/GL reporting; created_at is the load timestamp and is misleading for bulk-loaded history.';



COMMENT ON COLUMN "public"."inventory_movements"."movement_date_source" IS 'How movement_date was derived: order/invoice = sourced from the underlying document (reliable); backdated = deliberately set at load; estimated = defaulted or fell back to insert time and may not be the true economic date. Audit ''estimated'' rows before relying on them for period reporting.';



COMMENT ON COLUMN "public"."inventory_movements"."superseded_at" IS 'When set, this movement is void and MUST be excluded from stock and cost calculations. Used instead of deletion so the subledger stays auditable.';



CREATE TABLE IF NOT EXISTS "public"."order_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "raw_event_id" "uuid",
    "external_id" "text" NOT NULL,
    "product_id" "uuid",
    "product_external_id" "text",
    "variant_external_id" "text",
    "sku" "text",
    "product_name" "text" NOT NULL,
    "variant_name" "text",
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price_amount" numeric(15,2) NOT NULL,
    "total_price_amount" numeric(15,2) NOT NULL,
    "discount_amount" numeric(15,2),
    "tax_amount" numeric(15,2),
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "cost_of_goods" numeric,
    CONSTRAINT "order_line_items_quantity_check" CHECK (("quantity" >= 0))
);


ALTER TABLE "public"."order_line_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."order_line_items"."created_at" IS 'Inherited from parent order created_at';



COMMENT ON COLUMN "public"."order_line_items"."metadata" IS 'Provider-specific fields (e.g., image_url, weight, customizations)';



CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "provider" "text" NOT NULL,
    "external_id" "text" NOT NULL,
    "raw_event_id" "uuid",
    "order_number" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "fulfillment_status" "text" DEFAULT 'unfulfilled'::"text" NOT NULL,
    "customer_external_id" "text",
    "customer_email" "text",
    "subtotal_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "discount_total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "shipping_total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "tax_total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "grand_total_amount" numeric(15,2) DEFAULT 0 NOT NULL,
    "refunded_total_amount" numeric(15,2) DEFAULT 0,
    "shipping_address" "jsonb",
    "billing_address" "jsonb",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "currency" "text" DEFAULT 'GBP'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "orders_fulfillment_status_check" CHECK (("fulfillment_status" = ANY (ARRAY['unfulfilled'::"text", 'partial'::"text", 'fulfilled'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'processing'::"text", 'shipped'::"text", 'delivered'::"text", 'cancelled'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."orders"."created_at" IS 'When the order was placed in the source system';



COMMENT ON COLUMN "public"."orders"."updated_at" IS 'When the order was last modified in the source system';



COMMENT ON COLUMN "public"."orders"."currency" IS 'ISO 4217 currency code for all monetary amounts on this order';



COMMENT ON COLUMN "public"."orders"."metadata" IS 'Provider-specific fields (e.g., channel, fulfillments[], notes, is_test)';



CREATE OR REPLACE VIEW "public"."inventory_on_hand" AS
 WITH "mv" AS (
         SELECT "inventory_movements"."inventory_item_id",
            "sum"("inventory_movements"."quantity") AS "net_all",
            COALESCE("sum"("inventory_movements"."quantity") FILTER (WHERE ("inventory_movements"."transaction_type" = 'PURCHASE'::"text")), (0)::numeric) AS "purchased",
            COALESCE("sum"("abs"("inventory_movements"."quantity")) FILTER (WHERE ("inventory_movements"."transaction_type" = 'SALE'::"text")), (0)::numeric) AS "sold_from_movements",
            COALESCE("sum"("abs"("inventory_movements"."quantity")) FILTER (WHERE ("inventory_movements"."transaction_type" = 'GIFT'::"text")), (0)::numeric) AS "gifted",
            COALESCE("sum"("abs"("inventory_movements"."quantity")) FILTER (WHERE ("inventory_movements"."transaction_type" = 'WRITE_OFF'::"text")), (0)::numeric) AS "written_off",
            COALESCE("sum"("inventory_movements"."quantity") FILTER (WHERE ("inventory_movements"."transaction_type" = 'ADJUSTMENT'::"text")), (0)::numeric) AS "adjusted",
            "count"(*) FILTER (WHERE ("inventory_movements"."transaction_type" = 'SALE'::"text")) AS "sale_movement_count"
           FROM "public"."inventory_movements"
          WHERE ("inventory_movements"."superseded_at" IS NULL)
          GROUP BY "inventory_movements"."inventory_item_id"
        ), "legacy_sales" AS (
         SELECT "oli"."product_id",
            "sum"("oli"."quantity") AS "qty"
           FROM ("public"."order_line_items" "oli"
             JOIN "public"."orders" "o" ON (("o"."id" = "oli"."order_id")))
          WHERE (("oli"."product_id" IS NOT NULL) AND ("o"."status" IS DISTINCT FROM 'refunded'::"text"))
          GROUP BY "oli"."product_id"
        ), "refunds" AS (
         SELECT "oli"."product_id",
            "sum"("oli"."quantity") AS "qty"
           FROM ("public"."order_line_items" "oli"
             JOIN "public"."orders" "o" ON (("o"."id" = "oli"."order_id")))
          WHERE (("oli"."product_id" IS NOT NULL) AND ("o"."status" = 'refunded'::"text"))
          GROUP BY "oli"."product_id"
        )
 SELECT "ii"."id" AS "inventory_item_id",
    "ii"."entity_id",
    "ii"."product_id",
    "ii"."sku",
    "ii"."item_type",
    "ii"."quantity_source",
    "ii"."provider",
    "ii"."unit_cost",
    "ii"."is_unlimited",
    COALESCE("mv"."purchased", (0)::numeric) AS "units_purchased",
        CASE
            WHEN (COALESCE("mv"."sale_movement_count", (0)::bigint) > 0) THEN "mv"."sold_from_movements"
            ELSE (COALESCE("ls"."qty", (0)::bigint))::numeric
        END AS "units_sold",
    COALESCE("rf"."qty", (0)::bigint) AS "units_refunded",
    COALESCE("mv"."gifted", (0)::numeric) AS "units_gifted",
        CASE
            WHEN ("ii"."quantity_source" = 'shopify'::"text") THEN (COALESCE("ii"."available_quantity", 0))::numeric
            WHEN ((COALESCE("mv"."sale_movement_count", (0)::bigint) = 0) AND ("ls"."qty" IS NOT NULL)) THEN ((((COALESCE("mv"."purchased", (0)::numeric) - (COALESCE("ls"."qty", (0)::bigint))::numeric) - COALESCE("mv"."gifted", (0)::numeric)) - COALESCE("mv"."written_off", (0)::numeric)) + COALESCE("mv"."adjusted", (0)::numeric))
            ELSE COALESCE("mv"."net_all", (0)::numeric)
        END AS "on_hand",
    COALESCE("mv"."written_off", (0)::numeric) AS "units_written_off"
   FROM ((("public"."inventory_items" "ii"
     LEFT JOIN "mv" ON (("mv"."inventory_item_id" = "ii"."id")))
     LEFT JOIN "legacy_sales" "ls" ON (("ls"."product_id" = "ii"."product_id")))
     LEFT JOIN "refunds" "rf" ON (("rf"."product_id" = "ii"."product_id")));


ALTER VIEW "public"."inventory_on_hand" OWNER TO "postgres";


COMMENT ON VIEW "public"."inventory_on_hand" IS 'Canonical on-hand stock. Read this instead of re-deriving from available_quantity or inventory_movements.';



CREATE OR REPLACE VIEW "public"."inventory_gl_reconciliation" AS
 WITH "gl" AS (
         SELECT "round"(COALESCE("sum"((COALESCE("jli"."debit", (0)::numeric) - COALESCE("jli"."credit", (0)::numeric))), (0)::numeric), 2) AS "gl_balance"
           FROM (("public"."journal_line_items" "jli"
             JOIN "public"."journals" "j" ON (("j"."id" = "jli"."journal_id")))
             JOIN "public"."chart_of_accounts" "coa" ON (("coa"."id" = "jli"."account_id")))
          WHERE ((("coa"."account_number")::"text" = ANY ((ARRAY['1031'::character varying, '1032'::character varying, '1033'::character varying, '1034'::character varying, '1035'::character varying])::"text"[])) AND ("j"."status" = 'posted'::"public"."journal_status"))
        ), "sub" AS (
         SELECT "round"(COALESCE("sum"((GREATEST("inventory_on_hand"."on_hand", (0)::numeric) * "inventory_on_hand"."unit_cost")), (0)::numeric), 2) AS "subledger_value",
            COALESCE("sum"(GREATEST("inventory_on_hand"."on_hand", (0)::numeric)), (0)::numeric) AS "units_on_hand",
            "count"(*) FILTER (WHERE ("inventory_on_hand"."item_type" = 'sellable'::"text")) AS "sellable_items",
            "count"(*) FILTER (WHERE ("inventory_on_hand"."item_type" = 'sample'::"text")) AS "sample_items"
           FROM "public"."inventory_on_hand"
        )
 SELECT "gl"."gl_balance",
    "sub"."subledger_value",
    "round"(("gl"."gl_balance" - "sub"."subledger_value"), 2) AS "variance",
    ("abs"(("gl"."gl_balance" - "sub"."subledger_value")) < 0.01) AS "reconciled",
    "sub"."units_on_hand",
    "sub"."sellable_items",
    "sub"."sample_items",
    "now"() AS "computed_at"
   FROM "gl",
    "sub";


ALTER VIEW "public"."inventory_gl_reconciliation" OWNER TO "postgres";


COMMENT ON VIEW "public"."inventory_gl_reconciliation" IS 'Inventory subledger vs GL control accounts (1031-1035). GL side is posted-only by definition — reversed journals are soft voids and must never be counted. Debit/credit are coalesced because some line items store NULL rather than 0. reconciled = true means the balance sheet stock figure ties to inventory_on_hand.';



CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "external_id" "text" NOT NULL,
    "raw_event_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "product_type" "text",
    "variants" "jsonb" DEFAULT '[]'::"jsonb",
    "tags" "text"[] DEFAULT ARRAY[]::"text"[],
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."products" OWNER TO "postgres";


COMMENT ON COLUMN "public"."products"."created_at" IS 'When the product was created in the source system';



COMMENT ON COLUMN "public"."products"."updated_at" IS 'When the product was last modified in the source system';



COMMENT ON COLUMN "public"."products"."status" IS 'Product lifecycle status: active, archived, draft';



COMMENT ON COLUMN "public"."products"."metadata" IS 'Provider-specific fields (e.g., url, images[], seo, visibility)';



CREATE OR REPLACE VIEW "public"."inventory_negative_stock" AS
 SELECT "ioh"."inventory_item_id",
    "ioh"."sku",
    "ioh"."product_id",
    "p"."name" AS "product_name",
    "p"."status" AS "product_status",
    "ioh"."item_type",
    "ioh"."quantity_source",
    "ioh"."on_hand",
    "ioh"."unit_cost",
    "round"(("ioh"."on_hand" * COALESCE("ioh"."unit_cost", (0)::numeric)), 2) AS "negative_value",
    "ioh"."units_purchased",
    "ioh"."units_sold",
        CASE
            WHEN ("ioh"."units_purchased" = (0)::numeric) THEN 'sales recorded but stock never received'::"text"
            WHEN ("ioh"."quantity_source" = 'shopify'::"text") THEN 'Shopify reports oversold'::"text"
            ELSE 'movements net negative'::"text"
        END AS "reason"
   FROM ("public"."inventory_on_hand" "ioh"
     LEFT JOIN "public"."products" "p" ON (("p"."id" = "ioh"."product_id")))
  WHERE ("ioh"."on_hand" < (0)::numeric);


ALTER VIEW "public"."inventory_negative_stock" OWNER TO "postgres";


COMMENT ON VIEW "public"."inventory_negative_stock" IS 'Items showing impossible negative stock. inventory_gl_reconciliation floors these at zero, so they do not distort the GL tie — but each one hides a real gap in the movement history.';



CREATE OR REPLACE VIEW "public"."inventory_uncosted_sales" AS
 SELECT "o"."id" AS "order_id",
    "o"."order_number",
    "o"."created_at" AS "order_date",
    "o"."status" AS "order_status",
    "oli"."id" AS "line_item_id",
    "oli"."product_id",
    "oli"."sku",
    "oli"."product_name",
    "oli"."quantity",
    "oli"."total_price_amount" AS "revenue",
        CASE
            WHEN ("oli"."product_id" IS NULL) THEN 'line not linked to a product'::"text"
            WHEN (NOT (EXISTS ( SELECT 1
               FROM "public"."inventory_items" "i"
              WHERE (("i"."product_id" = "oli"."product_id") AND (COALESCE("i"."unit_cost", (0)::numeric) > (0)::numeric))))) THEN 'product has no costed inventory item'::"text"
            ELSE 'no SALE movement recorded'::"text"
        END AS "reason"
   FROM ("public"."orders" "o"
     JOIN "public"."order_line_items" "oli" ON (("oli"."order_id" = "o"."id")))
  WHERE (("o"."status" IS DISTINCT FROM 'cancelled'::"text") AND (NOT (EXISTS ( SELECT 1
           FROM "public"."inventory_movements" "m"
          WHERE (("m"."reference_id" = "oli"."id") AND ("m"."transaction_type" = 'SALE'::"text") AND ("m"."superseded_at" IS NULL))))));


ALTER VIEW "public"."inventory_uncosted_sales" OWNER TO "postgres";


COMMENT ON VIEW "public"."inventory_uncosted_sales" IS 'Order lines that sold stock but have no costed SALE movement, so no COGS can be recognised. Grouped by reason so the fixable ones (missing movement) are separable from the structural ones (unlinked product).';



CREATE OR REPLACE VIEW "public"."accounting_health_checks" AS
 WITH "recon" AS (
         SELECT "inventory_gl_reconciliation"."gl_balance",
            "inventory_gl_reconciliation"."subledger_value",
            "inventory_gl_reconciliation"."variance",
            "inventory_gl_reconciliation"."reconciled"
           FROM "public"."inventory_gl_reconciliation"
        ), "unbalanced" AS (
         SELECT "count"(*) AS "n"
           FROM ( SELECT "j"."id"
                   FROM ("public"."journals" "j"
                     JOIN "public"."journal_line_items" "li" ON (("li"."journal_id" = "j"."id")))
                  WHERE ("j"."status" = 'posted'::"public"."journal_status")
                  GROUP BY "j"."id"
                 HAVING ("abs"(("sum"("li"."debit") - "sum"("li"."credit"))) > 0.01)) "x"
        ), "uncosted_live" AS (
         SELECT "count"(*) AS "n",
            COALESCE("round"("sum"("inventory_uncosted_sales"."revenue"), 2), (0)::numeric) AS "revenue"
           FROM "public"."inventory_uncosted_sales"
          WHERE ("inventory_uncosted_sales"."order_date" >= '2026-07-31 00:00:00+00'::timestamp with time zone)
        ), "uncosted_2026" AS (
         SELECT "count"(*) AS "n",
            COALESCE("round"("sum"("inventory_uncosted_sales"."revenue"), 2), (0)::numeric) AS "revenue"
           FROM "public"."inventory_uncosted_sales"
          WHERE (("inventory_uncosted_sales"."order_date" >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND ("inventory_uncosted_sales"."order_date" < '2026-07-31 00:00:00+00'::timestamp with time zone))
        ), "uncosted_legacy" AS (
         SELECT "count"(*) AS "n",
            COALESCE("round"("sum"("inventory_uncosted_sales"."revenue"), 2), (0)::numeric) AS "revenue"
           FROM "public"."inventory_uncosted_sales"
          WHERE ("inventory_uncosted_sales"."order_date" < '2026-01-01 00:00:00+00'::timestamp with time zone)
        ), "negative" AS (
         SELECT "count"(*) AS "n",
            COALESCE("round"("sum"("inventory_negative_stock"."negative_value"), 2), (0)::numeric) AS "value"
           FROM "public"."inventory_negative_stock"
        ), "untranslated" AS (
         SELECT "count"(*) AS "n"
           FROM ("public"."journal_line_items" "li"
             JOIN "public"."journals" "j" ON (("j"."id" = "li"."journal_id")))
          WHERE (("j"."status" = 'posted'::"public"."journal_status") AND ("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NULL))
        ), "estimated_dates" AS (
         SELECT "count"(*) AS "n"
           FROM "public"."inventory_movements"
          WHERE (("inventory_movements"."superseded_at" IS NULL) AND ("inventory_movements"."movement_date_source" = 'estimated'::"text") AND ("inventory_movements"."movement_date" >= '2026-07-31 00:00:00+00'::timestamp with time zone))
        ), "clearing" AS (
         SELECT COALESCE("sum"("clearing_account_breakdown"."net_contribution"), (0)::numeric) AS "balance"
           FROM "public"."clearing_account_breakdown"
        )
 SELECT 'inventory_gl_reconciled'::"text" AS "check_name",
        CASE
            WHEN ( SELECT "recon"."reconciled"
               FROM "recon") THEN 'ok'::"text"
            ELSE 'fail'::"text"
        END AS "severity",
    0 AS "item_count",
    ( SELECT "recon"."variance"
           FROM "recon") AS "amount",
    ((('GL inventory '::"text" || ( SELECT "recon"."gl_balance"
           FROM "recon")) || ' vs subledger '::"text") || ( SELECT "recon"."subledger_value"
           FROM "recon")) AS "detail"
UNION ALL
 SELECT 'journals_balanced'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "unbalanced"."n"
               FROM "unbalanced") = 0) THEN 'ok'::"text"
            ELSE 'fail'::"text"
        END AS "severity",
    (( SELECT "unbalanced"."n"
           FROM "unbalanced"))::integer AS "item_count",
    0 AS "amount",
    'Posted journals where debits <> credits beyond 1p tolerance'::"text" AS "detail"
UNION ALL
 SELECT 'sales_costed_current_period'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "uncosted_live"."n"
               FROM "uncosted_live") = 0) THEN 'ok'::"text"
            ELSE 'fail'::"text"
        END AS "severity",
    (( SELECT "uncosted_live"."n"
           FROM "uncosted_live"))::integer AS "item_count",
    ( SELECT "uncosted_live"."revenue"
           FROM "uncosted_live") AS "amount",
    'Sales since the 30 Jul 2026 stock count with no cost — these book revenue at 100% margin and produce no COGS journal'::"text" AS "detail"
UNION ALL
 SELECT 'sales_costed_restated_period'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "uncosted_2026"."n"
               FROM "uncosted_2026") = 0) THEN 'ok'::"text"
            ELSE 'warn'::"text"
        END AS "severity",
    (( SELECT "uncosted_2026"."n"
           FROM "uncosted_2026"))::integer AS "item_count",
    ( SELECT "uncosted_2026"."revenue"
           FROM "uncosted_2026") AS "amount",
    'Uncosted sales inside the restated 2026 period — known and accepted; lines not linked to any product'::"text" AS "detail"
UNION ALL
 SELECT 'sales_costed_legacy'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "uncosted_legacy"."n"
               FROM "uncosted_legacy") = 0) THEN 'ok'::"text"
            ELSE 'warn'::"text"
        END AS "severity",
    (( SELECT "uncosted_legacy"."n"
           FROM "uncosted_legacy"))::integer AS "item_count",
    ( SELECT "uncosted_legacy"."revenue"
           FROM "uncosted_legacy") AS "amount",
    'Uncosted sales before 2026 — pre-dates cost tracking, not restated by design'::"text" AS "detail"
UNION ALL
 SELECT 'no_negative_stock'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "negative"."n"
               FROM "negative") = 0) THEN 'ok'::"text"
            ELSE 'warn'::"text"
        END AS "severity",
    (( SELECT "negative"."n"
           FROM "negative"))::integer AS "item_count",
    ( SELECT "negative"."value"
           FROM "negative") AS "amount",
    'Items with impossible negative stock. Floored to zero in the GL tie, so they hide rather than surface'::"text" AS "detail"
UNION ALL
 SELECT 'foreign_currency_translated'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "untranslated"."n"
               FROM "untranslated") = 0) THEN 'ok'::"text"
            ELSE 'fail'::"text"
        END AS "severity",
    (( SELECT "untranslated"."n"
           FROM "untranslated"))::integer AS "item_count",
    0 AS "amount",
    'Non-GBP journal lines with no gbp_equivalent — these are silently dropped from the P&L and balance sheet'::"text" AS "detail"
UNION ALL
 SELECT 'movement_dates_sourced'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "estimated_dates"."n"
               FROM "estimated_dates") = 0) THEN 'ok'::"text"
            ELSE 'warn'::"text"
        END AS "severity",
    (( SELECT "estimated_dates"."n"
           FROM "estimated_dates"))::integer AS "item_count",
    0 AS "amount",
    'Movements since the stock count whose date was defaulted rather than sourced from an order or invoice'::"text" AS "detail"
UNION ALL
 SELECT 'merchant_clearing_reasonable'::"text" AS "check_name",
        CASE
            WHEN (( SELECT "clearing"."balance"
               FROM "clearing") < (0)::numeric) THEN 'fail'::"text"
            ELSE 'ok'::"text"
        END AS "severity",
    0 AS "item_count",
    ( SELECT "clearing"."balance"
           FROM "clearing") AS "amount",
    'Merchant Clearing (1012) posted balance — should be a small, transient, non-negative figure representing payouts not yet received. Negative means a refund or settlement posted against an account it should not have (see clearing_account_breakdown for which journal_type is driving it, and /accounting/health-checks?include_detail=true for the individual contributing entries).'::"text" AS "detail";


ALTER VIEW "public"."accounting_health_checks" OWNER TO "postgres";


COMMENT ON VIEW "public"."accounting_health_checks" IS 'Assertions about ledger and inventory integrity, one row per check. Any row with severity=''fail'' means the books are wrong or an automated process has stopped working; ''warn'' rows are known gaps. Query this rather than remembering which individual view to look at.';



CREATE TABLE IF NOT EXISTS "public"."accounting_period_locks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "locked_through" "date" NOT NULL,
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."accounting_period_locks" OWNER TO "postgres";


COMMENT ON TABLE "public"."accounting_period_locks" IS 'Journals dated on or before locked_through cannot be created, re-dated, or have their status changed. A NULL entity_id locks every entity.';



CREATE TABLE IF NOT EXISTS "public"."accounting_periods" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "label" "text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "filed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ledger_basis" boolean DEFAULT true NOT NULL,
    "filed_net_assets" numeric,
    "notes" "text",
    CONSTRAINT "accounting_periods_dates_check" CHECK (("end_date" > "start_date")),
    CONSTRAINT "accounting_periods_max_12_months" CHECK (("end_date" <= ("start_date" + '1 year'::interval))),
    CONSTRAINT "accounting_periods_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text", 'filed'::"text"])))
);


ALTER TABLE "public"."accounting_periods" OWNER TO "postgres";


COMMENT ON TABLE "public"."accounting_periods" IS 'Corporation tax accounting periods. CT payment is due 9 months + 1 day after end_date; the CT600 return is due 12 months after end_date.';



COMMENT ON COLUMN "public"."accounting_periods"."ledger_basis" IS 'When false, this period predates reliable bookkeeping in this system: its figures come from filed accounts or the accountant''s records, and no tax is computed from the ledger.';



CREATE OR REPLACE VIEW "public"."accounting_period_results" AS
 WITH "lines" AS (
         SELECT "p_1"."id" AS "period_id",
            "p_1"."entity_id",
            "a"."account_type",
                CASE
                    WHEN (("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NOT NULL)) THEN
                    CASE
                        WHEN ("li"."debit" > (0)::numeric) THEN "li"."gbp_equivalent"
                        ELSE (0)::numeric
                    END
                    ELSE "li"."debit"
                END AS "dr",
                CASE
                    WHEN (("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NOT NULL)) THEN
                    CASE
                        WHEN ("li"."debit" > (0)::numeric) THEN (0)::numeric
                        ELSE "li"."gbp_equivalent"
                    END
                    ELSE "li"."credit"
                END AS "cr"
           FROM ((("public"."accounting_periods" "p_1"
             JOIN "public"."journals" "j" ON ((("j"."entity_id" = "p_1"."entity_id") AND ("j"."status" = 'posted'::"public"."journal_status") AND ("j"."journal_date" >= "p_1"."start_date") AND ("j"."journal_date" < ("p_1"."end_date" + 1)))))
             JOIN "public"."journal_line_items" "li" ON (("li"."journal_id" = "j"."id")))
             JOIN "public"."chart_of_accounts" "a" ON (("a"."id" = "li"."account_id")))
          WHERE (("a"."status" = 'active'::"public"."account_status") AND ("a"."is_header" = false) AND ("a"."account_type" = ANY (ARRAY['revenue'::"public"."account_type", 'cogs'::"public"."account_type", 'expense'::"public"."account_type"])) AND (NOT (("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NULL))))
        )
 SELECT "p"."id" AS "period_id",
    "p"."entity_id",
    "p"."label",
    "p"."start_date",
    "p"."end_date",
    "p"."status",
    ((("p"."end_date" + '9 mons'::interval) + '1 day'::interval))::"date" AS "payment_due",
    (("p"."end_date" + '1 year'::interval))::"date" AS "filing_due",
    "round"(COALESCE("sum"(
        CASE
            WHEN ("l"."account_type" = 'revenue'::"public"."account_type") THEN ("l"."cr" - "l"."dr")
            ELSE (0)::numeric
        END), (0)::numeric), 2) AS "revenue",
    "round"(COALESCE("sum"(
        CASE
            WHEN ("l"."account_type" = 'cogs'::"public"."account_type") THEN ("l"."dr" - "l"."cr")
            ELSE (0)::numeric
        END), (0)::numeric), 2) AS "cogs",
    "round"(COALESCE("sum"(
        CASE
            WHEN ("l"."account_type" = 'expense'::"public"."account_type") THEN ("l"."dr" - "l"."cr")
            ELSE (0)::numeric
        END), (0)::numeric), 2) AS "expenses",
    "round"(COALESCE("sum"(
        CASE
            WHEN ("l"."account_type" = 'revenue'::"public"."account_type") THEN ("l"."cr" - "l"."dr")
            ELSE (- ("l"."dr" - "l"."cr"))
        END), (0)::numeric), 2) AS "accounting_profit"
   FROM ("public"."accounting_periods" "p"
     LEFT JOIN "lines" "l" ON (("l"."period_id" = "p"."id")))
  GROUP BY "p"."id", "p"."entity_id", "p"."label", "p"."start_date", "p"."end_date", "p"."status";


ALTER VIEW "public"."accounting_period_results" OWNER TO "postgres";


COMMENT ON VIEW "public"."accounting_period_results" IS 'Profit and loss per corporation tax accounting period, on the same basis as the P&L report. accounting_profit is the STARTING POINT for tax, not the taxable figure -- see tax_computation.';



CREATE TABLE IF NOT EXISTS "public"."bank_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "external_account_id" "text" NOT NULL,
    "name" "text",
    "currency" "text" NOT NULL,
    "balance" numeric(18,4) DEFAULT 0,
    "state" "text",
    "public" boolean DEFAULT false,
    "raw_event_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bank_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_event_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "source_key" "text" NOT NULL,
    "external_event_uid" "text",
    "calendar_uid" "text",
    "last_pushed_hash" "text",
    "last_pushed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."calendar_event_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "external_id" "text" NOT NULL,
    "calendar_uid" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "location" "text",
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone,
    "all_day" boolean DEFAULT false NOT NULL,
    "organizer" "text",
    "attendees" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "raw_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."collection_costs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "collection_id" "uuid" NOT NULL,
    "financial_transaction_id" "uuid" NOT NULL,
    "cost_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."collection_costs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."collection_plan_costs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "cost_category" "text" NOT NULL,
    "description" "text",
    "planned_amount" numeric,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_estimated" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."collection_plan_costs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."collection_plan_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "product_name" "text",
    "planned_quantity" numeric NOT NULL,
    "unit_cost" numeric NOT NULL,
    "unit_selling_price" numeric NOT NULL,
    "expected_sell_through_pct" numeric DEFAULT 100 NOT NULL,
    "notes" "text",
    "display_order" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unit_cost_currency" "text",
    "unit_cost_original" numeric,
    "gifted_units" numeric DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."collection_plan_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."collection_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "collection_id" "uuid" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "collaboration_type" "text" DEFAULT 'in_house'::"text" NOT NULL,
    "partner_name" "text",
    "currency" "text" DEFAULT 'GBP'::"text" NOT NULL,
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "partner_currency" "text"
);


ALTER TABLE "public"."collection_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."collection_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "collection_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "sku" "text",
    "variant_external_id" "text",
    "display_order" integer,
    "inclusion_reason" "text",
    "allocation_weight" numeric,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "collection_products_allocation_weight_check" CHECK ((("allocation_weight" IS NULL) OR (("allocation_weight" > (0)::numeric) AND ("allocation_weight" <= (1)::numeric)))),
    CONSTRAINT "collection_products_target_ck" CHECK ((("product_id" IS NOT NULL) OR ("sku" IS NOT NULL) OR ("variant_external_id" IS NOT NULL)))
);


ALTER TABLE "public"."collection_products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."collections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "collection_type" "text",
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "launch_date" "date",
    "planned_budget_amount" numeric,
    "budget_currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "external_ref" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "collections_budget_non_negative_ck" CHECK ((("planned_budget_amount" IS NULL) OR ("planned_budget_amount" >= (0)::numeric))),
    CONSTRAINT "collections_date_range_ck" CHECK ((("ends_at" IS NULL) OR ("starts_at" IS NULL) OR ("ends_at" >= "starts_at"))),
    CONSTRAINT "collections_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'archived'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."collections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "contact_type" "public"."contact_type" DEFAULT 'supplier'::"public"."contact_type" NOT NULL,
    "name" "text" NOT NULL,
    "company_name" "text",
    "email" "text",
    "phone" "text",
    "address_line_1" "text",
    "address_line_2" "text",
    "city" "text",
    "region" "text",
    "postal_code" "text",
    "country" "text",
    "currency" character(3) DEFAULT 'GBP'::"bpchar",
    "tax_number" "text",
    "payment_terms" integer DEFAULT 30,
    "provider" "text",
    "external_id" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."contacts" IS 'Suppliers and wholesale customers (counterparties) for invoices';



COMMENT ON COLUMN "public"."contacts"."contact_type" IS 'Whether this contact acts as a supplier, customer (wholesale buyer), or both';



COMMENT ON COLUMN "public"."contacts"."tax_number" IS 'VAT number or tax registration number';



COMMENT ON COLUMN "public"."contacts"."payment_terms" IS 'Default payment terms in days (e.g., Net 30)';



CREATE TABLE IF NOT EXISTS "public"."corporation_tax_rates" (
    "financial_year" integer NOT NULL,
    "starts_on" "date" NOT NULL,
    "ends_on" "date" NOT NULL,
    "small_profits_rate" numeric NOT NULL,
    "main_rate" numeric NOT NULL,
    "lower_limit" numeric NOT NULL,
    "upper_limit" numeric NOT NULL,
    "marginal_relief_fraction" numeric
);


ALTER TABLE "public"."corporation_tax_rates" OWNER TO "postgres";


COMMENT ON TABLE "public"."corporation_tax_rates" IS 'UK corporation tax rates by financial year (FY2023 = 1 Apr 2023 to 31 Mar 2024). Marginal relief applies between lower_limit and upper_limit; limits are pro-rated for short periods and divided by the number of associated companies.';



CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "external_id" "text" NOT NULL,
    "raw_event_id" "uuid",
    "email" "text",
    "first_name" "text",
    "last_name" "text",
    "phone" "text",
    "default_address" "jsonb",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."customers"."created_at" IS 'When the customer was created in the source system';



COMMENT ON COLUMN "public"."customers"."metadata" IS 'Provider-specific fields (e.g., accepts_marketing, loyalty tier)';



CREATE TABLE IF NOT EXISTS "public"."entities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "legal_name" "text",
    "country" "text",
    "currency" character(3),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "industry" "text",
    "description" "text",
    "website" "text",
    "employee_count" "text",
    "onboarding_completed" boolean DEFAULT false,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "owner_user_id" "uuid",
    "company_number" "text",
    "tax_reference" "text",
    "year_end_day" smallint,
    "year_end_month" smallint,
    "incorporation_date" "date",
    "vat_registered" boolean DEFAULT false NOT NULL,
    "vat_number" "text"
);


ALTER TABLE "public"."entities" OWNER TO "postgres";


COMMENT ON COLUMN "public"."entities"."industry" IS 'Industry type: technology, healthcare, finance, retail, manufacturing, education, real_estate, hospitality, consulting, other';



COMMENT ON COLUMN "public"."entities"."employee_count" IS 'Employee count range: 1-10, 11-50, 51-200, 201-500, 501-1000, 1000+';



COMMENT ON COLUMN "public"."entities"."onboarding_completed" IS 'Whether the entity has completed the onboarding flow';



COMMENT ON COLUMN "public"."entities"."tax_reference" IS 'HMRC Unique Taxpayer Reference (UTR). Required on the CT600.';



COMMENT ON COLUMN "public"."entities"."year_end_month" IS 'Accounting reference date month (1-12). With year_end_day, defines the accounting period end used for all corporation tax computations.';



CREATE TABLE IF NOT EXISTS "public"."external_raw_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "external_id" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "occurred_at" timestamp with time zone,
    "fetched_at" timestamp with time zone DEFAULT "now"(),
    "processing_status" "text" DEFAULT 'pending'::"text",
    "processed_at" timestamp with time zone,
    "processing_error" "text",
    "processing_error_details" "jsonb",
    CONSTRAINT "external_raw_events_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'needs_review'::"text"])))
);


ALTER TABLE "public"."external_raw_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_source_sync_state" (
    "source_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "last_synced_at" timestamp with time zone,
    "last_run_status" "text",
    "last_run_error" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "external_source_sync_state_last_run_status_check" CHECK (("last_run_status" = ANY (ARRAY['completed'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."external_source_sync_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."external_source_sync_state" IS 'Per-(source, endpoint) incremental sync watermark. Read before a sync run to bound the fetch window, written after each endpoint completes or fails.';



CREATE TABLE IF NOT EXISTS "public"."external_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid",
    "provider" "text" NOT NULL,
    "external_account_id" "text" NOT NULL,
    "display_name" "text",
    "credentials" "jsonb",
    "last_synced_at" timestamp with time zone,
    "sync_cursor" "text",
    "sync_status" "text" DEFAULT 'idle'::"text",
    "sync_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "api_key_secret_id" "uuid",
    "api_key_status" "text" DEFAULT 'pending'::"text",
    "api_key_last_validated_at" timestamp with time zone,
    "api_key_error" "text",
    CONSTRAINT "external_sources_api_key_status_check" CHECK (("api_key_status" = ANY (ARRAY['pending'::"text", 'valid'::"text", 'invalid'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."external_sources" OWNER TO "postgres";


COMMENT ON COLUMN "public"."external_sources"."credentials" IS 'DEPRECATED: Legacy plaintext credentials. Migrated to Vault.';



COMMENT ON COLUMN "public"."external_sources"."api_key_secret_id" IS 'Reference to encrypted API key in vault.secrets. Never expose to client.';



COMMENT ON COLUMN "public"."external_sources"."api_key_status" IS 'Validation status: pending (not tested), valid (works), invalid (auth failed), expired (needs refresh)';



CREATE TABLE IF NOT EXISTS "public"."financial_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "bank_account_id" "uuid",
    "external_transaction_id" "text" NOT NULL,
    "amount" numeric(18,4) NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "description" "text",
    "counterparty_name" "text",
    "raw_event_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "currency_code" character(3) NOT NULL,
    "base_currency_code" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "fx_rate" numeric(18,8),
    "base_amount" numeric(18,4) NOT NULL,
    "status" "public"."txn_status" DEFAULT 'pending'::"public"."txn_status" NOT NULL,
    "transaction_type" "public"."txn_type" NOT NULL,
    "source" "public"."txn_source" NOT NULL,
    "direction" "public"."txn_direction" NOT NULL,
    "journalised_at" timestamp with time zone,
    "reconciled_at" timestamp with time zone,
    "excluded_reason" "text",
    CONSTRAINT "chk_amount_positive" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."financial_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoice_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit_cost" numeric DEFAULT 0 NOT NULL,
    "gl_account_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tax_code" "text" DEFAULT 'NON_VAT'::"text" NOT NULL,
    "vat_rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "line_net" numeric(18,4) GENERATED ALWAYS AS ("round"(("quantity" * "unit_cost"), 4)) STORED,
    "line_vat" numeric(18,4) GENERATED ALWAYS AS ("round"((("quantity" * "unit_cost") * "vat_rate"), 4)) STORED,
    "line_gross" numeric(18,4) GENERATED ALWAYS AS ("round"((("quantity" * "unit_cost") * ((1)::numeric + "vat_rate")), 4)) STORED,
    "sku" "text"
);


ALTER TABLE "public"."invoice_line_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."invoice_line_items"."gl_account_id" IS 'FK to chart_of_accounts - the GL account this line posts to';



COMMENT ON COLUMN "public"."invoice_line_items"."tax_code" IS 'Tax code for this line item (e.g., NON_VAT, STANDARD, REDUCED)';



COMMENT ON COLUMN "public"."invoice_line_items"."vat_rate" IS 'VAT rate as a decimal (e.g., 0.20 for 20%)';



COMMENT ON COLUMN "public"."invoice_line_items"."line_net" IS 'Auto-calculated: quantity * unit_cost';



COMMENT ON COLUMN "public"."invoice_line_items"."line_vat" IS 'Auto-calculated: quantity * unit_cost * vat_rate';



COMMENT ON COLUMN "public"."invoice_line_items"."line_gross" IS 'Auto-calculated: quantity * unit_cost * (1 + vat_rate)';



CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "invoice_number" "text" NOT NULL,
    "net_amount" numeric DEFAULT 0 NOT NULL,
    "tax_amount" numeric DEFAULT 0 NOT NULL,
    "gross_amount" numeric DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'GBP'::"text" NOT NULL,
    "invoice_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "due_date" timestamp with time zone,
    "source" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "status" "public"."invoice_status" DEFAULT 'DRAFT'::"public"."invoice_status" NOT NULL,
    "counterparty_id" "uuid",
    "invoice_type" "public"."invoice_type" DEFAULT 'SALE'::"public"."invoice_type" NOT NULL,
    "fx_rate" numeric(18,8) DEFAULT 1.0,
    "file_path" "text"
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


COMMENT ON COLUMN "public"."invoices"."counterparty_id" IS 'FK to contacts table - the supplier or customer for this invoice';



COMMENT ON COLUMN "public"."invoices"."invoice_type" IS 'SALE = revenue invoice, PURCHASE = expense/supplier invoice';



COMMENT ON COLUMN "public"."invoices"."fx_rate" IS 'Exchange rate to base currency at invoice date';



CREATE TABLE IF NOT EXISTS "public"."normalization_processing_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "raw_event_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "external_id" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "canonical_id" "uuid",
    "canonical_table" "text",
    "error_message" "text",
    "error_details" "jsonb",
    "needs_review" boolean DEFAULT false,
    "review_reason" "text",
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "normalization_processing_log_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'needs_review'::"text"])))
);


ALTER TABLE "public"."normalization_processing_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_fees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "external_fee_id" "text",
    "gross_fee" numeric DEFAULT 0 NOT NULL,
    "refunded_fee" numeric DEFAULT 0 NOT NULL,
    "net_fee" numeric DEFAULT 0 NOT NULL,
    "currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "base_fee_amount" numeric
);


ALTER TABLE "public"."payment_fees" OWNER TO "postgres";


COMMENT ON TABLE "public"."payment_fees" IS 'Processing fees charged by payment gateways for each payment';



COMMENT ON COLUMN "public"."payment_fees"."payment_id" IS 'FK to payments table';



COMMENT ON COLUMN "public"."payment_fees"."external_fee_id" IS 'Unique fee ID from the payment gateway';



COMMENT ON COLUMN "public"."payment_fees"."gross_fee" IS 'Total processing fee charged';



COMMENT ON COLUMN "public"."payment_fees"."refunded_fee" IS 'Portion of fee refunded';



COMMENT ON COLUMN "public"."payment_fees"."net_fee" IS 'gross_fee minus refunded_fee';



COMMENT ON COLUMN "public"."payment_fees"."currency" IS 'ISO 4217 currency code for the fee';



COMMENT ON COLUMN "public"."payment_fees"."base_fee_amount" IS 'Fee amount in base currency (GBP). NULL = not yet computed.';



CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "order_id" "uuid",
    "provider" "text" NOT NULL,
    "external_id" "text" NOT NULL,
    "raw_event_id" "uuid",
    "order_external_id" "text",
    "amount" numeric(15,2) NOT NULL,
    "currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payment_method" "text",
    "transaction_id" "text",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "gateway" "text",
    "external_payment_id" "text",
    "refunded_amount" numeric DEFAULT 0 NOT NULL,
    "net_amount" numeric DEFAULT 0 NOT NULL,
    "paid_on" timestamp with time zone,
    "base_amount" numeric,
    "fx_rate" numeric,
    "base_currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'authorized'::"text", 'captured'::"text", 'refunded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."payments"."created_at" IS 'When the payment was made in the source system';



COMMENT ON COLUMN "public"."payments"."metadata" IS 'Provider-specific fields (e.g., gateway_reference, capture timestamps)';



COMMENT ON COLUMN "public"."payments"."gateway" IS 'Payment gateway/processor (e.g. STRIPE, SQUARE, PAYPAL)';



COMMENT ON COLUMN "public"."payments"."external_payment_id" IS 'Payment transaction ID from the payment gateway';



COMMENT ON COLUMN "public"."payments"."refunded_amount" IS 'Portion of the original amount that has been refunded';



COMMENT ON COLUMN "public"."payments"."net_amount" IS 'amount minus refunded_amount';



COMMENT ON COLUMN "public"."payments"."paid_on" IS 'Timestamp when the payment was actually made';



COMMENT ON COLUMN "public"."payments"."base_amount" IS 'Payment amount converted to base currency (GBP). NULL = not yet computed.';



COMMENT ON COLUMN "public"."payments"."fx_rate" IS 'Exchange rate applied: base_amount = amount * fx_rate. NULL if same currency.';



COMMENT ON COLUMN "public"."payments"."base_currency" IS 'Base currency for this entity, always GBP.';



CREATE OR REPLACE VIEW "public"."tax_account_positions" AS
 SELECT "a"."account_number",
    "a"."name" AS "account_name",
    "round"(("sum"("li"."debit") - "sum"("li"."credit")), 2) AS "net_debit",
    "round"(("sum"("li"."credit") - "sum"("li"."debit")), 2) AS "net_credit",
    "count"(*) AS "line_count"
   FROM (("public"."journal_line_items" "li"
     JOIN "public"."journals" "j" ON ((("j"."id" = "li"."journal_id") AND ("j"."status" = 'posted'::"public"."journal_status"))))
     JOIN "public"."chart_of_accounts" "a" ON (("a"."id" = "li"."account_id")))
  WHERE (("a"."account_number")::"text" = ANY ((ARRAY['2230'::character varying, '2035'::character varying, '8045'::character varying, '8040'::character varying])::"text"[]))
  GROUP BY "a"."account_number", "a"."name";


ALTER VIEW "public"."tax_account_positions" OWNER TO "postgres";


COMMENT ON VIEW "public"."tax_account_positions" IS 'Posted balances for tax-relevant control accounts: 2230 Director''s Loan (net_debit > 0 means the director owes the company, triggering s455), 2035 Corporation Tax Payable, 8045/8040 tax expense.';



CREATE TABLE IF NOT EXISTS "public"."tax_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period_id" "uuid" NOT NULL,
    "direction" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "account_number" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tax_adjustments_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "tax_adjustments_direction_check" CHECK (("direction" = ANY (ARRAY['add_back'::"text", 'deduction'::"text"]))),
    CONSTRAINT "tax_adjustments_source_check" CHECK (("source" = ANY (ARRAY['auto'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."tax_adjustments" OWNER TO "postgres";


COMMENT ON TABLE "public"."tax_adjustments" IS 'Line-by-line reconciliation from accounting profit to taxable total profits. source=auto rows are regenerated by the computation engine; manual rows are preserved.';



CREATE OR REPLACE VIEW "public"."tax_period_account_breakdown" AS
 WITH "lines" AS (
         SELECT "p"."id" AS "period_id",
            "a"."id" AS "account_id",
            "a"."account_number",
            "a"."name" AS "account_name",
            "a"."account_type",
                CASE
                    WHEN (("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NOT NULL)) THEN
                    CASE
                        WHEN ("li"."debit" > (0)::numeric) THEN "li"."gbp_equivalent"
                        ELSE (0)::numeric
                    END
                    ELSE "li"."debit"
                END AS "dr",
                CASE
                    WHEN (("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NOT NULL)) THEN
                    CASE
                        WHEN ("li"."debit" > (0)::numeric) THEN (0)::numeric
                        ELSE "li"."gbp_equivalent"
                    END
                    ELSE "li"."credit"
                END AS "cr"
           FROM ((("public"."accounting_periods" "p"
             JOIN "public"."journals" "j" ON ((("j"."entity_id" = "p"."entity_id") AND ("j"."status" = 'posted'::"public"."journal_status") AND ("j"."journal_date" >= "p"."start_date") AND ("j"."journal_date" < ("p"."end_date" + 1)))))
             JOIN "public"."journal_line_items" "li" ON (("li"."journal_id" = "j"."id")))
             JOIN "public"."chart_of_accounts" "a" ON (("a"."id" = "li"."account_id")))
          WHERE (("a"."status" = 'active'::"public"."account_status") AND ("a"."is_header" = false) AND ("a"."account_type" = ANY (ARRAY['revenue'::"public"."account_type", 'cogs'::"public"."account_type", 'expense'::"public"."account_type"])) AND (NOT (("li"."currency" IS NOT NULL) AND ("upper"("li"."currency") <> 'GBP'::"text") AND ("li"."gbp_equivalent" IS NULL))))
        )
 SELECT "period_id",
    "account_id",
    "account_number",
    "account_name",
    "account_type",
    "round"("sum"("dr"), 2) AS "debit",
    "round"("sum"("cr"), 2) AS "credit",
    "round"(
        CASE
            WHEN ("account_type" = 'revenue'::"public"."account_type") THEN ("sum"("cr") - "sum"("dr"))
            ELSE ("sum"("dr") - "sum"("cr"))
        END, 2) AS "balance",
    "count"(*) AS "line_count"
   FROM "lines"
  GROUP BY "period_id", "account_id", "account_number", "account_name", "account_type"
 HAVING ("round"(
        CASE
            WHEN ("account_type" = 'revenue'::"public"."account_type") THEN ("sum"("cr") - "sum"("dr"))
            ELSE ("sum"("dr") - "sum"("cr"))
        END, 2) <> (0)::numeric);


ALTER VIEW "public"."tax_period_account_breakdown" OWNER TO "postgres";


COMMENT ON VIEW "public"."tax_period_account_breakdown" IS 'Revenue/COGS/expense balances per account for a tax period. Sums to accounting_period_results.accounting_profit for the same period -- the two must always agree, since this is that total broken out by account.';



CREATE OR REPLACE VIEW "public"."tax_review_items" AS
 SELECT "p"."id" AS "period_id",
    "a"."account_number",
    "a"."name" AS "account_name",
    "round"("sum"(("li"."debit" - "li"."credit")), 2) AS "amount",
    "count"(*) AS "line_count",
        CASE "a"."account_number"
            WHEN '7100'::"text" THEN 'Travel is allowable; client entertainment is not. Staff entertainment is allowable up to £150/head per year. Needs splitting.'::"text"
            WHEN '7080'::"text" THEN 'Depreciation is always disallowable. Add back in full, then claim capital allowances instead.'::"text"
            WHEN '8080'::"text" THEN 'Qualifying charitable donations are deductible but cannot create or increase a loss. Non-qualifying donations are disallowable.'::"text"
            WHEN '8090'::"text" THEN 'Review for fines, penalties and non-business costs, which are disallowable.'::"text"
            WHEN '8045'::"text" THEN 'Corporation tax itself is never deductible against corporation tax.'::"text"
            WHEN '8040'::"text" THEN 'Tax charges are not deductible against corporation tax.'::"text"
            ELSE 'Review for any non-business or capital element.'::"text"
        END AS "guidance"
   FROM ((("public"."accounting_periods" "p"
     JOIN "public"."journals" "j" ON ((("j"."entity_id" = "p"."entity_id") AND ("j"."status" = 'posted'::"public"."journal_status") AND ("j"."journal_date" >= "p"."start_date") AND ("j"."journal_date" < ("p"."end_date" + 1)))))
     JOIN "public"."journal_line_items" "li" ON (("li"."journal_id" = "j"."id")))
     JOIN "public"."chart_of_accounts" "a" ON (("a"."id" = "li"."account_id")))
  WHERE (("a"."account_number")::"text" = ANY ((ARRAY['7080'::character varying, '7100'::character varying, '8080'::character varying, '8090'::character varying, '8040'::character varying, '8045'::character varying])::"text"[]))
  GROUP BY "p"."id", "a"."account_number", "a"."name"
 HAVING ("round"("sum"(("li"."debit" - "li"."credit")), 2) <> (0)::numeric);


ALTER VIEW "public"."tax_review_items" OWNER TO "postgres";


COMMENT ON VIEW "public"."tax_review_items" IS 'Ledger amounts sitting in accounts that commonly contain disallowable expenditure, per period, with the rule that applies. Deliberately advisory -- nothing here is added back automatically, because the allowable/disallowable split needs human judgement.';



ALTER TABLE ONLY "public"."accounting_period_locks"
    ADD CONSTRAINT "accounting_period_locks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_entity_id_start_date_key" UNIQUE ("entity_id", "start_date");



ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_source_external_account_id_entity_id_key" UNIQUE ("source", "external_account_id", "entity_id");



ALTER TABLE ONLY "public"."calendar_event_links"
    ADD CONSTRAINT "calendar_event_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_event_links"
    ADD CONSTRAINT "calendar_event_links_source_id_source_type_source_key_key" UNIQUE ("source_id", "source_type", "source_key");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_source_id_external_id_key" UNIQUE ("source_id", "external_id");



ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_account_number_key" UNIQUE ("account_number");



ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_costs"
    ADD CONSTRAINT "collection_costs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_costs"
    ADD CONSTRAINT "collection_costs_unique_link_uk" UNIQUE ("collection_id", "financial_transaction_id");



ALTER TABLE ONLY "public"."collection_plan_costs"
    ADD CONSTRAINT "collection_plan_costs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_plan_lines"
    ADD CONSTRAINT "collection_plan_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_plans"
    ADD CONSTRAINT "collection_plans_collection_id_key" UNIQUE ("collection_id");



ALTER TABLE ONLY "public"."collection_plans"
    ADD CONSTRAINT "collection_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collection_products"
    ADD CONSTRAINT "collection_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collections"
    ADD CONSTRAINT "collections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."collections"
    ADD CONSTRAINT "collections_slug_per_entity_uk" UNIQUE ("entity_id", "slug");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_entity_id_provider_external_id_key" UNIQUE ("entity_id", "provider", "external_id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."corporation_tax_rates"
    ADD CONSTRAINT "corporation_tax_rates_pkey" PRIMARY KEY ("financial_year");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_provider_external_id_entity_id_key" UNIQUE ("provider", "external_id", "entity_id");



ALTER TABLE ONLY "public"."entities"
    ADD CONSTRAINT "entities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_raw_events"
    ADD CONSTRAINT "external_raw_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_raw_events"
    ADD CONSTRAINT "external_raw_events_provider_entity_type_external_id_key" UNIQUE ("provider", "entity_type", "external_id");



ALTER TABLE ONLY "public"."external_source_sync_state"
    ADD CONSTRAINT "external_source_sync_state_pkey" PRIMARY KEY ("source_id", "endpoint");



ALTER TABLE ONLY "public"."external_sources"
    ADD CONSTRAINT "external_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_sources"
    ADD CONSTRAINT "external_sources_provider_external_account_id_key" UNIQUE ("provider", "external_account_id");



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journal_line_items"
    ADD CONSTRAINT "journal_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_entity_id_source_type_source_id_journal_type_key" UNIQUE ("entity_id", "source_type", "source_id", "journal_type");



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."normalization_processing_log"
    ADD CONSTRAINT "normalization_processing_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_provider_external_id_entity_id_key" UNIQUE ("provider", "external_id", "entity_id");



ALTER TABLE ONLY "public"."payment_fees"
    ADD CONSTRAINT "payment_fees_payment_id_external_fee_id_key" UNIQUE ("payment_id", "external_fee_id");



ALTER TABLE ONLY "public"."payment_fees"
    ADD CONSTRAINT "payment_fees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_provider_external_id_entity_id_key" UNIQUE ("provider", "external_id", "entity_id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_provider_external_id_entity_id_key" UNIQUE ("provider", "external_id", "entity_id");



ALTER TABLE ONLY "public"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "uq_external_txn" UNIQUE ("source", "external_transaction_id");



CREATE UNIQUE INDEX "accounting_period_locks_entity_uniq" ON "public"."accounting_period_locks" USING "btree" (COALESCE("entity_id", '00000000-0000-0000-0000-000000000000'::"uuid"));



CREATE INDEX "calendar_events_entity_id_idx" ON "public"."calendar_events" USING "btree" ("entity_id");



CREATE INDEX "calendar_events_start_at_idx" ON "public"."calendar_events" USING "btree" ("start_at");



CREATE INDEX "collection_costs_cost_type_idx" ON "public"."collection_costs" USING "btree" ("cost_type");



CREATE INDEX "collection_costs_entity_collection_idx" ON "public"."collection_costs" USING "btree" ("entity_id", "collection_id");



CREATE INDEX "collection_costs_financial_transaction_idx" ON "public"."collection_costs" USING "btree" ("financial_transaction_id");



CREATE INDEX "collection_plan_costs_plan_id_idx" ON "public"."collection_plan_costs" USING "btree" ("plan_id");



CREATE INDEX "collection_plan_lines_plan_id_idx" ON "public"."collection_plan_lines" USING "btree" ("plan_id");



CREATE INDEX "collection_plans_entity_id_idx" ON "public"."collection_plans" USING "btree" ("entity_id");



CREATE INDEX "collection_products_collection_id_idx" ON "public"."collection_products" USING "btree" ("collection_id");



CREATE INDEX "collection_products_product_id_idx" ON "public"."collection_products" USING "btree" ("product_id");



CREATE INDEX "collection_products_sku_idx" ON "public"."collection_products" USING "btree" ("sku");



CREATE UNIQUE INDEX "collection_products_unique_target_idx" ON "public"."collection_products" USING "btree" ("collection_id", COALESCE(("product_id")::"text", ''::"text"), COALESCE("sku", ''::"text"), COALESCE("variant_external_id", ''::"text"));



CREATE INDEX "collection_products_variant_external_id_idx" ON "public"."collection_products" USING "btree" ("variant_external_id");



CREATE INDEX "collections_entity_status_idx" ON "public"."collections" USING "btree" ("entity_id", "status");



CREATE INDEX "collections_launch_date_idx" ON "public"."collections" USING "btree" ("launch_date");



CREATE INDEX "entities_owner_user_id_idx" ON "public"."entities" USING "btree" ("owner_user_id");



CREATE INDEX "idx_accounting_periods_entity" ON "public"."accounting_periods" USING "btree" ("entity_id", "start_date" DESC);



CREATE INDEX "idx_bank_accounts_entity" ON "public"."bank_accounts" USING "btree" ("entity_id");



CREATE INDEX "idx_contacts_contact_type" ON "public"."contacts" USING "btree" ("entity_id", "contact_type");



CREATE INDEX "idx_contacts_entity_id" ON "public"."contacts" USING "btree" ("entity_id");



CREATE INDEX "idx_customers_email" ON "public"."customers" USING "btree" ("email");



CREATE INDEX "idx_customers_entity_id" ON "public"."customers" USING "btree" ("entity_id");



CREATE INDEX "idx_customers_provider_external" ON "public"."customers" USING "btree" ("provider", "external_id");



CREATE INDEX "idx_external_raw_events_fetched" ON "public"."external_raw_events" USING "btree" ("fetched_at");



CREATE INDEX "idx_external_raw_events_processing_status" ON "public"."external_raw_events" USING "btree" ("processing_status", "fetched_at");



CREATE INDEX "idx_external_raw_events_provider_type" ON "public"."external_raw_events" USING "btree" ("provider", "entity_type");



CREATE INDEX "idx_external_raw_events_source" ON "public"."external_raw_events" USING "btree" ("source_id");



CREATE INDEX "idx_external_sources_api_key_secret" ON "public"."external_sources" USING "btree" ("api_key_secret_id");



CREATE INDEX "idx_external_sources_entity" ON "public"."external_sources" USING "btree" ("entity_id");



CREATE INDEX "idx_external_sources_entity_id" ON "public"."external_sources" USING "btree" ("entity_id");



CREATE INDEX "idx_external_sources_provider" ON "public"."external_sources" USING "btree" ("provider");



CREATE INDEX "idx_ft_bank_account" ON "public"."financial_transactions" USING "btree" ("bank_account_id");



CREATE INDEX "idx_ft_occurred" ON "public"."financial_transactions" USING "btree" ("occurred_at");



CREATE INDEX "idx_ft_occurred_at" ON "public"."financial_transactions" USING "btree" ("occurred_at");



CREATE INDEX "idx_ft_source" ON "public"."financial_transactions" USING "btree" ("source");



CREATE INDEX "idx_ft_status" ON "public"."financial_transactions" USING "btree" ("status");



CREATE INDEX "idx_inventory_items_entity_id" ON "public"."inventory_items" USING "btree" ("entity_id");



CREATE INDEX "idx_inventory_items_product_id" ON "public"."inventory_items" USING "btree" ("product_id");



CREATE INDEX "idx_inventory_items_shopify_inventory_item_id" ON "public"."inventory_items" USING "btree" ("shopify_inventory_item_id") WHERE ("shopify_inventory_item_id" IS NOT NULL);



CREATE INDEX "idx_inventory_items_sku" ON "public"."inventory_items" USING "btree" ("sku");



CREATE UNIQUE INDEX "idx_inventory_items_upsert" ON "public"."inventory_items" USING "btree" ("provider", "variant_external_id", "entity_id");



CREATE INDEX "idx_inventory_items_variant" ON "public"."inventory_items" USING "btree" ("variant_external_id");



CREATE INDEX "idx_inventory_movements_item" ON "public"."inventory_movements" USING "btree" ("inventory_item_id");



CREATE INDEX "idx_inventory_movements_movement_date" ON "public"."inventory_movements" USING "btree" ("movement_date");



CREATE INDEX "idx_inventory_movements_ref" ON "public"."inventory_movements" USING "btree" ("reference_id") WHERE ("reference_id" IS NOT NULL);



CREATE INDEX "idx_inventory_movements_type" ON "public"."inventory_movements" USING "btree" ("transaction_type");



CREATE INDEX "idx_invoice_line_items_invoice_id" ON "public"."invoice_line_items" USING "btree" ("invoice_id");



CREATE INDEX "idx_invoices_counterparty_id" ON "public"."invoices" USING "btree" ("counterparty_id");



CREATE INDEX "idx_invoices_entity_id" ON "public"."invoices" USING "btree" ("entity_id");



CREATE INDEX "idx_invoices_invoice_type" ON "public"."invoices" USING "btree" ("entity_id", "invoice_type");



CREATE INDEX "idx_invoices_status" ON "public"."invoices" USING "btree" ("entity_id", "status");



CREATE INDEX "idx_jli_account" ON "public"."journal_line_items" USING "btree" ("account_id");



CREATE INDEX "idx_jli_journal" ON "public"."journal_line_items" USING "btree" ("journal_id");



CREATE INDEX "idx_journal_line_items_effective_date" ON "public"."journal_line_items" USING "btree" ("effective_date");



CREATE INDEX "idx_journals_date" ON "public"."journals" USING "btree" ("journal_date");



CREATE INDEX "idx_journals_entity" ON "public"."journals" USING "btree" ("entity_id");



CREATE INDEX "idx_journals_source" ON "public"."journals" USING "btree" ("source_type", "source_id");



CREATE INDEX "idx_normalization_log_entity_type" ON "public"."normalization_processing_log" USING "btree" ("entity_type");



CREATE INDEX "idx_normalization_log_raw_event" ON "public"."normalization_processing_log" USING "btree" ("raw_event_id");



CREATE INDEX "idx_normalization_log_status" ON "public"."normalization_processing_log" USING "btree" ("status");



CREATE INDEX "idx_order_line_items_order_id" ON "public"."order_line_items" USING "btree" ("order_id");



CREATE INDEX "idx_order_line_items_product" ON "public"."order_line_items" USING "btree" ("product_external_id");



CREATE INDEX "idx_order_line_items_sku" ON "public"."order_line_items" USING "btree" ("sku");



CREATE INDEX "idx_orders_customer_id" ON "public"."orders" USING "btree" ("customer_id");



CREATE INDEX "idx_orders_entity_id" ON "public"."orders" USING "btree" ("entity_id");



CREATE INDEX "idx_orders_order_number" ON "public"."orders" USING "btree" ("entity_id", "order_number");



CREATE INDEX "idx_orders_provider_external" ON "public"."orders" USING "btree" ("provider", "external_id");



CREATE INDEX "idx_orders_status" ON "public"."orders" USING "btree" ("entity_id", "status");



CREATE INDEX "idx_payment_fees_payment_id" ON "public"."payment_fees" USING "btree" ("payment_id");



CREATE INDEX "idx_payments_entity_id" ON "public"."payments" USING "btree" ("entity_id");



CREATE INDEX "idx_payments_gateway" ON "public"."payments" USING "btree" ("gateway");



CREATE INDEX "idx_payments_order_id" ON "public"."payments" USING "btree" ("order_id");



CREATE INDEX "idx_payments_paid_on" ON "public"."payments" USING "btree" ("paid_on");



CREATE INDEX "idx_payments_provider_external" ON "public"."payments" USING "btree" ("provider", "external_id");



CREATE INDEX "idx_products_entity_id" ON "public"."products" USING "btree" ("entity_id");



CREATE INDEX "idx_products_name" ON "public"."products" USING "btree" ("entity_id", "name");



CREATE INDEX "idx_products_provider_external" ON "public"."products" USING "btree" ("provider", "external_id");



CREATE INDEX "idx_tax_adjustments_period" ON "public"."tax_adjustments" USING "btree" ("period_id");



CREATE OR REPLACE TRIGGER "trg_assert_accounting_period_open" BEFORE INSERT OR UPDATE ON "public"."journals" FOR EACH ROW EXECUTE FUNCTION "public"."assert_accounting_period_open"();



CREATE OR REPLACE TRIGGER "trg_backfill_sale_cost_snapshots" AFTER UPDATE OF "unit_cost" ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."backfill_sale_cost_snapshots"();



CREATE OR REPLACE TRIGGER "trg_collection_costs_set_updated_at" BEFORE UPDATE ON "public"."collection_costs" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_collection_products_set_updated_at" BEFORE UPDATE ON "public"."collection_products" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_collections_set_updated_at" BEFORE UPDATE ON "public"."collections" FOR EACH ROW EXECUTE FUNCTION "public"."tg_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_journal_line_items_set_effective_date" BEFORE INSERT ON "public"."journal_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."sync_journal_line_item_effective_date"();



CREATE OR REPLACE TRIGGER "trigger_cleanup_api_key" BEFORE DELETE ON "public"."external_sources" FOR EACH ROW EXECUTE FUNCTION "public"."cleanup_api_key_on_delete"();



CREATE OR REPLACE TRIGGER "trigger_external_sources_updated_at" BEFORE UPDATE ON "public"."external_sources" FOR EACH ROW EXECUTE FUNCTION "public"."update_external_sources_updated_at"();



CREATE OR REPLACE TRIGGER "update_customers_updated_at" BEFORE UPDATE ON "public"."customers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_inventory_items_updated_at" BEFORE UPDATE ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_order_line_items_updated_at" BEFORE UPDATE ON "public"."order_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_payments_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_products_updated_at" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."accounting_period_locks"
    ADD CONSTRAINT "accounting_period_locks_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."accounting_periods"
    ADD CONSTRAINT "accounting_periods_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."calendar_event_links"
    ADD CONSTRAINT "calendar_event_links_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."calendar_event_links"
    ADD CONSTRAINT "calendar_event_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."external_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."external_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chart_of_accounts"
    ADD CONSTRAINT "chart_of_accounts_parent_account_id_fkey" FOREIGN KEY ("parent_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."collection_costs"
    ADD CONSTRAINT "collection_costs_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_costs"
    ADD CONSTRAINT "collection_costs_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_costs"
    ADD CONSTRAINT "collection_costs_financial_transaction_id_fkey" FOREIGN KEY ("financial_transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_plan_costs"
    ADD CONSTRAINT "collection_plan_costs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."collection_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_plan_lines"
    ADD CONSTRAINT "collection_plan_lines_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."collection_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_plan_lines"
    ADD CONSTRAINT "collection_plan_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."collection_plans"
    ADD CONSTRAINT "collection_plans_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_plans"
    ADD CONSTRAINT "collection_plans_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."collection_products"
    ADD CONSTRAINT "collection_products_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."collection_products"
    ADD CONSTRAINT "collection_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."collections"
    ADD CONSTRAINT "collections_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."entities"
    ADD CONSTRAINT "entities_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_raw_events"
    ADD CONSTRAINT "external_raw_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."external_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_source_sync_state"
    ADD CONSTRAINT "external_source_sync_state_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."external_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_sources"
    ADD CONSTRAINT "external_sources_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id");



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_asset_account_id_fkey" FOREIGN KEY ("asset_account_id") REFERENCES "public"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_cogs_account_id_fkey" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "public"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_counterparty_id_fkey" FOREIGN KEY ("counterparty_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id");



ALTER TABLE ONLY "public"."journal_line_items"
    ADD CONSTRAINT "journal_line_items_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id");



ALTER TABLE ONLY "public"."journal_line_items"
    ADD CONSTRAINT "journal_line_items_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."journals"("id");



ALTER TABLE ONLY "public"."normalization_processing_log"
    ADD CONSTRAINT "normalization_processing_log_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."order_line_items"
    ADD CONSTRAINT "order_line_items_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."payment_fees"
    ADD CONSTRAINT "payment_fees_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_raw_event_id_fkey" FOREIGN KEY ("raw_event_id") REFERENCES "public"."external_raw_events"("id");



ALTER TABLE ONLY "public"."tax_adjustments"
    ADD CONSTRAINT "tax_adjustments_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE CASCADE;



CREATE POLICY "Allow entity creation during signup" ON "public"."entities" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Entity owners can update their entity" ON "public"."entities" FOR UPDATE TO "authenticated" USING (("owner_user_id" = "auth"."uid"())) WITH CHECK (("owner_user_id" = "auth"."uid"()));



CREATE POLICY "Service role full access on calendar_event_links" ON "public"."calendar_event_links" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access on entities" ON "public"."entities" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access on external_raw_events" ON "public"."external_raw_events" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access on external_source_sync_state" ON "public"."external_source_sync_state" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access on external_sources" ON "public"."external_sources" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Users can create external sources for their entity" ON "public"."external_sources" FOR INSERT WITH CHECK (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "Users can delete external sources for their entity" ON "public"."external_sources" FOR DELETE USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "Users can read their own entity" ON "public"."entities" FOR SELECT TO "authenticated" USING (("owner_user_id" = "auth"."uid"()));



CREATE POLICY "Users can update external sources for their entity" ON "public"."external_sources" FOR UPDATE USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "Users can view external sources for their entity" ON "public"."external_sources" FOR SELECT USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "Users can view sync state for their entity's sources" ON "public"."external_source_sync_state" FOR SELECT USING (("source_id" IN ( SELECT "es"."id"
   FROM ("public"."external_sources" "es"
     JOIN "public"."entities" "e" ON (("e"."id" = "es"."entity_id")))
  WHERE ("e"."owner_user_id" = "auth"."uid"()))));



ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_event_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chart_of_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."collection_costs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_costs_owner_policy" ON "public"."collection_costs" USING ((EXISTS ( SELECT 1
   FROM "public"."entities" "e"
  WHERE (("e"."id" = "collection_costs"."entity_id") AND ("e"."owner_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."entities" "e"
  WHERE (("e"."id" = "collection_costs"."entity_id") AND ("e"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."collection_plan_costs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_plan_costs_owner_policy" ON "public"."collection_plan_costs" USING ((EXISTS ( SELECT 1
   FROM ("public"."collection_plans" "p"
     JOIN "public"."entities" "e" ON (("e"."id" = "p"."entity_id")))
  WHERE (("p"."id" = "collection_plan_costs"."plan_id") AND ("e"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."collection_plan_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_plan_lines_owner_policy" ON "public"."collection_plan_lines" USING ((EXISTS ( SELECT 1
   FROM ("public"."collection_plans" "p"
     JOIN "public"."entities" "e" ON (("e"."id" = "p"."entity_id")))
  WHERE (("p"."id" = "collection_plan_lines"."plan_id") AND ("e"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."collection_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_plans_owner_policy" ON "public"."collection_plans" USING ((EXISTS ( SELECT 1
   FROM "public"."entities" "e"
  WHERE (("e"."id" = "collection_plans"."entity_id") AND ("e"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."collection_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collection_products_owner_policy" ON "public"."collection_products" USING ((EXISTS ( SELECT 1
   FROM ("public"."collections" "c"
     JOIN "public"."entities" "e" ON (("e"."id" = "c"."entity_id")))
  WHERE (("c"."id" = "collection_products"."collection_id") AND ("e"."owner_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."collections" "c"
     JOIN "public"."entities" "e" ON (("e"."id" = "c"."entity_id")))
  WHERE (("c"."id" = "collection_products"."collection_id") AND ("e"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."collections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "collections_owner_policy" ON "public"."collections" USING ((EXISTS ( SELECT 1
   FROM "public"."entities" "e"
  WHERE (("e"."id" = "collections"."entity_id") AND ("e"."owner_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."entities" "e"
  WHERE (("e"."id" = "collections"."entity_id") AND ("e"."owner_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."entities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."external_raw_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."external_source_sync_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."external_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."financial_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoice_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."journal_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."journals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."normalization_processing_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_fees" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users can delete their entity contacts" ON "public"."contacts" FOR DELETE TO "authenticated" USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can delete their entity inventory items" ON "public"."inventory_items" FOR DELETE USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can delete their entity invoice line items" ON "public"."invoice_line_items" FOR DELETE TO "authenticated" USING (("invoice_id" IN ( SELECT "invoices"."id"
   FROM "public"."invoices"
  WHERE ("invoices"."entity_id" IN ( SELECT "entities"."id"
           FROM "public"."entities"
          WHERE ("entities"."owner_user_id" = "auth"."uid"()))))));



CREATE POLICY "users can delete their entity invoices" ON "public"."invoices" FOR DELETE TO "authenticated" USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can delete their entity products" ON "public"."products" FOR DELETE USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can insert their entity contacts" ON "public"."contacts" FOR INSERT TO "authenticated" WITH CHECK (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can insert their entity inventory items" ON "public"."inventory_items" FOR INSERT WITH CHECK (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can insert their entity invoice line items" ON "public"."invoice_line_items" FOR INSERT TO "authenticated" WITH CHECK (("invoice_id" IN ( SELECT "invoices"."id"
   FROM "public"."invoices"
  WHERE ("invoices"."entity_id" IN ( SELECT "entities"."id"
           FROM "public"."entities"
          WHERE ("entities"."owner_user_id" = "auth"."uid"()))))));



CREATE POLICY "users can insert their entity invoices" ON "public"."invoices" FOR INSERT TO "authenticated" WITH CHECK (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can insert their entity products" ON "public"."products" FOR INSERT WITH CHECK (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can update their entity contacts" ON "public"."contacts" FOR UPDATE TO "authenticated" USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can update their entity inventory items" ON "public"."inventory_items" FOR UPDATE USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can update their entity invoice line items" ON "public"."invoice_line_items" FOR UPDATE TO "authenticated" USING (("invoice_id" IN ( SELECT "invoices"."id"
   FROM "public"."invoices"
  WHERE ("invoices"."entity_id" IN ( SELECT "entities"."id"
           FROM "public"."entities"
          WHERE ("entities"."owner_user_id" = "auth"."uid"()))))));



CREATE POLICY "users can update their entity invoices" ON "public"."invoices" FOR UPDATE TO "authenticated" USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can update their entity products" ON "public"."products" FOR UPDATE USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can update their own entity" ON "public"."entities" FOR UPDATE TO "authenticated" USING (("owner_user_id" = "auth"."uid"()));



CREATE POLICY "users can view their entity contacts" ON "public"."contacts" FOR SELECT TO "authenticated" USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can view their entity inventory items" ON "public"."inventory_items" FOR SELECT USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can view their entity invoice line items" ON "public"."invoice_line_items" FOR SELECT TO "authenticated" USING (("invoice_id" IN ( SELECT "invoices"."id"
   FROM "public"."invoices"
  WHERE ("invoices"."entity_id" IN ( SELECT "entities"."id"
           FROM "public"."entities"
          WHERE ("entities"."owner_user_id" = "auth"."uid"()))))));



CREATE POLICY "users can view their entity invoices" ON "public"."invoices" FOR SELECT TO "authenticated" USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can view their entity products" ON "public"."products" FOR SELECT USING (("entity_id" IN ( SELECT "entities"."id"
   FROM "public"."entities"
  WHERE ("entities"."owner_user_id" = "auth"."uid"()))));



CREATE POLICY "users can view their own entity" ON "public"."entities" FOR SELECT TO "authenticated" USING (("owner_user_id" = "auth"."uid"()));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."assert_accounting_period_open"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_accounting_period_open"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_accounting_period_open"() TO "service_role";



GRANT ALL ON FUNCTION "public"."backfill_sale_cost_snapshots"() TO "anon";
GRANT ALL ON FUNCTION "public"."backfill_sale_cost_snapshots"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."backfill_sale_cost_snapshots"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_api_key_on_delete"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_api_key_on_delete"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_api_key_on_delete"() TO "service_role";



GRANT ALL ON FUNCTION "public"."compute_corporation_tax"("p_entity_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."compute_corporation_tax"("p_entity_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_corporation_tax"("p_entity_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."ct_tax_for_slice"("p_profit" numeric, "p_days" numeric, "p_fy_end" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."ct_tax_for_slice"("p_profit" numeric, "p_days" numeric, "p_fy_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ct_tax_for_slice"("p_profit" numeric, "p_days" numeric, "p_fy_end" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_api_key_secure"("p_source_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_api_key_secure"("p_source_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_entity_id_from_source"("p_source_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_entity_id_from_source"("p_source_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_entity_id_from_source"("p_source_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_legacy_sales_by_product"("excluded_order_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_legacy_sales_by_product"("excluded_order_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_legacy_sales_by_product"("excluded_order_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_sync_stats_by_source"("p_source_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_sync_stats_by_source"("p_source_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_sync_stats_by_source"("p_source_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."post_draft_journal"("p_entity_id" "uuid", "p_journal_id" "uuid", "p_account_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."post_draft_journal"("p_entity_id" "uuid", "p_journal_id" "uuid", "p_account_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."seed_chart_of_accounts"() TO "anon";
GRANT ALL ON FUNCTION "public"."seed_chart_of_accounts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seed_chart_of_accounts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."store_api_key_secure"("p_source_id" "uuid", "p_api_key" "text", "p_provider" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_journal_line_item_effective_date"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_journal_line_item_effective_date"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_journal_line_item_effective_date"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tax_deadlines"("p_entity_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."tax_deadlines"("p_entity_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."tax_deadlines"("p_entity_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."tg_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."tg_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tg_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_api_key_status"("p_source_id" "uuid", "p_status" "text", "p_error" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_external_sources_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_external_sources_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_external_sources_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_journal_with_lines"("p_entity_id" "uuid", "p_journal_date" "date", "p_journal_type" "text", "p_description" "text", "p_source_type" "text", "p_source_id" "uuid", "p_status" "text", "p_metadata" "jsonb", "p_line_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_journal_with_lines"("p_entity_id" "uuid", "p_journal_date" "date", "p_journal_type" "text", "p_description" "text", "p_source_type" "text", "p_source_id" "uuid", "p_status" "text", "p_metadata" "jsonb", "p_line_items" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."_backup_charcoal_merge" TO "anon";
GRANT ALL ON TABLE "public"."_backup_charcoal_merge" TO "authenticated";
GRANT ALL ON TABLE "public"."_backup_charcoal_merge" TO "service_role";



GRANT ALL ON TABLE "public"."_backup_charcoal_order_merge" TO "anon";
GRANT ALL ON TABLE "public"."_backup_charcoal_order_merge" TO "authenticated";
GRANT ALL ON TABLE "public"."_backup_charcoal_order_merge" TO "service_role";



GRANT ALL ON TABLE "public"."_backup_phase1_items" TO "anon";
GRANT ALL ON TABLE "public"."_backup_phase1_items" TO "authenticated";
GRANT ALL ON TABLE "public"."_backup_phase1_items" TO "service_role";



GRANT ALL ON TABLE "public"."_backup_phase1_movements" TO "anon";
GRANT ALL ON TABLE "public"."_backup_phase1_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."_backup_phase1_movements" TO "service_role";



GRANT ALL ON TABLE "public"."_backup_phase2_count" TO "anon";
GRANT ALL ON TABLE "public"."_backup_phase2_count" TO "authenticated";
GRANT ALL ON TABLE "public"."_backup_phase2_count" TO "service_role";



GRANT ALL ON TABLE "public"."_backup_sale_movement_dates" TO "anon";
GRANT ALL ON TABLE "public"."_backup_sale_movement_dates" TO "authenticated";
GRANT ALL ON TABLE "public"."_backup_sale_movement_dates" TO "service_role";



GRANT ALL ON TABLE "public"."chart_of_accounts" TO "anon";
GRANT ALL ON TABLE "public"."chart_of_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."chart_of_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."journal_line_items" TO "anon";
GRANT ALL ON TABLE "public"."journal_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."journal_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."journals" TO "anon";
GRANT ALL ON TABLE "public"."journals" TO "authenticated";
GRANT ALL ON TABLE "public"."journals" TO "service_role";



GRANT ALL ON TABLE "public"."clearing_account_breakdown" TO "anon";
GRANT ALL ON TABLE "public"."clearing_account_breakdown" TO "authenticated";
GRANT ALL ON TABLE "public"."clearing_account_breakdown" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_items" TO "anon";
GRANT ALL ON TABLE "public"."inventory_items" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_items" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."order_line_items" TO "anon";
GRANT ALL ON TABLE "public"."order_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."order_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_on_hand" TO "anon";
GRANT ALL ON TABLE "public"."inventory_on_hand" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_on_hand" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_gl_reconciliation" TO "anon";
GRANT ALL ON TABLE "public"."inventory_gl_reconciliation" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_gl_reconciliation" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_negative_stock" TO "anon";
GRANT ALL ON TABLE "public"."inventory_negative_stock" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_negative_stock" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_uncosted_sales" TO "anon";
GRANT ALL ON TABLE "public"."inventory_uncosted_sales" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_uncosted_sales" TO "service_role";



GRANT ALL ON TABLE "public"."accounting_health_checks" TO "anon";
GRANT ALL ON TABLE "public"."accounting_health_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."accounting_health_checks" TO "service_role";



GRANT ALL ON TABLE "public"."accounting_period_locks" TO "anon";
GRANT ALL ON TABLE "public"."accounting_period_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."accounting_period_locks" TO "service_role";



GRANT ALL ON TABLE "public"."accounting_periods" TO "anon";
GRANT ALL ON TABLE "public"."accounting_periods" TO "authenticated";
GRANT ALL ON TABLE "public"."accounting_periods" TO "service_role";



GRANT ALL ON TABLE "public"."accounting_period_results" TO "anon";
GRANT ALL ON TABLE "public"."accounting_period_results" TO "authenticated";
GRANT ALL ON TABLE "public"."accounting_period_results" TO "service_role";



GRANT ALL ON TABLE "public"."bank_accounts" TO "anon";
GRANT ALL ON TABLE "public"."bank_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_event_links" TO "anon";
GRANT ALL ON TABLE "public"."calendar_event_links" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_event_links" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON TABLE "public"."collection_costs" TO "anon";
GRANT ALL ON TABLE "public"."collection_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_costs" TO "service_role";



GRANT ALL ON TABLE "public"."collection_plan_costs" TO "anon";
GRANT ALL ON TABLE "public"."collection_plan_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_plan_costs" TO "service_role";



GRANT ALL ON TABLE "public"."collection_plan_lines" TO "anon";
GRANT ALL ON TABLE "public"."collection_plan_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_plan_lines" TO "service_role";



GRANT ALL ON TABLE "public"."collection_plans" TO "anon";
GRANT ALL ON TABLE "public"."collection_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_plans" TO "service_role";



GRANT ALL ON TABLE "public"."collection_products" TO "anon";
GRANT ALL ON TABLE "public"."collection_products" TO "authenticated";
GRANT ALL ON TABLE "public"."collection_products" TO "service_role";



GRANT ALL ON TABLE "public"."collections" TO "anon";
GRANT ALL ON TABLE "public"."collections" TO "authenticated";
GRANT ALL ON TABLE "public"."collections" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."corporation_tax_rates" TO "anon";
GRANT ALL ON TABLE "public"."corporation_tax_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."corporation_tax_rates" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."entities" TO "anon";
GRANT ALL ON TABLE "public"."entities" TO "authenticated";
GRANT ALL ON TABLE "public"."entities" TO "service_role";



GRANT ALL ON TABLE "public"."external_raw_events" TO "anon";
GRANT ALL ON TABLE "public"."external_raw_events" TO "authenticated";
GRANT ALL ON TABLE "public"."external_raw_events" TO "service_role";



GRANT ALL ON TABLE "public"."external_source_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."external_source_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."external_source_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."external_sources" TO "anon";
GRANT ALL ON TABLE "public"."external_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."external_sources" TO "service_role";



GRANT ALL ON TABLE "public"."financial_transactions" TO "anon";
GRANT ALL ON TABLE "public"."financial_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_line_items" TO "anon";
GRANT ALL ON TABLE "public"."invoice_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."normalization_processing_log" TO "anon";
GRANT ALL ON TABLE "public"."normalization_processing_log" TO "authenticated";
GRANT ALL ON TABLE "public"."normalization_processing_log" TO "service_role";



GRANT ALL ON TABLE "public"."payment_fees" TO "anon";
GRANT ALL ON TABLE "public"."payment_fees" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_fees" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."tax_account_positions" TO "anon";
GRANT ALL ON TABLE "public"."tax_account_positions" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_account_positions" TO "service_role";



GRANT ALL ON TABLE "public"."tax_adjustments" TO "anon";
GRANT ALL ON TABLE "public"."tax_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_adjustments" TO "service_role";



GRANT ALL ON TABLE "public"."tax_period_account_breakdown" TO "anon";
GRANT ALL ON TABLE "public"."tax_period_account_breakdown" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_period_account_breakdown" TO "service_role";



GRANT ALL ON TABLE "public"."tax_review_items" TO "anon";
GRANT ALL ON TABLE "public"."tax_review_items" TO "authenticated";
GRANT ALL ON TABLE "public"."tax_review_items" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







