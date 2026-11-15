/**
 * Phase 4 acceptance: Khata, the accounts agent.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { localParts } from '@orbit/shared';
import { AiService } from '../src/ai/ai.service';
import { DbService } from '../src/db/db.service';
import { KhataService } from '../src/khata/khata.service';
import { text, toolUse } from '../src/ai/fake.provider';
import { api, bootApp, onboard, signIn, upgrade } from './helpers';

type Biz = Awaited<ReturnType<typeof onboard>>;
const TZ = 'Asia/Kolkata';
const PHOTO = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]), name: 'bill.jpg', type: 'image/jpeg' };
const today = () => localParts(new Date(), TZ).date;
const thisMonth = () => today().slice(0, 7);

/** A clear printed GST bill, as the vision model reads it. */
const GST_BILL = {
  is_bill: true, readable: true, vendor_name: 'Sharma Beauty Supplies Pvt Ltd', vendor_gstin: '29ABCDE1234F1Z5', bill_number: 'SBS/2026/0412', bill_date: null as string | null,
  items: [{ name: 'Hair colour tubes', qty: 10, rate: 250, amount: 2500 }, { name: 'Shampoo 1L', qty: 4, rate: 125, amount: 500 }],
  subtotal: 3000, cgst: 270, sgst: 270, igst: 0, cess: 0, total: 3540, payment_mode: 'upi', category_hint: 'supplies',
  confidence: { vendor_name: 0.97, bill_number: 0.95, bill_date: 0.95, total: 0.98, tax: 0.95 },
};

describe('Khata: the books', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let S: Biz;
  const fake = () => app.get(AiService).fake!;
  const tenant = (fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(S.businessId, fn);
  const upload = async (a = S.api, purpose = 'bill') => (await a.upload(`/files?purpose=${purpose}`, [PHOTO]).expect(201)).body.ids as string[];
  const bill = (over: Record<string, unknown> = {}) => {
    fake().seeScript = () => JSON.stringify({ ...GST_BILL, bill_date: today(), ...over });
  };
  const confirm = (draft: any, snapId: string, extra: Record<string, unknown> = {}) =>
    S.api.post('/khata/bills', { snapId, vendorName: draft.vendorName, gstin: draft.gstin, billNumber: draft.billNumber, billDate: draft.billDate, category: draft.category, subtotal: draft.subtotal, tax: draft.tax, total: draft.total, paymentMode: draft.paymentMode, items: draft.items, ...extra });

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    S = await onboard(app, 'salon', 'Khata Salon');
    await upgrade(app, S.businessId, 'pro');
  });
  beforeEach(() => fake().reset());
  afterAll(() => app.close());

  it('Khata is on the Crew', async () => {
    const crew = (await S.api.get('/crew/settings').expect(200)).body.crew;
    expect(crew.find((c: any) => c.agent === 'khata')).toMatchObject({ name: 'Khata', enabled: true });
  });

  it('a clear printed GST bill: vendor, date, total and tax read correctly; nothing saved until Save; the photo is kept', async () => {
    bill();
    const ids = await upload();
    const r = (await S.api.post('/khata/bills/read', { fileIds: ids }).expect(201)).body;
    expect(r.problem).toBeNull();
    expect(fake().seen[0].prompt).toMatch(/KIND: bill/);
    expect(r.draft).toMatchObject({
      vendorName: 'Sharma Beauty Supplies Pvt Ltd', gstin: '29ABCDE1234F1Z5', billNumber: 'SBS/2026/0412', billDate: today(),
      subtotal: 3000, tax: { cgst: 270, sgst: 270 }, total: 3540, category: 'supplies', check: [],
    });
    expect(r.duplicate).toBeNull();
    expect((await tenant((tx) => tx.q(`SELECT 1 FROM expenses`))).length).toBe(0);

    const saved = (await confirm(r.draft, r.snapId).expect(201)).body;
    const e = await tenant((tx) => tx.one(`SELECT total::float AS total, tax, category, file_ids, trace_id, status FROM expenses WHERE id = $1`, [saved.id]));
    expect(e).toMatchObject({ total: 3540, tax: { cgst: 270, sgst: 270 }, category: 'supplies', file_ids: ids, status: 'confirmed' });
    expect(e.trace_id).toBeTruthy();
    // The Feed says so, with Why?
    const feed = (await S.api.get('/bridge').expect(200)).body.feed;
    expect(feed[0]).toMatchObject({ agent: 'khata', type: 'expense_added', sentence: { key: 'feed.khata.expense' }, traceId: e.trace_id });
  });

  it('a duplicate bill is detected (same vendor and bill number, or same amount, date and vendor)', async () => {
    bill();
    const r = (await S.api.post('/khata/bills/read', { fileIds: await upload() }).expect(201)).body;
    expect(r.duplicate).toMatchObject({ vendorName: 'Sharma Beauty Supplies Pvt Ltd', billNumber: 'SBS/2026/0412', total: 3540 });
    const again = await confirm(r.draft, r.snapId);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'duplicate_bill', duplicate: { total: 3540 } });
    // Same vendor, amount and date without a bill number: still a duplicate.
    bill({ bill_number: null, vendor_name: 'SHARMA BEAUTY SUPPLIES PVT. LTD.' });
    const r2 = (await S.api.post('/khata/bills/read', { fileIds: await upload() }).expect(201)).body;
    expect(r2.duplicate).toBeTruthy();
  });

  it('Khata learns the vendor: the owner’s category sticks, and auto-save skips the review next time', async () => {
    bill({ vendor_name: 'BESCOM', vendor_gstin: null, bill_number: 'EL-1', items: [{ name: 'Energy charges', qty: 1, rate: 3450, amount: 3450 }], subtotal: null, cgst: null, sgst: null, total: 3450, category_hint: 'other' });
    const r = (await S.api.post('/khata/bills/read', { fileIds: await upload() }).expect(201)).body;
    expect(r.draft.category).toBe('electricity'); // from the vendor name
    await confirm(r.draft, r.snapId, { category: 'utilities', autoSaveVendor: true }).expect(201);
    bill({ vendor_name: 'Bescom', vendor_gstin: null, bill_number: 'EL-2', items: [], subtotal: null, cgst: null, sgst: null, total: 3610 });
    const auto = (await S.api.post('/khata/bills/read', { fileIds: await upload() }).expect(201)).body;
    expect(auto.saved).toMatchObject({ total: 3610, autoSave: true });
    expect(auto.draft.category).toBe('utilities'); // learned
    const t = await tenant((tx) => tx.one(`SELECT t.approver, t.rule FROM expenses e JOIN decision_traces t ON t.id = e.trace_id WHERE e.id = $1`, [auto.saved.id]));
    expect(t).toMatchObject({ approver: { kind: 'auto_rule' }, rule: { code: 'khata.auto_save' } });
    // Something to check (low confidence): never auto-saved.
    bill({ vendor_name: 'BESCOM', bill_number: 'EL-3', total: 9999, confidence: { vendor_name: 0.9, total: 0.4, bill_date: 0.9, bill_number: 0.9, tax: 0.9 } } as any);
    const low = (await S.api.post('/khata/bills/read', { fileIds: await upload() }).expect(201)).body;
    expect(low.saved).toBeUndefined();
    expect(low.draft.check).toContain('total');
  });

  it('a saved bill can be undone (24 hours), and is then out of the books', async () => {
    const before = (await S.api.get('/khata/summary').expect(200)).body.expenses.total;
    const saved = (await S.api.post('/khata/bills', { vendorName: 'Tea stall', billDate: today(), category: 'food', total: 120 }).expect(201)).body;
    expect((await S.api.get('/khata/summary').expect(200)).body.expenses.total).toBe(before + 120);
    await S.api.post(`/trust/changes/${saved.versionId}/undo`).expect(201);
    expect((await S.api.get('/khata/summary').expect(200)).body.expenses.total).toBe(before);
  });

  it('cash said out loud to Ask Orbit ("aaj 8,500 cash aaya") lands in revenue for the right date; the evening check-in too', async () => {
    fake().script = (req) => (Array.isArray(req.messages[req.messages.length - 1].content) ? [text('Saved ₹8,500 cash for today.')] : [toolUse('log_sale', { amount: 8500, mode: 'cash' })]);
    await S.api.post('/bridge/commands', { text: 'aaj 8,500 cash aaya', language: 'hi' }).expect(201);
    const sale = await tenant((tx) => tx.one(`SELECT amount::float AS amount, to_char(entry_date, 'YYYY-MM-DD') AS d, mode FROM revenue_entries ORDER BY created_at DESC LIMIT 1`));
    expect(sale).toEqual({ amount: 8500, d: today(), mode: 'cash' });

    // The end-of-day check-in asks in Needs You; answering "6,200" records it for that day.
    await tenant((tx) => tx.q(`UPDATE business_profiles SET khata_settings = '{"checkin":true,"checkinTime":"00:00"}'`));
    await app.get(KhataService).daily(S.businessId);
    await app.get(KhataService).daily(S.businessId); // asked once a day
    const cards = (await S.api.get('/bridge').expect(200)).body.needsYou.filter((c: any) => c.type === 'cash_checkin');
    expect(cards).toHaveLength(1);
    expect((await S.api.post(`/bridge/cards/${cards[0].id}/decide`, { option: 'save' })).body.error.code).toBe('amount');
    await S.api.post(`/bridge/cards/${cards[0].id}/decide`, { option: 'save', value: '6,200' }).expect(201);
    const s = (await S.api.get('/khata/summary').expect(200)).body;
    expect(s.revenue.cash).toBe(14700);
    expect(s.today.sales).toBe(14700);
  });

  it('an online payment for a booking is counted once; counter payments separately; profit = revenue − confirmed expenses, exactly', async () => {
    await tenant(async (tx) => {
      const bk = await tx.one(`SELECT id FROM bookings LIMIT 1`).catch(() => null);
      // Paid by a payment link (Ledger records one payment row) and the booking is completed: one payment, counted once.
      await tx.q(`INSERT INTO payments (provider, provider_ref, amount, method, status, paid_at) VALUES ('razorpay', 'pay_once_1', 1000, 'upi', 'paid', now())`);
      if (bk) await tx.q(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [bk.id]);
      await tx.q(`INSERT INTO payments (provider, amount, method, status, paid_at) VALUES ('manual', 450.50, 'cash', 'paid', now())`);
      // A draft (unconfirmed) bill never counts.
      await tx.q(`INSERT INTO expenses (vendor_name, bill_date, category, total, status) VALUES ('Draft vendor', $1, 'other', 99999, 'draft')`, [today()]);
    });
    const s = (await S.api.get('/khata/summary').expect(200)).body;
    expect(s.revenue.online).toBe(1000);
    expect(s.revenue.counter).toBe(450.5);
    expect(s.revenue.total).toBe(s.revenue.online + s.revenue.counter + s.revenue.cash);
    const confirmed = await tenant((tx) => tx.one(`SELECT COALESCE(sum(total), 0)::float AS t FROM expenses WHERE status = 'confirmed' AND to_char(bill_date, 'YYYY-MM') = $1`, [thisMonth()]));
    expect(s.expenses.total).toBe(confirmed.t);
    expect(s.profit).toBe(Math.round((s.revenue.total - confirmed.t) * 100) / 100);
    expect(s.note).toEqual({ key: 'khata.note.based_on' });
    expect(s.gst).toMatchObject({ paidOnBills: 540, label: { key: 'khata.gst.verify' } });
  });

  it('Excel export matches the on-screen totals', async () => {
    const s = (await S.api.get('/khata/summary').expect(200)).body;
    const x = await S.api.get('/khata/report.xlsx').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    const rows = Object.fromEntries((wb.getWorksheet('Summary')!.getSheetValues() as any[]).filter(Boolean).map((r: any[]) => [r[1], r[2]]));
    expect(rows['Revenue total']).toBe(s.revenue.total);
    expect(rows['Expenses total']).toBe(s.expenses.total);
    expect(rows['Profit (revenue − expenses)']).toBe(s.profit);
    const bills = wb.getWorksheet('Bills')!.rowCount - 1;
    expect(bills).toBe((await S.api.get('/khata/expenses').expect(200)).body.length);
  });

  it('staff can add bills and sales, but cannot see totals or profit', async () => {
    const staff = await signIn(app);
    await db.adminTx((tx: any) => tx.q(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'staff')`, [staff.userId, S.businessId]));
    const st = api(app, staff.token, S.businessId);
    await st.post('/khata/sales', { amount: '500', mode: 'upi' }).expect(201);
    await st.post('/khata/bills', { vendorName: 'Milk', billDate: today(), category: 'food', total: 60 }).expect(201);
    expect((await st.get('/khata/summary')).status).toBe(403);
    expect((await st.get('/khata/expenses')).status).toBe(403);
    expect((await st.get('/khata/report.xlsx')).status).toBe(403);
  });

  it('plans: Free reads 10 bills a month, shows monthly totals only, and has no cash logging', async () => {
    const F = await onboard(app, 'gym', 'Free Gym');
    const t = (await F.api.get('/khata/summary').expect(200)).body;
    expect(t.level).toBe('basic');
    expect(t.bills).toEqual({ used: 0, limit: 10 });
    expect(t.locked).toEqual(expect.arrayContaining(['breakdown', 'cashLogging', 'insights', 'gstHelper', 'excelExport']));
    expect(t.gst).toBeNull();
    expect((await F.api.post('/khata/sales', { amount: 100 })).body.error.code).toBe('upgrade_needed');
    expect((await F.api.get('/khata/report.xlsx')).status).toBe(402);
    await db.withTenant(F.businessId, (tx) => tx.q(`INSERT INTO snaps (kind, status) SELECT 'bill', 'applied' FROM generate_series(1, 10)`));
    const over = await F.api.post('/khata/bills/read', { fileIds: await upload(F.api) });
    expect(over.body.error.code).toBe('bill_limit');
  });

  it('recurring bills are spotted from past months and the owner is reminded before the due date', async () => {
    const p = (n: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
    for (const [m, amt] of [[p(2), 1999], [p(1), 1999]] as const) {
      await S.api.post('/khata/bills', { vendorName: 'Airtel Xstream', billDate: `${m}-12`, category: 'internet', total: amt }).expect(201);
    }
    const s = (await S.api.get('/khata/summary').expect(200)).body;
    expect(s.upcoming).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'Airtel Xstream', amount: 1999, due: `${thisMonth()}-12` })]));
  });

  it('another business sees none of this', async () => {
    const O = await onboard(app, 'clinic', 'Other Clinic');
    const s = (await O.api.get('/khata/summary').expect(200)).body;
    expect(s.revenue.total).toBe(0);
    expect((await O.api.get('/khata/expenses').expect(200)).body).toEqual([]);
  });
});
