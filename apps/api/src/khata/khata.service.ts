import { Injectable, OnModuleInit } from '@nestjs/common';
import { guessCategory, khataAllows, localParts, parseIndianDate, parseIndianPrice, vendorKey, type KhataFeature, type KhataLevel, type Sentence } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { SnapService } from '../snap/snap.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { agentName, fact, type TraceInput } from '../trust/trace';
import { recordVersion, snapshot as versionSnapshot } from '../trust/versions';
import { logger } from '../logger';
import { books, monthOf, prevMonth, snapshot, type Books } from './books';

const CHECK_BELOW = 0.8;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface BillInput {
  snapId?: string | null;
  /** The month of the books this bill goes into (YYYY-MM); defaults to this month. */
  booksMonth?: string | null;
  vendorName: string;
  gstin?: string | null;
  billNumber?: string | null;
  billDate: string;
  category: string;
  subtotal?: number | null;
  tax?: { cgst?: number | null; sgst?: number | null; igst?: number | null; cess?: number | null };
  total: number;
  paymentMode?: string | null;
  items?: { name: string | null; qty?: number | null; rate?: number | null; amount?: number | null }[];
  notes?: string | null;
  autoSaveVendor?: boolean;
  allowDuplicate?: boolean;
}

export class UpgradeNeeded extends AppError {
  constructor(feature: string) {
    super(402, 'upgrade_needed', 'This is on a higher plan. Upgrade to use it.', { feature });
  }
}

/**
 * Khata, the accounts agent: keeps the books. Owners snap bills (Khata reads
 * them, suggests a category, learns each vendor), log cash sales, and see what
 * was earned, spent and kept each month. Totals are always "based on bills and
 * sales added to Orbit"; Khata organises records for the accountant and never
 * gives tax or legal advice.
 */
@Injectable()
export class KhataService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly snap: SnapService, private readonly jobs: JobsService) {}

  onModuleInit() {
    this.jobs.register('khata.daily', () => this.dailyAll());
  }

  // ------------------------------------------------------------ plan

  async plan(tx: Tx) {
    const r = await tx.one(
      `SELECT b.timezone, b.currency, b.default_language AS lang, p.features->>'khataLevel' AS level,
              COALESCE(b.limit_overrides->'billsPerMonth', p.limits->'billsPerMonth') AS bills
       FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
    );
    const level = (['basic', 'plus', 'pro', 'business'].includes(r?.level) ? r.level : 'basic') as KhataLevel;
    const bills = r?.bills == null || r.bills === 'null' ? null : Number(r.bills);
    return { level, billsPerMonth: Number.isFinite(bills as number) ? (bills as number) : null, tz: r?.timezone ?? 'Asia/Kolkata', currency: r?.currency ?? 'INR', lang: r?.lang ?? 'en' };
  }

  async require(tx: Tx, feature: KhataFeature) {
    const p = await this.plan(tx);
    if (!khataAllows(p.level, feature)) throw new UpgradeNeeded(feature);
    return p;
  }

  private today(tz: string) {
    return localParts(new Date(), tz).date;
  }

  // ------------------------------------------------------------ bills

  /** Bills scanned this month (the plan's monthly allowance counts scans). */
  async billsUsed(tx: Tx, tz: string) {
    const month = monthOf(new Date(), tz);
    const r = await tx.one(
      `SELECT count(*)::int AS n FROM snaps WHERE kind = 'bill' AND status <> 'failed' AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM') = $2`,
      [tz, month],
    );
    return r?.n ?? 0;
  }

  /** Read a bill photo into a draft for the review card. Saves only for vendors the owner set to auto-save. */
  async readBill(businessId: string, userId: string, fileIds: string[], booksMonth?: string | null) {
    await this.db.withTenant(businessId, async (tx) => {
      const p = await this.plan(tx);
      if (p.billsPerMonth != null && (await this.billsUsed(tx, p.tz)) >= p.billsPerMonth) {
        throw new AppError(402, 'bill_limit', `Your plan reads ${p.billsPerMonth} bills a month. Upgrade for more, or add this one by typing it in.`);
      }
    });
    const snap = await this.snap.read(businessId, 'bill', fileIds, userId);
    if (snap.problem) return { snapId: snap.id, fileIds, problem: snap.problem };
    return this.db.withTenant(businessId, async (tx) => {
      const p = await this.plan(tx);
      const x: any = (snap as any).result;
      const conf: Record<string, number> = x.confidence ?? {};
      const vendorName = (x.vendor_name ?? '').trim();
      const vendor = vendorName ? await tx.one(`SELECT * FROM vendors WHERE name_key = $1 OR (gstin IS NOT NULL AND gstin = $2)`, [vendorKey(vendorName), x.vendor_gstin ?? '']) : null;
      const check = new Set<string>();
      for (const [k, field] of [['vendor_name', 'vendorName'], ['bill_date', 'billDate'], ['total', 'total'], ['bill_number', 'billNumber'], ['tax', 'tax']] as const) {
        if ((conf[k] ?? 0.5) < CHECK_BELOW) check.add(field);
      }
      // Indian bills print the day first (06/11/2026 = 6 Nov). Read the printed text ourselves; it wins over the model's guess.
      const printed = parseIndianDate(x.bill_date_text);
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(x.bill_date ?? '') ? x.bill_date : null;
      const billDate = printed ?? iso;
      if (!billDate) check.add('billDate');
      else {
        // A bill dated in the future, or more than 60 days ago, is probably misread: ask the owner to check.
        const days = (Date.parse(`${billDate}T12:00:00Z`) - Date.parse(`${this.today(p.tz)}T12:00:00Z`)) / 86_400_000;
        if (days > 1 || days < -60) check.add('billDate');
      }
      if (!vendorName) check.add('vendorName');
      const gstin = x.vendor_gstin ? String(x.vendor_gstin).toUpperCase().replace(/\s/g, '') : null;
      if (gstin && !GSTIN.test(gstin)) check.add('gstin');
      const tax = { cgst: x.cgst ?? null, sgst: x.sgst ?? null, igst: x.igst ?? null, cess: x.cess ?? null };
      // The parts should add up; if they do not, the owner checks the total.
      const parts = (x.subtotal ?? 0) + (tax.cgst ?? 0) + (tax.sgst ?? 0) + (tax.igst ?? 0) + (tax.cess ?? 0);
      if (x.subtotal != null && Math.abs(parts - x.total) > 1) check.add('total');
      const items = (x.items ?? []).filter((i: any) => i.name);
      const category = vendor?.default_category ?? guessCategory(vendorName, items.map((i: any) => i.name), x.category_hint);
      const draft = {
        vendorName, gstin, billNumber: x.bill_number ?? null, billDate: billDate ?? this.today(p.tz), category,
        categorySource: vendor?.default_category ? 'vendor' : 'guess', subtotal: x.subtotal ?? null, tax, total: x.total, paymentMode: x.payment_mode ?? null, items,
        check: [...check], vendor: vendor ? { id: vendor.id, name: vendor.name, autoSave: vendor.auto_save, confirmedBills: vendor.confirmed_bills } : null,
      };
      const duplicate = await this.findDuplicate(tx, draft);
      // "Auto-save bills from vendors I've confirmed before": only when nothing needs checking.
      if (vendor?.auto_save && vendor.confirmed_bills > 0 && !check.size && !duplicate) {
        const saved = await this.saveBill(tx, { ...draft, snapId: snap.id, booksMonth }, userId, { auto: true, fileIds });
        return { snapId: snap.id, fileIds, problem: null, draft, duplicate: null, saved };
      }
      return { snapId: snap.id, fileIds, problem: null, draft, duplicate };
    }, userId);
  }

  /** Same vendor + bill number, or same vendor + amount + date. */
  private async findDuplicate(tx: Tx, b: { vendorName: string; billNumber?: string | null; billDate: string; total: number }) {
    if (!b.vendorName) return null;
    const key = vendorKey(b.vendorName);
    return tx.one(
      `SELECT e.id, e.vendor_name AS "vendorName", e.bill_number AS "billNumber", e.bill_date AS "billDate", e.total::float AS total
       FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
       WHERE e.status = 'confirmed' AND (v.name_key = $1 OR lower(e.vendor_name) = lower($2))
         AND ((($3::text IS NOT NULL) AND lower(e.bill_number) = lower($3)) OR (e.total = $4 AND e.bill_date = $5::date))
       ORDER BY e.created_at DESC LIMIT 1`,
      [key, b.vendorName, b.billNumber || null, b.total, b.billDate],
    ).then((r) => r ?? null);
  }

  /** Save a confirmed bill: learn the vendor, post to the Feed (with Why?), and keep it undoable for 24 hours. */
  async saveBill(tx: Tx, b: BillInput, userId: string | null, o: { auto?: boolean; fileIds?: string[]; source?: 'scan' | 'manual' | 'whatsapp' | 'gmail' } = {}) {
    const p = await this.plan(tx);
    const name = b.vendorName.trim();
    if (!name) throw badRequest('vendor', 'Add who the bill is from.');
    if (!(b.total > 0)) throw badRequest('total', 'Add the bill amount.');
    if (!b.allowDuplicate) {
      const dup = await this.findDuplicate(tx, { vendorName: name, billNumber: b.billNumber, billDate: b.billDate, total: b.total });
      if (dup) throw new AppError(409, 'duplicate_bill', 'This looks like a bill you already added.', { duplicate: dup });
    }
    let fileIds = o.fileIds ?? [];
    if (b.snapId) {
      const s = await tx.one(`SELECT file_ids, status FROM snaps WHERE id = $1 AND kind = 'bill' FOR UPDATE`, [b.snapId]);
      if (!s) throw notFound('That scan is no longer here.');
      if (s.status === 'applied') throw badRequest('already_added', 'This bill was already added.');
      fileIds = s.file_ids;
      await tx.q(`UPDATE snaps SET status = 'applied', applied_at = now() WHERE id = $1`, [b.snapId]);
    }
    const key = vendorKey(name);
    const before = await tx.one(`SELECT id, default_category FROM vendors WHERE name_key = $1`, [key]);
    const vendor = await tx.one(
      `INSERT INTO vendors (name, name_key, gstin, default_category, auto_save, confirmed_bills) VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (business_id, name_key) DO UPDATE SET gstin = COALESCE(EXCLUDED.gstin, vendors.gstin), default_category = EXCLUDED.default_category,
         auto_save = CASE WHEN $6 THEN EXCLUDED.auto_save ELSE vendors.auto_save END, confirmed_bills = vendors.confirmed_bills + 1
       RETURNING id, name, auto_save`,
      [name, key, b.gstin || null, b.category, !!b.autoSaveVendor, b.autoSaveVendor !== undefined],
    );
    const tax = Object.fromEntries(Object.entries(b.tax ?? {}).filter(([, v]) => v != null && Number(v) > 0));
    const booksMonth = b.booksMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(b.booksMonth) ? b.booksMonth : monthOf(new Date(), p.tz);
    const e = await tx.one(
      `INSERT INTO expenses (vendor_id, vendor_name, bill_number, bill_date, category, subtotal, tax, total, payment_mode, status, source, file_ids, snap_id, items, notes, created_by, confirmed_at, books_month)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,$14,$15, now(), $16) RETURNING id, bill_date, books_month, total::float AS total`,
      [vendor.id, name, b.billNumber || null, b.billDate, b.category, b.subtotal ?? null, JSON.stringify(tax), b.total, b.paymentMode || null,
        o.source ?? (b.snapId ? 'scan' : 'manual'), fileIds, b.snapId ?? null, JSON.stringify(b.items ?? []), b.notes || null, userId, booksMonth],
    );
    const amount = `~m:${p.currency}:${b.total}`;
    const learned = !!before?.default_category && before.default_category === b.category;
    const trace: TraceInput = {
      agent: 'khata',
      action: { key: 'why.action.khata.saved', params: { agent: await agentName(tx, 'khata'), amount, vendor: name } },
      trigger: o.auto ? { kind: 'sequence_rule' } : { kind: 'owner_decision' },
      approver: o.auto ? { kind: 'auto_rule' } : { kind: 'owner' },
      ...(o.auto ? { rule: { code: 'khata.auto_save', label: { key: 'why.rule.khata.auto_save', params: { vendor: name } }, setting: '/bridge?view=money&tab=bills' } } : {}),
      facts: [
        fact('bill', b.billNumber ? 'why.fact.bill_numbered' : 'why.fact.bill', { vendor: name, number: b.billNumber ?? '', date: `~d:${b.billDate}T12:00:00Z`, amount }),
        fact('category', learned ? 'why.fact.category_from_vendor' : 'why.fact.category_chosen', { category: `@khata.cat.${b.category}`, vendor: name }),
      ],
    };
    const feed = await postFeed(tx, 'khata', 'expense_added', { key: 'feed.khata.expense', params: { amount, category: `@khata.cat.${b.category}`, vendor: name } }, { entityType: 'expense', entityId: e.id, minutesSaved: 3, trace });
    await tx.q(`UPDATE expenses SET trace_id = $2 WHERE id = $1`, [e.id, feed.traceId]);
    const versionId = await recordVersion(tx, { entity: 'expense', id: e.id, label: { key: 'change.expense_added', params: { amount, vendor: name } }, before: null, after: await versionSnapshot(tx, 'expense', e.id), by: userId });
    await this.detectRecurring(tx, vendor.id);
    liveToBusiness(tx, { type: 'stats.changed' });
    return { id: e.id as string, total: e.total as number, booksMonth: e.books_month as string, vendorId: vendor.id as string, autoSave: vendor.auto_save as boolean, versionId };
  }

  async listExpenses(tx: Tx, month: string) {
    return tx.q(
      `SELECT e.id, e.vendor_name AS vendor, e.bill_number AS "billNumber", to_char(e.bill_date, 'YYYY-MM-DD') AS "billDate", e.books_month AS "booksMonth", e.category, e.subtotal::float AS subtotal, e.tax,
              e.total::float AS total, e.payment_mode AS "paymentMode", e.source, e.file_ids AS "fileIds", e.trace_id AS "traceId", v.gstin
       FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
       WHERE e.status = 'confirmed' AND e.books_month = $1 ORDER BY e.created_at DESC`,
      [month],
    );
  }

  async updateExpense(tx: Tx, id: string, patch: { category?: string; total?: number; billDate?: string; vendorName?: string; booksMonth?: string }, userId: string) {
    const before = await versionSnapshot(tx, 'expense', id);
    if (!before || before.status !== 'confirmed') throw notFound();
    const r = await tx.one(
      `UPDATE expenses SET category = COALESCE($2, category), total = COALESCE($3, total), bill_date = COALESCE($4::date, bill_date), vendor_name = COALESCE($5, vendor_name),
         books_month = COALESCE($6, books_month)
       WHERE id = $1 RETURNING vendor_id, category, vendor_name`,
      [id, patch.category ?? null, patch.total ?? null, patch.billDate ?? null, patch.vendorName ?? null, patch.booksMonth ?? null],
    );
    // A corrected category teaches Khata for this vendor's next bills.
    if (patch.category && r.vendor_id) await tx.q(`UPDATE vendors SET default_category = $2 WHERE id = $1`, [r.vendor_id, patch.category]);
    await recordVersion(tx, { entity: 'expense', id, label: { key: 'change.expense_edited', params: { vendor: r.vendor_name ?? '' } }, before, after: await versionSnapshot(tx, 'expense', id), by: userId });
    liveToBusiness(tx, { type: 'stats.changed' });
    return { ok: true };
  }

  async deleteExpense(tx: Tx, id: string, userId: string) {
    const before = await versionSnapshot(tx, 'expense', id);
    if (!before || before.status !== 'confirmed') throw notFound();
    await tx.q(`UPDATE expenses SET status = 'deleted', deleted_at = now() WHERE id = $1`, [id]);
    await recordVersion(tx, { entity: 'expense', id, label: { key: 'change.expense_removed', params: { vendor: before.vendor_name ?? '' } }, before, after: await versionSnapshot(tx, 'expense', id), by: userId });
    liveToBusiness(tx, { type: 'stats.changed' });
    return { ok: true };
  }

  async setVendorAutoSave(tx: Tx, vendorId: string, on: boolean) {
    const r = await tx.one(`UPDATE vendors SET auto_save = $2 WHERE id = $1 RETURNING id, name, auto_save AS "autoSave"`, [vendorId, on]);
    if (!r) throw notFound();
    return r;
  }

  // ------------------------------------------------------------ sales

  /** Cash and other sales: "Add sale", the end-of-day check-in, a settlement screenshot, or "aaj 8,500 cash aaya". */
  async logSale(tx: Tx, s: { amount: number | string; mode?: string; date?: string | null; note?: string | null; via?: string; fileId?: string | null }, userId: string | null) {
    const p = await this.require(tx, 'cashLogging');
    const parsed = parseIndianPrice(s.amount as any);
    if (!parsed || !(parsed.price > 0)) throw badRequest('amount', 'Please enter the amount, e.g. 8,500.');
    const mode = ['cash', 'upi', 'card', 'other'].includes(s.mode ?? '') ? s.mode! : 'cash';
    const date = s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : this.today(p.tz);
    const r = await tx.one(
      `INSERT INTO revenue_entries (source, mode, amount, entry_date, note, via, file_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [mode === 'cash' ? 'cash' : 'other', mode, parsed.price, date, s.note || null, s.via ?? 'app', s.fileId ?? null, userId],
    );
    const amount = `~m:${p.currency}:${parsed.price}`;
    await postFeed(tx, 'khata', 'sale_logged', { key: 'feed.khata.sale', params: { amount, mode: `@khata.mode.${mode}` } }, {
      entityType: 'revenue_entry', entityId: r.id, valueAmount: 0,
      trace: {
        agent: 'khata', action: { key: 'why.action.khata.sale', params: { agent: await agentName(tx, 'khata'), amount } }, trigger: { kind: 'owner_decision' }, approver: { kind: 'owner' },
        facts: [fact('sale', s.via === 'checkin' ? 'why.fact.checkin_answer' : s.via === 'settlement' ? 'why.fact.settlement_read' : 'why.fact.sale_logged', { amount, date: `~d:${date}T12:00:00Z`, mode: `@khata.mode.${mode}` })],
      },
    });
    const versionId = await recordVersion(tx, { entity: 'revenue_entry', id: r.id, label: { key: 'change.sale_added', params: { amount } }, before: null, after: await versionSnapshot(tx, 'revenue_entry', r.id), by: userId });
    liveToBusiness(tx, { type: 'stats.changed' });
    return { id: r.id as string, amount: parsed.price, date, mode, versionId };
  }

  async readSettlement(businessId: string, userId: string, fileIds: string[]) {
    await this.db.withTenant(businessId, (tx) => this.require(tx, 'cashLogging'));
    const s = await this.snap.read(businessId, 'settlement', fileIds, userId);
    if (s.problem) return { snapId: s.id, problem: s.problem };
    const x: any = (s as any).result;
    return { snapId: s.id, problem: null, total: x.total, date: /^\d{4}-\d{2}-\d{2}$/.test(x.date ?? '') ? x.date : null, mode: x.mode === 'card' ? 'card' : 'upi', fileId: fileIds[0], check: (x.confidence ?? 0.5) < CHECK_BELOW ? ['total'] : [] };
  }

  // ------------------------------------------------------------ the money view

  async summary(tx: Tx, month?: string) {
    const p = await this.plan(tx);
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthOf(new Date(), p.tz);
    const now = await books(tx, m, p.tz);
    const last = await books(tx, prevMonth(m), p.tz);
    const allow = (f: KhataFeature) => khataAllows(p.level, f);
    const today = this.today(p.tz);
    const todays = await tx.one(
      `SELECT (SELECT COALESCE(sum(amount), 0) FROM revenue_entries WHERE deleted_at IS NULL AND entry_date = $1)::float AS sales,
              (SELECT COALESCE(sum(total), 0) FROM expenses WHERE status = 'confirmed' AND (created_at AT TIME ZONE $2)::date = $1)::float AS spent`,
      [today, p.tz],
    );
    if (m < monthOf(new Date(), p.tz)) await snapshot(tx, now);
    return {
      month: m,
      level: p.level,
      currency: p.currency,
      note: { key: 'khata.note.based_on' } as Sentence,
      revenue: now.revenue,
      expenses: allow('breakdown') ? now.expenses : { total: now.expenses.total, byCategory: [] },
      profit: now.profit,
      last: { month: last.month, revenue: last.revenue.total, expenses: last.expenses.total, profit: last.profit },
      compare: compare(now, last, p.currency),
      insights: allow('insights') ? await this.insights(tx, now, p.tz, p.currency) : [],
      upcoming: allow('recurringBills') ? await this.upcoming(tx) : [],
      gst: allow('gstHelper') ? { ...now.gst, label: { key: 'khata.gst.verify' } } : null,
      today: { sales: todays.sales, spent: todays.spent },
      bills: { used: await this.billsUsed(tx, p.tz), limit: p.billsPerMonth },
      locked: (['breakdown', 'cashLogging', 'monthlyReport', 'insights', 'recurringBills', 'gstHelper', 'excelExport'] as KhataFeature[]).filter((f) => !allow(f)),
    };
  }

  /** Plain-language observations from the real numbers only. */
  private async insights(tx: Tx, now: Books, tz: string, currency: string): Promise<Sentence[]> {
    const out: Sentence[] = [];
    const top = now.expenses.byCategory[0];
    if (top && now.expenses.byCategory.length > 1) out.push({ key: 'khata.insight.biggest', params: { category: `@khata.cat.${top.category}`, amount: `~m:${currency}:${top.amount}` } });
    // Each category against its average over the previous three months.
    const prev: Books[] = [];
    let m = now.month;
    for (let i = 0; i < 3; i++) prev.push(await books(tx, (m = prevMonth(m)), tz));
    for (const c of now.expenses.byCategory) {
      const seen = prev.map((b) => b.expenses.byCategory.find((x) => x.category === c.category)?.amount ?? 0).filter((v) => v > 0);
      if (seen.length < 2) continue;
      const avg = seen.reduce((s, v) => s + v, 0) / seen.length;
      const pct = Math.round(((c.amount - avg) / avg) * 100);
      if (pct >= 15) out.push({ key: 'khata.insight.higher', params: { category: `@khata.cat.${c.category}`, pct } });
      else if (pct <= -15) out.push({ key: 'khata.insight.lower', params: { category: `@khata.cat.${c.category}`, pct: -pct } });
    }
    if (now.revenue.total > 0 && now.revenue.cash > 0) out.push({ key: 'khata.insight.cash_share', params: { pct: Math.round((now.revenue.cash / now.revenue.total) * 100) } });
    return out.slice(0, 4);
  }

  // ------------------------------------------------------------ recurring bills

  /** A vendor billed in at least two of the last four months, around the same day: a recurring bill. */
  async detectRecurring(tx: Tx, vendorId: string) {
    const rows = await tx.q(
      `SELECT DISTINCT ON (to_char(bill_date, 'YYYY-MM')) bill_date, total::float AS total, category FROM expenses
       WHERE vendor_id = $1 AND status = 'confirmed' AND bill_date > current_date - 125 ORDER BY to_char(bill_date, 'YYYY-MM'), bill_date DESC`,
      [vendorId],
    );
    if (rows.length < 2) return;
    const days = rows.map((r) => new Date(r.bill_date).getUTCDate());
    if (Math.max(...days) - Math.min(...days) > 4) return;
    const dueDay = Math.round(days.reduce((s, d) => s + d, 0) / days.length);
    const typical = Math.round(rows.reduce((s, r) => s + r.total, 0) / rows.length);
    const last = new Date(rows[rows.length - 1].bill_date);
    const next = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, Math.min(dueDay, 28)));
    await tx.q(
      `INSERT INTO recurring_bills (vendor_id, category, typical_amount, due_day, next_due) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, vendor_id) DO UPDATE SET category = EXCLUDED.category, typical_amount = EXCLUDED.typical_amount, due_day = EXCLUDED.due_day,
         next_due = GREATEST(recurring_bills.next_due, EXCLUDED.next_due), active = true, updated_at = now()`,
      [vendorId, rows[rows.length - 1].category, typical, dueDay, next.toISOString().slice(0, 10)],
    );
  }

  async upcoming(tx: Tx) {
    return tx.q(
      `SELECT r.id, v.name AS vendor, r.category, r.typical_amount::float AS amount, to_char(r.next_due, 'YYYY-MM-DD') AS due
       FROM recurring_bills r JOIN vendors v ON v.id = r.vendor_id WHERE r.active AND r.next_due <= current_date + 30 ORDER BY r.next_due LIMIT 6`,
    );
  }

  // ------------------------------------------------------------ daily job

  async dailyAll(now = new Date()) {
    const ids = await this.db.adminTx((tx) => tx.q<{ id: string }>(`SELECT b.id FROM businesses b JOIN agents a ON a.business_id = b.id AND a.agent_key = 'khata' AND a.enabled WHERE b.status = 'live'`));
    for (const { id } of ids) await this.daily(id, now).catch((e) => logger.error(`khata daily failed: ${e.message}`, e.stack, 'Khata'));
    return ids.length;
  }

  /** Every 15 minutes: the evening cash check-in, bill-due reminders, and last month's summary on the 1st. */
  async daily(businessId: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const p = await this.plan(tx);
      const local = localParts(now, p.tz);
      const settings = (await tx.one(`SELECT khata_settings AS s FROM business_profiles WHERE business_id = app_current_business()`))?.s ?? {};
      // End-of-day check-in: "How much did you take in cash today?"
      if (khataAllows(p.level, 'cashLogging') && settings.checkin !== false && local.hhmm >= (settings.checkinTime ?? '21:00')) {
        const asked = await tx.one(`SELECT 1 FROM approval_cards WHERE type = 'cash_checkin' AND context->>'date' = $1`, [local.date]);
        if (!asked) {
          await tx.q(
            `INSERT INTO approval_cards (agent_key, type, title, context, options, default_option, expires_at)
             VALUES ('khata', 'cash_checkin', $1, $2, $3, 'none', now() + interval '16 hours')`,
            [
              JSON.stringify({ key: 'card.cash_checkin', params: { date: `~d:${local.date}T12:00:00Z` } }),
              JSON.stringify({ date: local.date, input: 'amount' }),
              JSON.stringify([
                { key: 'save', label: 'card.option.save', style: 'primary', outcome: 'approved' },
                { key: 'none', label: 'card.option.no_cash', style: 'secondary', outcome: 'rejected' },
              ]),
            ],
          );
          liveToBusiness(tx, { type: 'card.new' });
        }
      }
      // Recurring bills: a reminder three days before.
      if (khataAllows(p.level, 'recurringBills')) {
        const due = await tx.q(
          `SELECT r.id, v.name, r.typical_amount::float AS amount, to_char(r.next_due, 'YYYY-MM-DD') AS due FROM recurring_bills r JOIN vendors v ON v.id = r.vendor_id
           WHERE r.active AND r.next_due BETWEEN $1::date AND $1::date + 3 AND r.last_reminded_for IS DISTINCT FROM r.next_due`,
          [local.date],
        );
        for (const d of due) {
          await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'khata_bill_due', $1, '/bridge?view=money')`, [
            JSON.stringify({ key: 'notify.khata.bill_due', params: { vendor: d.name, amount: `~m:${p.currency}:${d.amount}`, date: `~d:${d.due}T12:00:00Z` } }),
          ]);
          await tx.q(`UPDATE recurring_bills SET last_reminded_for = next_due WHERE id = $1`, [d.id]);
          liveToBusiness(tx, { type: 'notification.new' });
        }
        // Paid (a bill from that vendor around the due date): move to next month.
        await tx.q(
          `UPDATE recurring_bills r SET next_due = (r.next_due + interval '1 month')::date
           WHERE r.next_due < $1::date AND EXISTS (SELECT 1 FROM expenses e WHERE e.vendor_id = r.vendor_id AND e.status = 'confirmed' AND e.bill_date >= r.next_due - 7)`,
          [local.date],
        );
      }
      // The 1st: last month's books, once.
      if (local.date.endsWith('-01') && local.hhmm >= '09:00') {
        const last = prevMonth(local.date.slice(0, 7));
        const done = await tx.one(`SELECT 1 FROM money_snapshots WHERE month = $1`, [last]);
        if (!done) {
          const b = await books(tx, last, p.tz);
          await snapshot(tx, b);
          await postFeed(tx, 'khata', 'month_closed', { key: 'feed.khata.month', params: { month: `~mo:${last}`, profit: `~m:${p.currency}:${b.profit}` } }, {
            entityType: 'money_snapshot',
            trace: {
              agent: 'khata', action: { key: 'why.action.khata.month', params: { agent: await agentName(tx, 'khata'), month: `~mo:${last}` } }, trigger: { kind: 'schedule' }, approver: { kind: 'not_needed' },
              rule: { code: 'khata.monthly', label: { key: 'why.rule.khata.monthly' }, setting: '/bridge?view=money' },
              facts: [fact('rev', 'why.fact.month_revenue', { amount: `~m:${p.currency}:${b.revenue.total}` }), fact('exp', 'why.fact.month_expenses', { amount: `~m:${p.currency}:${b.expenses.total}` })],
            },
          });
        }
      }
    });
  }
}

/** "₹12,400 more profit than October", from the two months' numbers. */
function compare(now: Books, last: Books, currency: string): Sentence | null {
  if (last.revenue.total === 0 && last.expenses.total === 0) return null;
  const diff = Math.round((now.profit - last.profit) * 100) / 100;
  const month = `~mo:${last.month}`;
  if (diff > 0) return { key: 'khata.compare.more', params: { amount: `~m:${currency}:${diff}`, month } };
  if (diff < 0) return { key: 'khata.compare.less', params: { amount: `~m:${currency}:${-diff}`, month } };
  return { key: 'khata.compare.same', params: { month } };
}

