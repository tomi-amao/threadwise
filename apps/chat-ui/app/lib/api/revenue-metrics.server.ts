export interface RevenueMetricOrder {
  id: string;
  raw_event_id: string | null;
  subtotal_amount: number | null;
  discount_total_amount: number | null;
  shipping_total_amount: number | null;
  tax_total_amount: number | null;
  grand_total_amount: number | null;
  refunded_total_amount: number | null;
  status: string | null;
  created_at: string | null;
}

interface PaymentFeeRow {
  net_fee: number | null;
}

export interface RevenueMetricPayment {
  id: string;
  order_id: string | null;
  provider: string | null;
  gateway: string | null;
  payment_method: string | null;
  amount: number | null;
  base_amount: number | null;
  net_amount: number | null;
  status: string | null;
  paid_on: string | null;
  payment_fees: PaymentFeeRow[] | null;
}

export interface RevenueMetricsSnapshot {
  grossRevenue: number;
  grossSales: number;
  discounts: number;
  netSales: number;
  shippingCollected: number;
  shippingDiscounts: number;
  shippingRefunds: number;
  taxCollected: number;
  refunds: number;
  returns: number;
  totalSales: number;
  processingFees: number;
  netRevenue: number;
  orderCount: number;
  avgOrderValue: number;
}

export interface RevenueMetricsMonthlySnapshot {
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  shippingCollected: number;
  taxCollected: number;
  totalSales: number;
  processingFees: number;
  orderCount: number;
}

export interface RevenueMetricsData {
  orders: RevenueMetricOrder[];
  payments: RevenueMetricPayment[];
  monthly: Record<string, RevenueMetricsMonthlySnapshot>;
  returnsByMonth: Record<string, number>;
  snapshot: RevenueMetricsSnapshot;
}

interface RevenueMetricsOptions {
  from?: string | null;
  to?: string | null;
}

function dateGte(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function dateLte(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getShippingDiscountFromPayload(payload: any): number {
  const shippingLines = Array.isArray(payload?.shipping_lines) ? payload.shipping_lines : [];
  let total = 0;

  for (const shippingLine of shippingLines) {
    const allocations = Array.isArray(shippingLine?.discount_allocations)
      ? shippingLine.discount_allocations
      : [];
    for (const allocation of allocations) {
      total += Math.abs(toNumber(allocation?.amount ?? allocation?.amount_set?.shop_money?.amount));
    }
  }

  return total;
}

function getShippingRefundFromPayload(payload: any): number {
  const refunds = Array.isArray(payload?.refunds) ? payload.refunds : [];
  let total = 0;

  for (const refund of refunds) {
    const adjustments = Array.isArray(refund?.order_adjustments) ? refund.order_adjustments : [];
    for (const adjustment of adjustments) {
      if (adjustment?.kind !== 'shipping_refund') continue;
      total += Math.abs(toNumber(adjustment?.amount ?? adjustment?.amount_set?.shop_money?.amount));
    }
  }

  return total;
}

function getPaymentAmount(payment: RevenueMetricPayment): number {
  return toNumber(payment.base_amount ?? payment.amount);
}

function addAmountToMonthMap(
  monthMap: Map<string, number>,
  timestamp: string | null | undefined,
  amount: number
) {
  if (!timestamp || amount === 0) return;
  const month = timestamp.substring(0, 7);
  monthMap.set(month, (monthMap.get(month) || 0) + amount);
}

function getShippingRefundsByMonthFromPayload(payload: any): Map<string, number> {
  const refunds = Array.isArray(payload?.refunds) ? payload.refunds : [];
  const monthMap = new Map<string, number>();

  for (const refund of refunds) {
    const adjustments = Array.isArray(refund?.order_adjustments) ? refund.order_adjustments : [];
    for (const adjustment of adjustments) {
      if (adjustment?.kind !== 'shipping_refund') continue;
      addAmountToMonthMap(
        monthMap,
        refund?.created_at,
        Math.abs(toNumber(adjustment?.amount ?? adjustment?.amount_set?.shop_money?.amount))
      );
    }
  }

  return monthMap;
}

export async function getRevenueMetricsData(
  supabase: any,
  { from = null, to = null }: RevenueMetricsOptions = {}
): Promise<RevenueMetricsData> {
  let ordersQ = supabase
    .from('orders')
    .select(
      'id, raw_event_id, subtotal_amount, discount_total_amount, shipping_total_amount, tax_total_amount, grand_total_amount, refunded_total_amount, status, created_at'
    )
    .neq('status', 'cancelled')
    .limit(10000);
  if (from) ordersQ = ordersQ.gte('created_at', dateGte(from));
  if (to) ordersQ = ordersQ.lte('created_at', dateLte(to));

  let paymentsQ = supabase
    .from('payments')
    .select(
      'id, order_id, provider, gateway, payment_method, amount, base_amount, net_amount, status, paid_on, payment_fees(net_fee)'
    )
    .limit(10000);
  if (from) paymentsQ = paymentsQ.gte('paid_on', dateGte(from));
  if (to) paymentsQ = paymentsQ.lte('paid_on', dateLte(to));

  const [{ data: ordersData }, { data: paymentsData }] = await Promise.all([ordersQ, paymentsQ]);

  const orders = (ordersData || []) as RevenueMetricOrder[];
  const payments = (paymentsData || []) as RevenueMetricPayment[];

  const rawEventIds = Array.from(
    new Set(
      orders.map(order => order.raw_event_id).filter((value): value is string => Boolean(value))
    )
  );

  let rawEvents: Array<{ id: string; payload: any }> = [];
  if (rawEventIds.length > 0) {
    const { data } = await supabase
      .from('external_raw_events')
      .select('id, payload')
      .in('id', rawEventIds);
    rawEvents = data || [];
  }

  const payloadById = new Map(rawEvents.map(event => [event.id, event.payload]));

  let subtotalAmount = 0;
  let totalDiscountAmount = 0;
  let shippingAmount = 0;
  let taxAmount = 0;
  let grossRevenue = 0;
  const subtotalByMonth = new Map<string, number>();
  const totalDiscountAmountByMonth = new Map<string, number>();
  const shippingAmountByMonth = new Map<string, number>();
  const taxAmountByMonth = new Map<string, number>();
  const orderCountByMonth = new Map<string, number>();
  let shippingDiscounts = 0;
  const shippingDiscountsByMonth = new Map<string, number>();
  let shippingRefunds = 0;
  const shippingRefundsByMonth = new Map<string, number>();

  for (const order of orders) {
    subtotalAmount += toNumber(order.subtotal_amount);
    totalDiscountAmount += toNumber(order.discount_total_amount);
    shippingAmount += toNumber(order.shipping_total_amount);
    taxAmount += toNumber(order.tax_total_amount);
    grossRevenue += toNumber(order.grand_total_amount);
    addAmountToMonthMap(subtotalByMonth, order.created_at, toNumber(order.subtotal_amount));
    addAmountToMonthMap(
      totalDiscountAmountByMonth,
      order.created_at,
      toNumber(order.discount_total_amount)
    );
    addAmountToMonthMap(
      shippingAmountByMonth,
      order.created_at,
      toNumber(order.shipping_total_amount)
    );
    addAmountToMonthMap(taxAmountByMonth, order.created_at, toNumber(order.tax_total_amount));
    addAmountToMonthMap(orderCountByMonth, order.created_at, 1);

    if (!order.raw_event_id) continue;
    const payload = payloadById.get(order.raw_event_id);
    if (!payload) continue;

    const shippingDiscount = getShippingDiscountFromPayload(payload);
    shippingDiscounts += shippingDiscount;
    addAmountToMonthMap(shippingDiscountsByMonth, order.created_at, shippingDiscount);
    shippingRefunds += getShippingRefundFromPayload(payload);
    const payloadShippingRefundsByMonth = getShippingRefundsByMonthFromPayload(payload);
    for (const [month, amount] of payloadShippingRefundsByMonth) {
      shippingRefundsByMonth.set(month, (shippingRefundsByMonth.get(month) || 0) + amount);
    }
  }

  let refundedCash = 0;
  let processingFees = 0;
  const processingFeesByMonth = new Map<string, number>();
  const refundedCashByMonth = new Map<string, number>();

  for (const payment of payments) {
    const paymentStatus = String(payment.status || '').toLowerCase();

    if (paymentStatus === 'captured' && Array.isArray(payment.payment_fees)) {
      for (const fee of payment.payment_fees) {
        const feeAmount = toNumber(fee?.net_fee);
        processingFees += feeAmount;
        addAmountToMonthMap(processingFeesByMonth, payment.paid_on, feeAmount);
      }
    }

    if (paymentStatus === 'refunded') {
      const paymentAmount = getPaymentAmount(payment);
      refundedCash += paymentAmount;
      addAmountToMonthMap(refundedCashByMonth, payment.paid_on, paymentAmount);
    }
  }

  const returnsByMonth: Record<string, number> = {};
  const returnMonths = new Set([...refundedCashByMonth.keys(), ...shippingRefundsByMonth.keys()]);
  for (const month of returnMonths) {
    returnsByMonth[month] = Math.max(
      (refundedCashByMonth.get(month) || 0) - (shippingRefundsByMonth.get(month) || 0),
      0
    );
  }

  const monthly: Record<string, RevenueMetricsMonthlySnapshot> = {};
  const monthlyMetricMonths = new Set([
    ...subtotalByMonth.keys(),
    ...totalDiscountAmountByMonth.keys(),
    ...shippingAmountByMonth.keys(),
    ...taxAmountByMonth.keys(),
    ...orderCountByMonth.keys(),
    ...shippingDiscountsByMonth.keys(),
    ...shippingRefundsByMonth.keys(),
    ...processingFeesByMonth.keys(),
    ...Object.keys(returnsByMonth),
  ]);

  for (const month of monthlyMetricMonths) {
    const monthDiscounts = Math.max(
      (totalDiscountAmountByMonth.get(month) || 0) - (shippingDiscountsByMonth.get(month) || 0),
      0
    );
    const monthReturns = returnsByMonth[month] || 0;
    const monthGrossSales = (subtotalByMonth.get(month) || 0) + monthDiscounts;
    const monthShippingCollected = Math.max(
      (shippingAmountByMonth.get(month) || 0) -
        (shippingDiscountsByMonth.get(month) || 0) -
        (shippingRefundsByMonth.get(month) || 0),
      0
    );
    const monthTaxCollected = taxAmountByMonth.get(month) || 0;
    const monthNetSales = monthGrossSales - monthDiscounts - monthReturns;

    monthly[month] = {
      grossSales: monthGrossSales,
      discounts: monthDiscounts,
      returns: monthReturns,
      netSales: monthNetSales,
      shippingCollected: monthShippingCollected,
      taxCollected: monthTaxCollected,
      totalSales: monthNetSales + monthShippingCollected + monthTaxCollected,
      processingFees: processingFeesByMonth.get(month) || 0,
      orderCount: orderCountByMonth.get(month) || 0,
    };
  }

  const discounts = Math.max(totalDiscountAmount - shippingDiscounts, 0);
  const returns = Math.max(refundedCash - shippingRefunds, 0);
  const shippingCollected = Math.max(shippingAmount - shippingDiscounts - shippingRefunds, 0);
  const grossSales = subtotalAmount + discounts;
  const netSales = grossSales - discounts - returns;
  const totalSales = netSales + shippingCollected + taxAmount;
  const orderCount = orders.length;

  return {
    orders,
    payments,
    monthly,
    returnsByMonth,
    snapshot: {
      grossRevenue,
      grossSales,
      discounts,
      netSales,
      shippingCollected,
      shippingDiscounts,
      shippingRefunds,
      taxCollected: taxAmount,
      refunds: refundedCash,
      returns,
      totalSales,
      processingFees,
      netRevenue: totalSales - processingFees,
      orderCount,
      avgOrderValue: orderCount > 0 ? grossRevenue / orderCount : 0,
    },
  };
}
