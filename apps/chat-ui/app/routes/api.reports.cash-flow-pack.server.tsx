/**
 * Cash Flow Report — printable pack
 *
 * The cash flow statement, its reconciliation, and the cash insights as a
 * single printable document, for sending to an accountant, a lender, or an
 * investor. Opens with the print dialog so "save as PDF" is the obvious next
 * step — no PDF library, no server-side rendering pipeline.
 *
 * It carries the same reconciliation and coverage disclosures as the page. A
 * report that quietly drops the caveats would be more dangerous than useful
 * precisely because it is the version that gets forwarded to other people.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getReportsData } from '~/lib/api/reports.server';
import type { CashFlowLine } from '~/lib/api/reports.server';

const GBP = (value: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const formatDate = (value: string) => {
  const date = new Date(value);
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
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const data = await getReportsData(from, to);
  const { cashFlow, cashInsights } = data;

  const periodLabel =
    from || to
      ? `${from ? formatDate(`${from}T00:00:00Z`) : 'the beginning'} – ${
          to ? formatDate(`${to}T00:00:00Z`) : 'today'
        }`
      : 'All activity to date';

  const row = (
    label: string,
    value: string,
    opts: { bold?: boolean; indent?: boolean; muted?: boolean } = {}
  ) => `
    <tr class="${opts.bold ? 'bold' : ''}">
      <td class="${opts.indent ? 'indent' : ''} ${opts.muted ? 'muted' : ''}">${escapeHtml(label)}</td>
      <td class="num ${opts.muted ? 'muted' : ''}">${escapeHtml(value)}</td>
    </tr>`;

  const section = (title: string, lines: CashFlowLine[], total: number, totalLabel: string) => {
    if (lines.length === 0) return '';
    return `
      <tr><td class="section" colspan="2">${escapeHtml(title)}</td></tr>
      ${lines
        .map(line =>
          row(
            line.accountNumber ? `${line.accountNumber} · ${line.label}` : line.label,
            GBP(line.amount),
            { indent: true }
          )
        )
        .join('')}
      ${row(totalLabel, GBP(total), { bold: true })}`;
  };

  // The chart on screen becomes a table here: the same numbers, legible in
  // print and in black and white.
  const maxAbs = Math.max(
    1,
    ...cashInsights.monthly.map(month => Math.abs(month.operating))
  );
  const monthlyRows = cashInsights.monthly
    .map(month => {
      const pct = (Math.abs(month.operating) / maxAbs) * 100;
      const positive = month.operating >= 0;
      return `
        <tr>
          <td class="mono">${escapeHtml(month.label)}${month.isPartial ? ' <span class="muted">(in progress)</span>' : ''}</td>
          <td class="bar-cell">
            <span class="bar ${positive ? 'pos' : 'neg'}" style="width:${pct.toFixed(1)}%"></span>
          </td>
          <td class="num ${positive ? 'pos-text' : 'neg-text'}">${GBP(month.operating)}</td>
          <td class="num muted">${month.financing !== 0 ? GBP(month.financing) : '—'}</td>
          <td class="num">${GBP(month.net)}</td>
        </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>Cash Flow Report — ${escapeHtml(periodLabel)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 860px; margin: 0 auto; padding: 40px 32px; color: #111; background: #fff;
    line-height: 1.5;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 30px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  .sub { color: #666; font-size: 13px; margin: 0 0 22px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 5px 0; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 120px; }
  td.section { padding-top: 14px; font-size: 11px; text-transform: uppercase;
               letter-spacing: .05em; color: #666; font-weight: 600; }
  tr.bold td { font-weight: 700; border-top: 1px solid #333; padding-top: 8px; }
  td.indent { padding-left: 20px; color: #444; }
  td.muted { color: #888; }
  td.mono { font-variant-numeric: tabular-nums; white-space: nowrap; width: 150px; padding-right: 12px; }
  .grand td { font-weight: 700; border-top: 2px solid #111; border-bottom: 2px solid #111; padding: 9px 0; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 8px; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 14px 16px; }
  .card h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase;
             letter-spacing: .05em; color: #666; }
  .card .big { font-size: 22px; font-weight: 700; }
  .card p { margin: 6px 0 0; font-size: 12px; color: #444; }
  .verdict-generating { color: #0a7c42; }
  .verdict-consuming { color: #b3261e; }
  .verdict-breakeven { color: #9a6700; }
  .bar-cell { width: auto; padding-right: 10px; }
  .bar { display: inline-block; height: 9px; border-radius: 2px; vertical-align: middle; }
  .bar.pos { background: #34a853; }
  .bar.neg { background: #d93025; }
  .pos-text { color: #0a7c42; }
  .neg-text { color: #b3261e; }
  .callout { border: 1px solid #ddd; border-left: 3px solid #999; border-radius: 4px;
             padding: 11px 14px; margin: 14px 0; font-size: 12px; color: #444; }
  .callout.warn { border-left-color: #d09000; background: #fffaf0; }
  .callout.ok { border-left-color: #34a853; background: #f4fbf6; }
  .callout strong { color: #111; }
  .foot { margin-top: 32px; padding-top: 14px; border-top: 1px solid #ddd;
          font-size: 11px; color: #777; }
  thead td { font-size: 11px; color: #666; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  @media print { body { padding: 0; } .noprint { display: none; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style>
</head>
<body>

<h1>Cash Flow Report</h1>
<p class="sub">${escapeHtml(periodLabel)} · prepared ${formatDate(new Date().toISOString())}</p>

<div class="cards">
  <div class="card">
    <h3>Cash health</h3>
    <div class="big verdict-${escapeHtml(cashInsights.verdict)}">${escapeHtml(cashInsights.verdictHeadline)}</div>
    <p>${escapeHtml(cashInsights.verdictDetail)}</p>
  </div>
  <div class="card">
    <h3>Safe to spend</h3>
    <div class="big">${GBP(cashInsights.safeToSpend)}</div>
    <p>Of ${GBP(cashInsights.cashOnHand)} held. After tax already accrued, unpaid bills, and a
       buffer the size of the worst trading month in the last year.</p>
  </div>
</div>

<h2>Safe to spend — derivation</h2>
<table>
  ${cashInsights.safeToSpendLines
    .map((line, index) =>
      row(line.label, GBP(line.amount), { indent: index > 0, bold: index === 0 })
    )
    .join('')}
  <tr class="grand"><td>Safe to spend</td><td class="num">${GBP(cashInsights.safeToSpend)}</td></tr>
</table>
${cashInsights.safeToSpendLines
  .filter(line => line.amount !== 0 || line.label.includes('bad month'))
  .map(line => `<p style="font-size:11px;color:#777;margin:6px 0 0;"><strong>${escapeHtml(line.label)}:</strong> ${escapeHtml(line.detail)}</p>`)
  .join('')}

<h2>Monthly operating cash</h2>
<table>
  <thead>
    <tr><td>Month</td><td></td><td class="num">Trading</td><td class="num">Funding in</td><td class="num">Net</td></tr>
  </thead>
  <tbody>${monthlyRows}</tbody>
</table>
<p style="font-size:11px;color:#777;margin-top:8px;">
  Trading excludes money introduced by the director, so it shows the business standing on its own.
  Averages and the buffer above use complete months only.
</p>

<h2>Cash flow statement</h2>
<table>
  ${row('Opening cash', GBP(cashFlow.openingBalance), { bold: true })}
  ${section('Operating activities', cashFlow.operating, cashFlow.totalOperating, 'Net cash from operations')}
  ${section('Investing activities', cashFlow.investing, cashFlow.totalInvesting, 'Net cash from investing')}
  ${section('Financing activities', cashFlow.financing, cashFlow.totalFinancing, 'Net cash from financing')}
  ${section('Not yet categorised', cashFlow.unclassified, cashFlow.totalUnclassified, 'Total uncategorised')}
  <tr class="grand"><td>Net change in cash</td><td class="num">${GBP(cashFlow.netChange)}</td></tr>
  ${row('Closing cash (per bank)', GBP(cashFlow.closingBalancePerBank), { bold: true })}
</table>

<h2>Reconciliation</h2>
<table>
  ${row('Opening cash', GBP(cashFlow.openingBalance), { indent: true })}
  ${row('Net change in cash', GBP(cashFlow.netChange), { indent: true })}
  ${row('Expected closing cash', GBP(cashFlow.closingBalance), { bold: true })}
  ${row('Closing cash per bank', GBP(cashFlow.closingBalancePerBank), { indent: true })}
  ${row('Unexplained difference', GBP(cashFlow.reconciliationVariance), { bold: true })}
</table>

${
  cashFlow.reconciles
    ? `<div class="callout ok"><strong>The statement ties to the bank.</strong> Every pound that
       moved is accounted for in a category above.</div>`
    : `<div class="callout warn"><strong>The statement is out by ${GBP(Math.abs(cashFlow.reconciliationVariance))}.</strong>
       ${
         cashFlow.varianceIsMaterial
           ? 'Treat the figures above as indicative until this is resolved.'
           : 'This period contains a currency conversion whose opposite leg was excluded as noise, so the bank figure counts one side of it as an inflow. Too small to affect any decision.'
       }</div>`
}

${
  cashFlow.openingBalanceImplausible
    ? `<div class="callout warn"><strong>Bank history is incomplete.</strong> This all-time view
       implies an opening balance of ${GBP(cashFlow.openingBalance)}, but the business started from
       nothing. Transaction history doesn't reach back far enough to explain the bank's own
       earliest balance, so the earliest periods are understated by roughly this amount.</div>`
    : ''
}

${
  cashFlow.coverage.unjournalledTxns > 0
    ? `<div class="callout warn"><strong>${cashFlow.coverage.unjournalledTxns} of
       ${cashFlow.coverage.cashTxns} bank transactions aren't categorised yet.</strong>
       ${cashFlow.coverage.draftTxns > 0 ? `${cashFlow.coverage.draftTxns} have draft journals awaiting review. ` : ''}
       ${cashFlow.coverage.noJournalTxns > 0 ? `${cashFlow.coverage.noJournalTxns} have no journal at all. ` : ''}
       Their cash is included in the totals, but not attributed to a category.</div>`
    : ''
}

<div class="callout">
  <strong>What this document is.</strong> A cash flow statement prepared from the company's own
  bank transactions, with each movement categorised by the account on the other side of its
  journal entry. Cash means the bank accounts only — payment-processor balances are excluded
  because that money passes through the same bank account and would otherwise be counted twice.
  Safe-to-spend is a snapshot of cash held now, not a forecast: it doesn't know about stock about
  to be ordered, wages due, or invoices not yet entered.
</div>

<div class="foot">
  Generated by ThreadWise. Cash movement from bank transactions; classification from posted
  journal entries. Internal transfers between the company's own accounts are netted out.
</div>

<script>
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
