-- Revolut moves between the business's own accounts, and the fee on a Revolut leg.
--
-- The normaliser kept only the first leg of a non-exchange transaction, so a move between two
-- of the business's accounts (a merchant payment's settlement and payout) read as money going
-- out, and would have been journaled as an expense. It now recognises them (every leg on an
-- account, no counterparty, one currency, adding up to nothing: revolut_normalizer.
-- internal_move_legs), stores them excluded with metadata.internal_move and the legs, and keeps
-- a leg's fee as metadata.fee with its currency (fee_currency). This applies the same to what
-- is already stored, from the raw Revolut payloads, so it does not wait for a re-import.

-- Internal moves. A reason someone already wrote is kept. A move that already has a live
-- journal is left alone: excluding it would strand the journal, so that needs a person.
with moves as (
  select t.id, e.payload -> 'legs' as legs
  from public.financial_transactions t
  join public.external_raw_events e on e.id = t.raw_event_id
  where t.source = 'revolut'
    and e.payload ->> 'type' <> 'exchange'
    and jsonb_typeof(e.payload -> 'legs') = 'array'
    and jsonb_array_length(e.payload -> 'legs') >= 2
    and not exists (
      select 1 from jsonb_array_elements(e.payload -> 'legs') l
      where coalesce(l ->> 'account_id', '') = ''
         or jsonb_typeof(l -> 'counterparty') = 'object'
    )
    and (
      select count(distinct upper(l ->> 'currency'))
      from jsonb_array_elements(e.payload -> 'legs') l
    ) = 1
    and (
      select sum((l ->> 'amount')::numeric) from jsonb_array_elements(e.payload -> 'legs') l
    ) = 0
    and not exists (
      select 1 from public.journals j
      where j.source_type = 'financial_transaction'
        and j.source_id = t.id
        and j.status <> 'reversed'
    )
)
update public.financial_transactions t
set excluded_reason = coalesce(t.excluded_reason, 'Moved between your own Revolut accounts'),
    status = 'excluded',
    metadata = coalesce(t.metadata, '{}'::jsonb) || jsonb_build_object(
      'internal_move', true,
      'legs', (
        select jsonb_agg(jsonb_build_object(
          'account_id', l ->> 'account_id',
          'amount', (l ->> 'amount')::numeric,
          'currency', l ->> 'currency'
        ))
        from jsonb_array_elements(m.legs) l
      )
    ),
    updated_at = now()
from moves m
where t.id = m.id;

-- The fee on the leg each row was stored from (the first; exchanges are stored per leg and
-- are left out), in that leg's currency: a card payment abroad is stored in the billed
-- currency, its fee in the account's. Only merchant payments journal it so far.
update public.financial_transactions t
set metadata = coalesce(t.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'fee', abs((e.payload -> 'legs' -> 0 ->> 'fee')::numeric),
        'fee_currency', upper(coalesce(e.payload -> 'legs' -> 0 ->> 'currency', 'GBP'))
      ),
    updated_at = now()
from public.external_raw_events e
where e.id = t.raw_event_id
  and t.source = 'revolut'
  and e.payload ->> 'type' <> 'exchange'
  and coalesce((e.payload -> 'legs' -> 0 ->> 'fee')::numeric, 0) <> 0
  and not coalesce(t.metadata, '{}'::jsonb) ? 'fee';
