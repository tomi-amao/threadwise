/**
 * CompanyDrawer: the company details a CT600 needs and the app could not otherwise ask for: the
 * company number, the HMRC Unique Taxpayer Reference, and VAT registration.
 */

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Drawer } from '~/components/ui/drawer';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import type { EntityTaxProfile } from '~/lib/api/tax.server';

export function CompanyDrawer({
  entity,
  open,
  onClose,
}: {
  entity: EntityTaxProfile;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow="Tax"
      title="Company details"
      description="The details a corporation tax return needs"
    >
      {open && <Form entity={entity} onDone={onClose} />}
    </Drawer>
  );
}

function Form({ entity, onDone }: { entity: EntityTaxProfile; onDone: () => void }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; message?: string }>();
  const [vat, setVat] = useState(entity.vatRegistered);
  const saving = fetcher.state !== 'idle';

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data?.ok) return;
    toast.success(fetcher.data.message ?? 'Saved');
    onDone();
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" className="flex flex-col gap-5">
      <input type="hidden" name="intent" value="saveCompanyDetails" />
      <Field label="Company number" hint="Eight characters, such as 12345678 or SC123456.">
        <Input name="companyNumber" defaultValue={entity.companyNumber ?? ''} autoComplete="off" />
      </Field>
      <Field label="Unique Taxpayer Reference (UTR)" hint="Ten digits, from HMRC.">
        <Input
          name="taxReference"
          defaultValue={entity.taxReference ?? ''}
          inputMode="numeric"
          autoComplete="off"
        />
      </Field>
      <label className="flex items-center gap-2.5 text-[15px]">
        <input
          type="checkbox"
          name="vatRegistered"
          checked={vat}
          onChange={e => setVat(e.target.checked)}
          className="size-4 accent-[var(--primary)]"
        />
        Registered for VAT
      </label>
      {vat && (
        <Field label="VAT number" hint="Nine digits, optionally starting GB.">
          <Input name="vatNumber" defaultValue={entity.vatNumber ?? ''} autoComplete="off" />
        </Field>
      )}
      {fetcher.data && !fetcher.data.ok && (
        <p role="alert" className="text-[14px] text-destructive">
          {fetcher.data.error}
        </p>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save details'}
      </Button>
    </fetcher.Form>
  );
}
