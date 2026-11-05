/**
 * PaidOutsideBank: mark an invoice paid when no bank transaction will ever show it, and say
 * how (in cash, personally, another way). The register then stops waiting for a payment and
 * the matcher stops looking for one. The ledger follows bank transactions, so such a payment is
 * not in the books.
 */

import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import type { PaidOutsideBank as How } from '~/types/invoice';
import { PAID_OUTSIDE_BANK } from './model';

export function PaidOutsideBankForm({
  isSale,
  busy,
  onSave,
  onCancel,
}: {
  isSale: boolean;
  busy: boolean;
  onSave: (how: How, note: string) => void;
  onCancel: () => void;
}) {
  const [how, setHow] = useState<How | null>(null);
  const [note, setNote] = useState('');

  return (
    <form
      className="space-y-3 rounded-xl border p-3.5"
      onSubmit={e => {
        e.preventDefault();
        if (how) onSave(how, note);
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-[15px]">
          {isSale ? 'How was it received?' : 'How was it paid?'}
        </legend>
        {(Object.keys(PAID_OUTSIDE_BANK) as How[]).map(key => (
          <label key={key} className="flex cursor-pointer items-start gap-2.5 text-[15px]">
            <input
              type="radio"
              name="paid-outside-bank"
              value={key}
              checked={how === key}
              onChange={() => setHow(key)}
              className="mt-1 size-4 accent-[var(--primary)]"
            />
            <span>
              {PAID_OUTSIDE_BANK[key].label}
              <span className="block text-[13px] text-text-2">
                {isSale ? PAID_OUTSIDE_BANK[key].sale : PAID_OUTSIDE_BANK[key].purchase}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <Input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Note (optional), e.g. who paid, a receipt number"
        aria-label="Note on the payment"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!how || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
