/**
 * Collection plan — printable pack
 *
 * A collection's plan (product lines, other planned costs, projected P&L,
 * and any brand-collaboration terms) as a single printable document — for
 * sending to a collaboration partner, or for an internal pre-launch
 * sign-off. Same pattern as api.reports.cash-flow-pack.tsx: opens straight
 * into the print dialog, no PDF library, no server-side rendering pipeline.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { fetchFxRate } from '~/lib/api/collection-plans.server';
import { getPackData } from '~/lib/api/collections.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';
import { collaborationTypeLabel, computeScenarios, getCustomTerms } from '~/lib/collection-plans';

const formatMoney = (value: number, currency: string) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

// Partner currency is a free-typed 3-letter code, not validated against the
// real ISO 4217 list at save time — Intl.NumberFormat throws on a typo'd or
// unsupported one, so fall back to a plain "CODE amount" rather than break
// the whole document over a formatting nicety.
const formatMoneySafe = (value: number, currency: string) => {
  try {
    return formatMoney(value, currency);
  } catch {
    return `${currency} ${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
};

const formatDate = (value: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const collectionId = url.searchParams.get('collection');
  const showScenarios = url.searchParams.get('scenarios') === '1';

  if (!collectionId) {
    return new Response('Missing ?collection= parameter', { status: 400 });
  }

  const data = await getPackData(getRequestSupabaseClient(request), collectionId);
  if (!data) {
    return new Response('Collection not found', { status: 404 });
  }

  const { collection, planData, entityName } = data;

  if (!planData) {
    const html = `<!doctype html>
<html lang="en-GB">
<head><meta charset="utf-8"><title>${escapeHtml(collection.name)} — Plan</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 80px auto; text-align: center; color: #444;">
  <h1 style="font-size: 18px; color: #111;">${escapeHtml(collection.name)}</h1>
  <p>No plan has been started for this collection yet.</p>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const { plan, lines, costs, projections } = planData;
  const currency = plan.currency || 'GBP';
  const GBP = (value: number) => formatMoney(value, currency);
  const isCollab = plan.collaborationType !== 'in_house';

  const fxRate =
    plan.partnerCurrency && plan.partnerCurrency !== currency
      ? await fetchFxRate(currency, plan.partnerCurrency)
      : null;

  // Renders "£4,250.00 (≈ $5,616 — 10 Oct 2026, indicative)" for a
  // partner-side amount when a live rate is available, otherwise just the
  // plain base-currency figure.
  const withPartnerFx = (value: number) => {
    const base = GBP(value);
    if (!fxRate) return base;
    return `${base} <span class="muted">(≈ ${formatMoneySafe(value * fxRate.rate, fxRate.targetCurrency)})</span>`;
  };

  const lineRows = lines
    .map(line => {
      const sellThrough = Math.max(0, Math.min(100, line.expectedSellThroughPct)) / 100;
      const giftedUnits = Math.max(0, Math.min(line.plannedQuantity, line.giftedUnits));
      const sellableUnits = line.plannedQuantity - giftedUnits;
      const projRevenue = sellableUnits * sellThrough * line.unitSellingPrice;
      const projCogs = line.plannedQuantity * line.unitCost;
      const unitCostCell =
        line.unitCostCurrency && line.unitCostOriginal != null
          ? `${GBP(line.unitCost)} <span class="muted">(≈ ${formatMoneySafe(line.unitCostOriginal, line.unitCostCurrency)})</span>`
          : GBP(line.unitCost);
      return `
      <tr>
        <td>${escapeHtml(line.linkedProductName || line.productName || 'Unnamed product')}</td>
        <td class="num">${line.plannedQuantity}</td>
        <td class="num">${giftedUnits > 0 ? giftedUnits : '—'}</td>
        <td class="num">${unitCostCell}</td>
        <td class="num">${GBP(line.unitSellingPrice)}</td>
        <td class="num">${line.expectedSellThroughPct}%</td>
        <td class="num bold">${GBP(projRevenue)}</td>
        <td class="num bold">${GBP(projCogs)}</td>
      </tr>`;
    })
    .join('');

  const costRows = costs
    .map(
      cost => `
      <tr>
        <td class="cap">${escapeHtml(cost.costCategory.replace(/_/g, ' '))}</td>
        <td>${escapeHtml(cost.description || '—')}</td>
        <td class="num">${
          cost.plannedAmount != null
            ? `${GBP(cost.plannedAmount)}${cost.isEstimated ? ' <span class="muted">(estimated)</span>' : ''}`
            : '<span class="muted">To be determined</span>'
        }</td>
      </tr>`
    )
    .join('');

  // custom_terms is an array, not a scalar — rendered as its own rows
  // below rather than through the generic Object.entries loop, which
  // would otherwise stringify it as "[object Object],[object Object]".
  const metadataRows = Object.entries(plan.metadata || {})
    .filter(
      ([key, value]) =>
        key !== 'custom_terms' && value !== null && value !== undefined && value !== ''
    )
    .map(
      ([key, value]) => `
      <tr>
        <td class="indent">${escapeHtml(key.replace(/_/g, ' '))}</td>
        <td class="num">${escapeHtml(String(value))}</td>
      </tr>`
    )
    .concat(
      getCustomTerms(plan.metadata).map(
        term => `
      <tr>
        <td class="indent">${escapeHtml(term.label)}</td>
        <td class="num">${escapeHtml(term.value)}</td>
      </tr>`
      )
    )
    .join('');

  const scenarioSection = (() => {
    if (!showScenarios) return '';

    const scenarios = computeScenarios(
      plan.collaborationType,
      entityName,
      plan.partnerName,
      plan.metadata,
      lines,
      costs
    );

    const metricRow = (
      label: string,
      getter: (p: (typeof scenarios)[number]['projections']) => string
    ) =>
      `<tr><td>${label}</td>${scenarios.map(s => `<td class="num">${getter(s.projections)}</td>`).join('')}</tr>`;

    // Same set of parties should appear in every scenario (the split
    // mechanics don't change, only the amounts) — order from the base case.
    const allParties = Array.from(
      new Set(scenarios.flatMap(s => s.projections.payouts.map(p => p.party)))
    );
    const payoutRows = allParties
      .map(party => {
        const cells = scenarios
          .map(s => {
            const payout = s.projections.payouts.find(p => p.party === party);
            if (!payout) return `<td class="num">—</td>`;
            return `<td class="num">${payout.isPartner ? withPartnerFx(payout.amount) : GBP(payout.amount)}</td>`;
          })
          .join('');
        return `<tr><td class="bold">${escapeHtml(party)}</td>${cells}</tr>`;
      })
      .join('');

    return `
<h2>Scenario comparison</h2>
<p style="font-size:12px;color:#666;margin-bottom:10px;">
  Automatic variance bands applied to sell-through, unit cost, selling price, and any
  collaboration split — not specific numbers you entered. A guide to how sensitive this
  plan is to its assumptions, not a forecast.
</p>
<table>
  <thead>
    <tr><th></th>${scenarios.map(s => `<th>${escapeHtml(s.preset.label)}</th>`).join('')}</tr>
    <tr>
      <td class="indent" style="font-size:10px;">Assumptions</td>
      ${scenarios.map(s => `<td class="indent" style="font-size:10px;">${escapeHtml(s.preset.description)}</td>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${metricRow('Projected revenue', p => GBP(p.projectedRevenue))}
    ${metricRow('Projected total cost', p => GBP(p.projectedTotalCost))}
    <tr>
      <td class="bold">Projected net profit</td>
      ${scenarios.map(s => `<td class="num bold">${GBP(s.projections.projectedNetProfit)}</td>`).join('')}
    </tr>
    ${metricRow('Net margin', p => `${p.projectedNetMarginPct.toFixed(1)}%`)}
    ${
      isCollab
        ? metricRow(`${plan.partnerName || 'Partner'} needs to pay`, p =>
            p.partnerPaymentDue?.amount != null ? withPartnerFx(p.partnerPaymentDue.amount) : '—'
          )
        : ''
    }
    ${
      plan.collaborationType === 'co_branded'
        ? metricRow('Your upfront cash outlay', p =>
            p.entityUpfrontCost != null ? GBP(p.entityUpfrontCost) : '—'
          )
        : ''
    }
    ${
      payoutRows
        ? `<tr><td colspan="${scenarios.length + 1}" style="padding-top:10px;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em;">Who gets paid</td></tr>${payoutRows}`
        : ''
    }
  </tbody>
</table>
${
  fxRate
    ? `<p style="font-size:11px;color:#777;margin-top:6px;">Partner-currency figures above use the same live rate (1 ${fxRate.baseCurrency} = ${fxRate.rate.toFixed(4)} ${fxRate.targetCurrency}, as of ${escapeHtml(fxRate.asOf)}) across every scenario — indicative, not a settlement rate.</p>`
    : ''
}`;
  })();

  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>${escapeHtml(collection.name)} — Collection Plan</title>
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
  .tags { margin-bottom: 18px; }
  .tag { display: inline-block; border: 1px solid #ddd; border-radius: 999px; padding: 3px 10px;
         font-size: 11px; color: #555; margin-right: 6px; text-transform: capitalize; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 7px 8px; text-align: left; vertical-align: top; }
  th { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .04em;
       border-bottom: 1px solid #ddd; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.bold { font-weight: 700; }
  td.cap { text-transform: capitalize; }
  td.indent { color: #444; }
  .muted { color: #888; font-weight: 400; }
  tr { border-bottom: 1px solid #eee; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 8px; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 12px 14px; }
  .card h3 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase;
             letter-spacing: .05em; color: #666; }
  .card .big { font-size: 18px; font-weight: 700; }
  .callout { border: 1px solid #ddd; border-left: 3px solid #8b5cf6; border-radius: 4px;
             padding: 11px 14px; margin: 14px 0; font-size: 12px; color: #444; background: #faf8ff; }
  .callout strong { color: #111; }
  .callout-pay { border-left-color: #10b981; background: #f0fdf7; }
  .callout-pay.due-none { border-left-color: #ccc; background: #fafafa; }
  .callout-pay .amount { font-size: 20px; font-weight: 700; color: #111; margin: 2px 0 4px; }
  .callout-cash { border-left-color: #f59e0b; background: #fffbeb; }
  .callout-cash .amount { font-size: 20px; font-weight: 700; color: #111; margin: 2px 0 4px; }
  .foot { margin-top: 32px; padding-top: 14px; border-top: 1px solid #ddd;
          font-size: 11px; color: #777; }
  @media print { body { padding: 0; } .noprint { display: none; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style>
</head>
<body>

<h1>${escapeHtml(collection.name)} — Collection Plan</h1>
<p class="sub">
  ${escapeHtml(collaborationTypeLabel(plan.collaborationType))}${plan.partnerName ? ` · Partner: ${escapeHtml(plan.partnerName)}` : ''}
  · Launch ${formatDate(collection.launchDate)} · prepared ${formatDate(new Date().toISOString())}
</p>
<div class="tags">
  <span class="tag">${escapeHtml(collection.status)}</span>
  ${collection.collectionType ? `<span class="tag">${escapeHtml(collection.collectionType)}</span>` : ''}
</div>

<div class="cards">
  <div class="card"><h3>Projected revenue</h3><div class="big">${GBP(projections.projectedRevenue)}</div></div>
  <div class="card"><h3>Projected cost</h3><div class="big">${GBP(projections.projectedTotalCost)}</div></div>
  <div class="card"><h3>Projected net profit</h3><div class="big">${GBP(projections.projectedNetProfit)}</div></div>
  <div class="card"><h3>Net margin</h3><div class="big">${projections.projectedNetMarginPct.toFixed(1)}%</div></div>
</div>

${
  projections.partnerPaymentDue
    ? `<div class="callout callout-pay${projections.partnerPaymentDue.amount == null ? ' due-none' : ''}">
        <strong>${escapeHtml(plan.partnerName || 'Partner')} needs to pay</strong>
        <div class="amount">${
          projections.partnerPaymentDue.amount != null
            ? withPartnerFx(projections.partnerPaymentDue.amount)
            : 'Nothing, right now'
        }</div>
        ${escapeHtml(projections.partnerPaymentDue.basis)}
      </div>`
    : ''
}

${
  projections.entityUpfrontCost != null
    ? `<div class="callout callout-cash">
        <strong>Your upfront cash outlay</strong>
        <div class="amount">${GBP(projections.entityUpfrontCost)}</div>
        ${
          projections.entityUpfrontCost === projections.projectedTotalCost
            ? "The full planned cost — their share isn't paid in upfront, so you're fronting all of it until revenue settles."
            : 'Your own cost-split share — the partner is covering theirs separately, upfront.'
        }
      </div>`
    : ''
}

${
  projections.payouts.length > 0
    ? `<h2>Who gets paid</h2>
      <table>
        <thead><tr><th>Party</th><th>Basis</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${projections.payouts
            .map(
              payout => `
            <tr>
              <td class="bold">${escapeHtml(payout.party)}</td>
              <td class="indent">${escapeHtml(payout.basis)}</td>
              <td class="num bold">${payout.isPartner ? withPartnerFx(payout.amount) : GBP(payout.amount)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <p style="font-size:11px;color:#777;margin-top:6px;">
        Estimates from the split/terms below — not a full settlement calculation.
        ${
          fxRate
            ? ` Converted at the live rate 1 ${fxRate.baseCurrency} = ${fxRate.rate.toFixed(4)} ${fxRate.targetCurrency}, as of ${escapeHtml(fxRate.asOf)} — indicative of today's rate, not a settlement rate.`
            : plan.partnerCurrency
              ? ` A live rate for ${escapeHtml(plan.partnerCurrency)} wasn't available when this was generated.`
              : ''
        }
      </p>`
    : ''
}

${
  isCollab
    ? `<div class="callout">
        <strong>Collaboration terms (${escapeHtml(collaborationTypeLabel(plan.collaborationType))}).</strong>
        ${metadataRows ? '' : 'No terms recorded yet.'}
      </div>
      ${metadataRows ? `<table>${metadataRows}</table>` : ''}`
    : ''
}

<h2>Product lines</h2>
<table>
  <thead>
    <tr>
      <th>Product</th><th class="num">Qty</th><th class="num">Gifted</th><th class="num">Unit cost</th>
      <th class="num">Sell price</th><th class="num">Sell-through</th>
      <th class="num">Proj. revenue</th><th class="num">Proj. COGS</th>
    </tr>
  </thead>
  <tbody>${lineRows || '<tr><td colspan="8" style="color:#888;">No product lines yet.</td></tr>'}</tbody>
</table>

<h2>Other planned costs</h2>
<table>
  <thead><tr><th>Category</th><th>Description</th><th class="num">Amount</th></tr></thead>
  <tbody>${costRows || '<tr><td colspan="3" style="color:#888;">No other costs planned yet.</td></tr>'}</tbody>
</table>

<h2>Projected P&amp;L</h2>
<table>
  <tbody>
    <tr><td>Projected revenue</td><td class="num">${GBP(projections.projectedRevenue)}</td></tr>
    <tr><td>Product cost (COGS)</td><td class="num">${GBP(projections.projectedProductCost)}</td></tr>
    <tr><td class="bold">Gross profit</td><td class="num bold">${GBP(projections.projectedGrossProfit)}</td></tr>
    <tr><td>Other planned costs</td><td class="num">${GBP(projections.projectedOtherCost)}</td></tr>
    <tr><td class="bold">Net profit</td><td class="num bold">${GBP(projections.projectedNetProfit)}</td></tr>
  </tbody>
</table>
${
  projections.costsPendingCount > 0
    ? `<p style="font-size:11px;color:#777;margin-top:6px;">${projections.costsPendingCount} cost${projections.costsPendingCount === 1 ? '' : 's'} above ${projections.costsPendingCount === 1 ? 'is' : 'are'} still to be determined and not yet included in these totals — see Other planned costs.</p>`
    : ''
}
${
  projections.costsEstimatedCount > 0
    ? `<p style="font-size:11px;color:#777;margin-top:6px;">${projections.costsEstimatedCount} cost${projections.costsEstimatedCount === 1 ? '' : 's'} above ${projections.costsEstimatedCount === 1 ? 'is a rough estimate' : 'are rough estimates'}, not a firm quote — included in these totals, but may change.</p>`
    : ''
}

${scenarioSection}

${plan.notes ? `<h2>Notes</h2><p style="font-size:13px;color:#333;">${escapeHtml(plan.notes)}</p>` : ''}

<div class="foot">
  Generated by ThreadWise. All figures are planning projections, not actuals — COGS is charged on
  every unit planned for production; revenue only on the share expected to sell.
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
