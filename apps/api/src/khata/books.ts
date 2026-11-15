import type { Tx } from '../db/db.service';

/**
 * The books for one month, from the business's own data only.
 *
 * Revenue has three sources, each counted once:
 *  - online:  payments Ledger recorded through Razorpay (payment links, invoices, deposits)
 *  - counter: other payments recorded in Orbit (bookings and invoices marked paid at the counter)
 *  - cash:    sales the owner or staff logged with Khata (cash, own UPI QR, card machine)
 * A booking paid by a payment link is one payment row, so it counts once.
 * Expenses are confirmed bills only. Profit = revenue - expenses, exactly.
 */
export interface Books {
  month: string;
  revenue: { online: number; counter: number; cash: number; total: number };
  expenses: { total: number; byCategory: { category: string; amount: number; count: number }[] };
  profit: number;
  gst: { paidOnBills: number; collected: number; bills: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** [start, end) of a local month as timestamps, and its dates. */
export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { firstDay: `${month}-01`, nextFirstDay: `${next}-01` };
}
export function prevMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function monthOf(date: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(date).slice(0, 7);
}

export async function books(tx: Tx, month: string, tz: string): Promise<Books> {
  const { firstDay, nextFirstDay } = monthBounds(month);
  const pay = await tx.one(
    `SELECT COALESCE(sum(amount) FILTER (WHERE provider = 'razorpay'), 0)::float AS online,
            COALESCE(sum(amount) FILTER (WHERE provider IS DISTINCT FROM 'razorpay'), 0)::float AS counter
     FROM payments WHERE status = 'paid'
       AND paid_at >= ($1::date::timestamp AT TIME ZONE $3) AND paid_at < ($2::date::timestamp AT TIME ZONE $3)`,
    [firstDay, nextFirstDay, tz],
  );
  const cash = await tx.one(
    `SELECT COALESCE(sum(amount), 0)::float AS cash FROM revenue_entries WHERE deleted_at IS NULL AND entry_date >= $1 AND entry_date < $2`,
    [firstDay, nextFirstDay],
  );
  const cats = await tx.q(
    `SELECT category, sum(total)::float AS amount, count(*)::int AS count FROM expenses
     WHERE status = 'confirmed' AND bill_date >= $1 AND bill_date < $2 GROUP BY category ORDER BY sum(total) DESC`,
    [firstDay, nextFirstDay],
  );
  const gst = await tx.one(
    `SELECT COALESCE(sum(COALESCE((tax->>'cgst')::numeric, 0) + COALESCE((tax->>'sgst')::numeric, 0) + COALESCE((tax->>'igst')::numeric, 0) + COALESCE((tax->>'cess')::numeric, 0)), 0)::float AS paid,
            count(*) FILTER (WHERE tax <> '{}'::jsonb)::int AS bills
     FROM expenses WHERE status = 'confirmed' AND bill_date >= $1 AND bill_date < $2`,
    [firstDay, nextFirstDay],
  );
  const collected = await tx.one(
    `SELECT COALESCE(sum(i.tax_total), 0)::float AS collected FROM invoices i
     WHERE i.status = 'paid' AND i.paid_at >= ($1::date::timestamp AT TIME ZONE $3) AND i.paid_at < ($2::date::timestamp AT TIME ZONE $3)`,
    [firstDay, nextFirstDay, tz],
  );
  const revenue = { online: r2(pay.online), counter: r2(pay.counter), cash: r2(cash.cash), total: 0 };
  revenue.total = r2(revenue.online + revenue.counter + revenue.cash);
  const expTotal = r2(cats.reduce((s, c) => s + Number(c.amount), 0));
  return {
    month,
    revenue,
    expenses: { total: expTotal, byCategory: cats.map((c) => ({ category: c.category, amount: r2(c.amount), count: c.count })) },
    profit: r2(revenue.total - expTotal),
    gst: { paidOnBills: r2(gst.paid), collected: r2(collected.collected), bills: gst.bills },
  };
}

/** Keep the month's numbers for reports and comparisons. */
export async function snapshot(tx: Tx, b: Books) {
  await tx.q(
    `INSERT INTO money_snapshots (month, revenue, expenses, profit) VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, month) DO UPDATE SET revenue = EXCLUDED.revenue, expenses = EXCLUDED.expenses, profit = EXCLUDED.profit, updated_at = now()`,
    [b.month, JSON.stringify(b.revenue), JSON.stringify(b.expenses), b.profit],
  );
}
