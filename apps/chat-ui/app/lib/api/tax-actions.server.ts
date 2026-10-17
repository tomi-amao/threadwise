/**
 * Tax: the changes a person can make on the Tax page.
 *
 * - mark a period filed, or put it back to closed
 * - record (or remove) a manual adjustment to a period's taxable profit
 * - save the company details a CT600 needs
 *
 * Each starts from the signed-in user's session. A period or adjustment the user cannot read (row-
 * level security) is simply not found. Periods and adjustments have no write policy for users, so the
 * write itself uses the service role, but only after that read. Company details are the user's own
 * entity row, which they may update directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabaseClient } from '~/lib/supabase';

export type TaxActionResult = { ok: true; message: string } | { ok: false; error: string };

const fail = (error: string): TaxActionResult => ({ ok: false, error });

export const ADJUSTMENT_CATEGORIES = [
  'entertainment',
  'depreciation',
  'donations',
  'fines_and_penalties',
  'capital_allowances',
  'other',
] as const;

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

async function visiblePeriod(supabase: SupabaseClient, periodId: string) {
  const { data, error } = await supabase
    .from('accounting_periods')
    .select('id, status, label, end_date')
    .eq('id', periodId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; status: string; label: string; end_date: string } | null;
}

export async function markFiled(
  supabase: SupabaseClient,
  form: FormData
): Promise<TaxActionResult> {
  const period = await visiblePeriod(supabase, text(form, 'periodId'));
  if (!period) return fail('That period was not found');
  if (period.status === 'open') {
    return fail('A period that has not ended cannot be marked as filed.');
  }
  const filedOn = text(form, 'filedOn') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filedOn) || Number.isNaN(Date.parse(filedOn))) {
    return fail('Enter the date it was filed.');
  }
  if (filedOn < period.end_date) return fail('A return cannot be filed before the period ends.');
  const { error } = await getServerSupabaseClient()
    .from('accounting_periods')
    .update({ status: 'filed', filed_at: `${filedOn}T12:00:00Z` })
    .eq('id', period.id);
  if (error) return fail(error.message);
  return { ok: true, message: `${period.label} marked as filed` };
}

export async function reopenPeriod(
  supabase: SupabaseClient,
  form: FormData
): Promise<TaxActionResult> {
  const period = await visiblePeriod(supabase, text(form, 'periodId'));
  if (!period) return fail('That period was not found');
  if (period.status !== 'filed') return fail('Only a period marked as filed can be put back.');
  const { error } = await getServerSupabaseClient()
    .from('accounting_periods')
    .update({ status: 'closed', filed_at: null })
    .eq('id', period.id);
  if (error) return fail(error.message);
  return { ok: true, message: `${period.label} is no longer marked as filed` };
}

export async function addAdjustment(
  supabase: SupabaseClient,
  form: FormData
): Promise<TaxActionResult> {
  const period = await visiblePeriod(supabase, text(form, 'periodId'));
  if (!period) return fail('That period was not found');
  if (period.status === 'filed') {
    return fail('This period is marked as filed. Put it back before changing its figures.');
  }

  const direction = text(form, 'direction');
  if (direction !== 'add_back' && direction !== 'deduction') {
    return fail('Choose whether this is added back or deducted.');
  }
  const amount = Number(text(form, 'amount'));
  if (!Number.isFinite(amount) || amount <= 0) return fail('Enter an amount above zero.');
  if (amount > 1_000_000_000) return fail('That amount is too large.');
  const description = text(form, 'description');
  if (description.length < 3) return fail('Say briefly what this adjustment is for.');
  if (description.length > 200) return fail('Keep the description under 200 characters.');
  const category = text(form, 'category') || 'other';
  if (!(ADJUSTMENT_CATEGORIES as readonly string[]).includes(category)) {
    return fail('Choose a category from the list.');
  }
  const accountNumber = text(form, 'accountNumber') || null;

  const { error } = await getServerSupabaseClient()
    .from('tax_adjustments')
    .insert({
      period_id: period.id,
      direction,
      category,
      description,
      amount: Math.round(amount * 100) / 100,
      source: 'manual',
      account_number: accountNumber,
    });
  if (error) return fail(error.message);
  return { ok: true, message: 'Adjustment recorded' };
}

export async function deleteAdjustment(
  supabase: SupabaseClient,
  form: FormData
): Promise<TaxActionResult> {
  const id = text(form, 'adjustmentId');
  const { data, error } = await supabase
    .from('tax_adjustments')
    .select('id, source, period_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return fail('That adjustment was not found');
  if (data.source !== 'manual') {
    return fail('This one is worked out from the ledger. Only manual adjustments can be removed.');
  }
  const period = await visiblePeriod(supabase, data.period_id);
  if (period?.status === 'filed') {
    return fail('This period is marked as filed. Put it back before changing its figures.');
  }
  const { error: deleteError } = await getServerSupabaseClient()
    .from('tax_adjustments')
    .delete()
    .eq('id', data.id);
  if (deleteError) return fail(deleteError.message);
  return { ok: true, message: 'Adjustment removed' };
}

export async function saveCompanyDetails(
  supabase: SupabaseClient,
  entityId: string,
  form: FormData
): Promise<TaxActionResult> {
  const companyNumber = text(form, 'companyNumber').toUpperCase().replace(/\s+/g, '');
  const utr = text(form, 'taxReference').replace(/\s+/g, '');
  const vatRegistered = form.get('vatRegistered') === 'on';
  const vatNumber = text(form, 'vatNumber').toUpperCase().replace(/\s+/g, '');

  // Companies House numbers are eight characters: digits, or two letters then six digits (SC, NI ...).
  if (companyNumber && !/^([0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber)) {
    return fail('A company number is eight characters, such as 12345678 or SC123456.');
  }
  if (utr && !/^[0-9]{10}$/.test(utr)) {
    return fail('A Unique Taxpayer Reference (UTR) is ten digits.');
  }
  if (vatRegistered && !/^(GB)?[0-9]{9}$/.test(vatNumber)) {
    return fail('A VAT number is nine digits, optionally starting GB.');
  }

  const { data, error } = await supabase
    .from('entities')
    .update({
      company_number: companyNumber || null,
      tax_reference: utr || null,
      vat_registered: vatRegistered,
      vat_number: vatRegistered ? vatNumber : null,
    })
    .eq('id', entityId)
    .select('id');
  if (error) return fail(error.message);
  if (!data || data.length === 0) return fail('Your business was not found.');
  return { ok: true, message: 'Company details saved' };
}
