-- Invoices paid with no bank transaction behind them.
--
-- Some invoices are paid in cash, or personally by the owner, so no bank or PayPal transaction
-- will ever be matched to them. Marking one paid this way records how, so the register does not
-- keep waiting for (and the matcher does not keep looking for) a payment that will not come.
-- The ledger follows bank transactions, so such a payment is not in the books; one paid
-- personally belongs in the director's loan, recorded by hand.
--
-- InvoiceService.set_invoice_status writes these, only with a move to PAID and only when no
-- payment is linked; undoing the payment clears them. While set, linking a payment is refused.

alter table public.invoices
  add column paid_outside_bank text
    check (paid_outside_bank in ('cash', 'paid_personally', 'other')),
  add column paid_outside_bank_note text,
  add constraint invoices_paid_outside_bank_only_when_paid
    check (paid_outside_bank is null or status = 'PAID');

comment on column public.invoices.paid_outside_bank is
  'How a paid invoice was paid when no bank transaction is behind it: cash, paid_personally or other. Null otherwise. Only on a PAID invoice.';
comment on column public.invoices.paid_outside_bank_note is
  'The person''s note on a payment outside the bank (who paid, a receipt number).';
