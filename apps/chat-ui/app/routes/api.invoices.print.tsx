/**
 * Invoice — printable copy
 *
 * Revolut keeps no file for an invoice sent as a payment request, and no API returns one, so
 * this page is the document for those: the invoice as ThreadWise holds it, laid out to print,
 * opening with the print dialog so "save as PDF" is the next step (the same approach as the
 * report packs: no PDF library). An uploaded original replaces it in the drawer.
 *
 * Everything is read as the signed-in user, so row-level security decides; an invoice they
 * cannot see is a 404. The amount requested is the invoice's total, not the sum of its lines:
 * a Revolut request can be for part of what its lines list (a deposit), and the page says so
 * rather than showing a total the customer was not asked for.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

interface PrintInvoice {
  id: string;
  entity_id: string;
  invoice_number: string;
  invoice_type: 'SALE' | 'PURCHASE';
  status: string;
  currency: string;
  net_amount: number;
  tax_amount: number;
  gross_amount: number;
  invoice_date: string;
  due_date: string | null;
  origin: string | null;
  contacts: {
    name: string;
    company_name: string | null;
    email: string | null;
    phone: string | null;
    address_line_1: string | null;
    address_line_2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
  invoice_line_items: { id: string; description: string; quantity: number; unit_cost: number }[];
}

interface Entity {
  name: string;
  legal_name: string | null;
  company_number: string | null;
  vat_number: string | null;
  country: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  OPEN: 'Awaiting payment',
  OVERDUE: 'Overdue',
  PARTIALLY_PAID: 'Part paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  VOID: 'Void',
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDate = (value: string) =>
  new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const notFound = () => new Response('Invoice not found', { status: 404 });

export async function loader({ request }: LoaderFunctionArgs) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return new Response('An invoice id is required', { status: 400 });

  await requireUser(request);
  const supabase = getRequestSupabaseClient(request);
  const { data, error } = await supabase
    .from('invoices')
    .select(
      'id, entity_id, invoice_number, invoice_type, status, currency, net_amount, tax_amount, ' +
        'gross_amount, invoice_date, due_date, origin, ' +
        'contacts:counterparty_id(name, company_name, email, phone, address_line_1, ' +
        'address_line_2, city, region, postal_code, country), ' +
        'invoice_line_items(id, description, quantity, unit_cost)'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load invoice: ${error.message}`);
  if (!data) return notFound();
  const invoice = data as unknown as PrintInvoice;

  const [entityResult, paymentsResult] = await Promise.all([
    supabase
      .from('entities')
      .select('name, legal_name, company_number, vat_number, country')
      .eq('id', invoice.entity_id)
      .maybeSingle(),
    supabase.from('invoice_payments').select('amount, currency_code').eq('invoice_id', id),
  ]);
  if (entityResult.error)
    throw new Error(`Failed to load the business: ${entityResult.error.message}`);
  if (paymentsResult.error) {
    throw new Error(`Failed to load the payments: ${paymentsResult.error.message}`);
  }

  const html = renderInvoice(
    invoice,
    (entityResult.data as Entity | null) ?? null,
    (paymentsResult.data ?? []).map(p => ({
      amount: Number(p.amount),
      currency: String(p.currency_code),
    }))
  );
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** The printable page, from rows already read as the user. */
function renderInvoice(
  invoice: PrintInvoice,
  entity: Entity | null,
  payments: { amount: number; currency: string }[]
): string {
  const money = (amount: number) =>
    new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: invoice.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);

  const sale = invoice.invoice_type === 'SALE';
  const gross = Number(invoice.gross_amount);
  const tax = Number(invoice.tax_amount);
  const lines = [...(invoice.invoice_line_items ?? [])]
    .map(l => ({ ...l, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const linesTotal = lines.reduce((sum, l) => sum + l.quantity * l.unit_cost, 0);
  const partOfLines = lines.length > 0 && Math.abs(linesTotal - gross) >= 0.01;

  // Paid so far, counting payments in the invoice's currency (others cannot be compared).
  const paid =
    invoice.status === 'PAID'
      ? gross
      : payments.filter(p => p.currency === invoice.currency).reduce((s, p) => s + p.amount, 0);
  const due = ['OPEN', 'OVERDUE', 'PARTIALLY_PAID'].includes(invoice.status)
    ? Math.max(0, gross - paid)
    : null;

  const business = entity?.legal_name || entity?.name || 'Our business';
  const businessLines = [
    entity?.legal_name && entity.name !== entity.legal_name ? `Trading as ${entity.name}` : null,
    entity?.company_number ? `Company number ${entity.company_number}` : null,
    entity?.vat_number ? `VAT number ${entity.vat_number}` : null,
    entity?.country ?? null,
  ].filter((l): l is string => !!l);

  const c = invoice.contacts;
  const party = c?.company_name || c?.name || 'Unknown';
  const partyLines = [
    c?.company_name && c.name !== c.company_name ? c.name : null,
    c?.address_line_1,
    c?.address_line_2,
    [c?.city, c?.region, c?.postal_code].filter(Boolean).join(', ') || null,
    c?.country,
    c?.email,
    c?.phone,
  ].filter((l): l is string => !!l);

  const block = (title: string, name: string, rest: string[]) => `
    <div>
      <h3>${escapeHtml(title)}</h3>
      <div class="name">${escapeHtml(name)}</div>
      ${rest.map(l => `<div>${escapeHtml(l)}</div>`).join('')}
    </div>`;

  const from = sale ? block('From', business, businessLines) : block('From', party, partyLines);
  const to = sale ? block('Bill to', party, partyLines) : block('Bill to', business, businessLines);

  const facts = [
    ['Invoice', invoice.invoice_number],
    ['Issued', formatDate(invoice.invoice_date)],
    ...(invoice.due_date ? [['Due', formatDate(invoice.due_date)]] : []),
    ['Status', STATUS_LABEL[invoice.status] ?? invoice.status],
  ];

  const lineRows = lines
    .map(
      l => `
      <tr>
        <td>${escapeHtml(l.description)}</td>
        <td class="num">${escapeHtml(new Intl.NumberFormat('en-GB').format(l.quantity))}</td>
        <td class="num">${escapeHtml(money(l.unit_cost))}</td>
        <td class="num">${escapeHtml(money(l.quantity * l.unit_cost))}</td>
      </tr>`
    )
    .join('');

  const totals = [
    ...(partOfLines ? [['Lines total', money(linesTotal), 'muted']] : []),
    ...(tax > 0 ? [['VAT', money(tax), '']] : []),
    [partOfLines ? 'Amount requested' : 'Total', money(gross), 'grand'],
    ...(paid > 0 && invoice.status !== 'PAID' ? [['Paid', money(paid), '']] : []),
    ...(due !== null ? [['Amount due', money(due), 'grand']] : []),
  ]
    .map(
      ([label, value, cls]) =>
        `<tr class="${cls}"><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(value)}</td></tr>`
    )
    .join('');

  const provenance =
    invoice.origin === 'revolut_merchant'
      ? 'Sent as a payment request through Revolut. This copy is printed by ThreadWise from the ' +
        'request; Revolut’s own copy is in Revolut Business.'
      : invoice.origin === 'revolut_expense'
        ? 'Read by ThreadWise from a receipt attached to a Revolut payment. The receipt is the ' +
          'original.'
        : 'Printed by ThreadWise from the invoice as recorded.';

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>Invoice ${escapeHtml(invoice.invoice_number)} — ${escapeHtml(sale ? party : business)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 820px; margin: 0 auto; padding: 40px 32px; color: #111; background: #fff;
    line-height: 1.5; font-size: 13px;
  }
  h1 { font-size: 26px; margin: 0; letter-spacing: -.01em; }
  h3 { font-size: 11px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 28px; }
  .facts { display: grid; grid-template-columns: auto auto; gap: 2px 16px; text-align: right; }
  .facts dt { color: #555; }
  .facts dd { margin: 0; font-variant-numeric: tabular-nums; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
  .name { font-weight: 600; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; }
  thead td { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: .05em;
             border-bottom: 1px solid #333; padding-bottom: 6px; }
  td { padding: 7px 0; vertical-align: top; border-bottom: 1px solid #eee; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 120px; padding-left: 12px; }
  .totals { width: 50%; margin: 16px 0 0 auto; }
  .totals td { border-bottom: none; padding: 4px 0; }
  .totals tr.grand td { font-weight: 700; font-size: 15px; border-top: 2px solid #111; padding-top: 8px; }
  .totals tr.muted td { color: #777; }
  .note { margin-top: 20px; padding: 10px 14px; border-left: 3px solid #999; background: #f7f7f7; color: #333; }
  .foot { margin-top: 36px; padding-top: 14px; border-top: 1px solid #ddd; font-size: 11px; color: #777; }
  @media print { body { padding: 0; } tr { break-inside: avoid; } }
</style>
</head>
<body>

<div class="head">
  <h1>Invoice</h1>
  <dl class="facts">
    ${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}
  </dl>
</div>

<div class="parties">${from}${to}</div>

${
  lines.length > 0
    ? `<table>
  <thead><tr><td>Description</td><td class="num">Qty</td><td class="num">Unit price</td><td class="num">Amount</td></tr></thead>
  <tbody>${lineRows}</tbody>
</table>`
    : ''
}

<table class="totals"><tbody>${totals}</tbody></table>

${
  partOfLines
    ? `<p class="note">This request is for ${escapeHtml(money(gross))} of the ${escapeHtml(money(linesTotal))} the lines above add up to.</p>`
    : ''
}

<div class="foot">${escapeHtml(provenance)}</div>

<script>
  if (!window.location.search.includes('noprint')) {
    window.addEventListener('load', () => setTimeout(() => window.print(), 400));
  }
</script>

</body>
</html>`;
}
