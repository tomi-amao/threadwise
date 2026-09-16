/**
 * CT600 Preparation Pack
 *
 * Renders the corporation tax computation for one accounting period as a
 * printable working paper, with each figure mapped to the CT600 box it feeds.
 *
 * This is deliberately NOT a CT600 return. It carries no HMRC branding and no
 * submission fields, because a document that looks like a filed return but
 * hasn't been through HMRC-recognised software (with iXBRL-tagged accounts)
 * is a liability rather than a help. What it does is remove the arithmetic and
 * the box-hunting, so filing — by the owner or their accountant — is typing,
 * not derivation.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getTaxData } from '~/lib/api/tax.server';

const GBP = (value: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const formatDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const periodId = url.searchParams.get('periodId');

  const data = await getTaxData();
  const period =
    data.periods.find(p => p.periodId === periodId) ??
    data.lastClosedPeriod ??
    data.periods[data.periods.length - 1];

  if (!period) {
    return new Response('No accounting period found', { status: 404 });
  }

  // Refuse to produce a pack for a period the ledger cannot support. A
  // computation is only worth handing to an accountant if the figures in it
  // are real; an empty or invented one is worse than none.
  if (!period.ledgerBasis) {
    return new Response(
      `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
       <title>No computation available</title>
       <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
       max-width:640px;margin:80px auto;padding:0 24px;color:#111;line-height:1.6}
       h1{font-size:18px}p{font-size:14px;color:#444}
       .box{border:1px solid #ddd;border-left:3px solid #d09000;background:#fffaf0;
       padding:14px 16px;border-radius:4px;font-size:13px}</style></head><body>
       <h1>No computation available for ${escapeHtml(period.label)}</h1>
       <div class="box">
         <p>This period predates reliable bookkeeping in this system, so there is nothing
         here that could be handed to an accountant with confidence.</p>
         <p>Its figures are in the accounts filed at Companies House and your
         accountant&rsquo;s records.${
           period.notes ? ` <strong>Note:</strong> ${escapeHtml(period.notes)}` : ''
         }</p>
       </div>
       </body></html>`,
      { status: 409, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // Past this point every figure is non-null: ledgerBasis periods always
  // carry a full computation.
  const f = (v: number | null) => v ?? 0;

  const adjustments = data.adjustmentsByPeriod[period.periodId] ?? [];
  const unresolved = data.reviewItems.filter(r => !r.resolved && r.periodId === period.periodId);

  const row = (
    label: string,
    value: string,
    opts: { box?: string; bold?: boolean; indent?: boolean; note?: string } = {}
  ) => `
    <tr class="${opts.bold ? 'bold' : ''}">
      <td class="${opts.indent ? 'indent' : ''}">
        ${escapeHtml(label)}
        ${opts.note ? `<span class="note">${escapeHtml(opts.note)}</span>` : ''}
      </td>
      <td class="box">${opts.box ? escapeHtml(opts.box) : ''}</td>
      <td class="num">${escapeHtml(value)}</td>
    </tr>`;

  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>CT600 Preparation Pack — ${escapeHtml(period.label)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 820px; margin: 0 auto; padding: 40px 32px; color: #111; background: #fff;
    line-height: 1.5;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 32px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  .sub { color: #666; font-size: 13px; margin: 0 0 24px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 13px;
          border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; margin-bottom: 8px; }
  .meta div { display: flex; justify-content: space-between; gap: 12px; }
  .meta .k { color: #666; }
  .meta .v { font-weight: 600; }
  .missing { color: #a15c00; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 6px 0; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 130px; }
  td.box { width: 90px; color: #888; font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
  tr.bold td { font-weight: 700; border-top: 1px solid #333; padding-top: 9px; }
  td.indent { padding-left: 22px; color: #444; }
  .note { display: block; color: #888; font-size: 11px; font-weight: 400; }
  .callout { border: 1px solid #ddd; border-left: 3px solid #999; border-radius: 4px;
             padding: 12px 14px; margin: 16px 0; font-size: 12px; color: #444; }
  .callout.warn { border-left-color: #d09000; background: #fffaf0; }
  .callout strong { color: #111; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { font-size: 12px; color: #444; margin: 3px 0; }
  .foot { margin-top: 36px; padding-top: 14px; border-top: 1px solid #ddd;
          font-size: 11px; color: #777; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style>
</head>
<body>

<h1>Corporation Tax Computation</h1>
<p class="sub">${escapeHtml(period.label)} · prepared ${formatDate(new Date().toISOString().slice(0, 10))}</p>

<div class="meta">
  <div><span class="k">Company</span><span class="v">${escapeHtml(data.entity.name)}</span></div>
  <div><span class="k">Period</span><span class="v">${formatDate(period.startDate)} – ${formatDate(period.endDate)}</span></div>
  <div><span class="k">Company number</span><span class="v ${data.entity.companyNumber ? '' : 'missing'}">${
    data.entity.companyNumber ? escapeHtml(data.entity.companyNumber) : 'not recorded'
  }</span></div>
  <div><span class="k">UTR</span><span class="v ${data.entity.taxReference ? '' : 'missing'}">${
    data.entity.taxReference ? escapeHtml(data.entity.taxReference) : 'not recorded'
  }</span></div>
  <div><span class="k">Payment due</span><span class="v">${formatDate(period.paymentDue)}</span></div>
  <div><span class="k">Return due</span><span class="v">${formatDate(period.filingDue)}</span></div>
</div>

${
  period.isProjection
    ? `<div class="callout warn"><strong>This period is still open.</strong> ${period.monthsElapsed} of
       ${period.monthsInPeriod} months have elapsed. These figures are a projection based on trading
       so far — not a final liability. Do not file from this pack.</div>`
    : ''
}

<h2>Computation</h2>
<table>
  ${row('Profit or loss per the accounts', GBP(f(period.accountingProfit)), { box: 'CT600 155' })}
  ${
    adjustments
      .filter(a => a.direction === 'add_back')
      .map(a => row(a.description, GBP(a.amount), { indent: true }))
      .join('') || ''
  }
  ${f(period.addBacks) > 0 ? row('Total disallowable expenditure added back', GBP(f(period.addBacks)), { bold: true }) : ''}
  ${
    adjustments
      .filter(a => a.direction === 'deduction')
      .map(a => row(a.description, `(${GBP(a.amount)})`, { indent: true }))
      .join('') || ''
  }
  ${row('Adjusted trading profit', GBP(f(period.adjustedProfit)), { bold: true })}
  ${
    f(period.lossReliefUsed) > 0
      ? row('Less: losses brought forward', `(${GBP(f(period.lossReliefUsed))})`, {
          indent: true,
          box: 'CT600 285',
        })
      : ''
  }
  ${row('Taxable total profits', GBP(f(period.taxableProfit)), { bold: true, box: 'CT600 315' })}
</table>

<h2>Tax charge</h2>
<table>
  ${
    f(period.taxableProfit) > 0
      ? row(
          `Corporation tax at ${(f(period.effectiveRate) * 100).toFixed(2)}%`,
          GBP(f(period.taxDue) + f(period.marginalRelief)),
          { box: 'CT600 475' }
        )
      : row('Corporation tax', GBP(0), { box: 'CT600 475', note: 'No taxable profit for the period' })
  }
  ${f(period.marginalRelief) > 0 ? row('Less: marginal relief', `(${GBP(f(period.marginalRelief))})`, { indent: true }) : ''}
  ${row('Corporation tax payable', GBP(f(period.taxDue)), { bold: true, box: 'CT600 525' })}
</table>

${
  f(period.lossCarriedForward) > 0
    ? `<h2>Losses</h2>
       <table>
         ${row('Losses carried forward to future periods', GBP(f(period.lossCarriedForward)), { box: 'CT600 805' })}
       </table>`
    : ''
}

${
  unresolved.length > 0
    ? `<div class="callout warn">
        <strong>${unresolved.length} item${unresolved.length === 1 ? '' : 's'} not yet reviewed.</strong>
        These accounts commonly hold disallowable spending and have not been adjusted, because the
        split depends on facts the ledger doesn't record. The taxable profit above may be understated
        until they're settled.
        <ul>
          ${unresolved
            .map(
              u =>
                `<li><strong>${escapeHtml(u.accountNumber)} ${escapeHtml(u.accountName)}</strong> — ${GBP(
                  u.amount
                )}. ${escapeHtml(u.guidance)}</li>`
            )
            .join('')}
        </ul>
       </div>`
    : ''
}

${
  data.entity.missingForFiling.length > 0
    ? `<div class="callout warn"><strong>Missing details required on the return:</strong>
        ${data.entity.missingForFiling.map(escapeHtml).join(', ')}.</div>`
    : ''
}

<div class="callout">
  <strong>What this document is.</strong> A tax computation prepared from the company's own
  accounting records, for review. It is not a CT600 return and has not been submitted to HMRC.
  Filing requires HMRC-recognised software and iXBRL-tagged statutory accounts. Box references are
  provided to speed up completion and may shift between CT600 versions — check them against the
  form you file. Have the figures reviewed by a qualified accountant before submission.
</div>

<div class="foot">
  Generated by ThreadWise from posted ledger entries for ${escapeHtml(period.label)}.
  Basis: accounting profit per the profit &amp; loss account, adjusted for disallowable items and
  losses brought forward. Assumes one associated company and no franked investment income.
</div>

<script>
  // Print dialog on open makes "save as PDF" the obvious next step.
  if (!window.location.search.includes('noprint')) {
    window.addEventListener('load', () => setTimeout(() => window.print(), 400));
  }
</script>

</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
