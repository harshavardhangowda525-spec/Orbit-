import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { EXPENSE_CATEGORIES } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { SnapModule } from '../snap/snap.controller';
import { books, monthOf } from './books';
import { KhataService } from './khata.service';

const Files = z.object({ fileIds: z.array(z.string().uuid()).min(1).max(5) });
const ReadBill = Files.extend({ booksMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional() });
const money = z.number().nonnegative().max(100_000_000);
const Bill = z.object({
  snapId: z.string().uuid().nullable().optional(),
  booksMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional(),
  vendorName: z.string().trim().min(1).max(120),
  gstin: z.string().trim().max(20).nullable().optional(),
  billNumber: z.string().trim().max(60).nullable().optional(),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.string().trim().min(1).max(40),
  subtotal: money.nullable().optional(),
  tax: z.object({ cgst: money.nullable().optional(), sgst: money.nullable().optional(), igst: money.nullable().optional(), cess: money.nullable().optional() }).optional(),
  total: money,
  paymentMode: z.string().trim().max(30).nullable().optional(),
  items: z.array(z.object({ name: z.string().max(160).nullable(), qty: z.number().nullable().optional(), rate: z.number().nullable().optional(), amount: z.number().nullable().optional() })).max(200).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  autoSaveVendor: z.boolean().optional(),
  allowDuplicate: z.boolean().optional(),
});
const Sale = z.object({
  amount: z.union([z.number().positive().max(100_000_000), z.string().trim().min(1).max(40)]),
  mode: z.enum(['cash', 'upi', 'card', 'other']).default('cash'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  via: z.enum(['app', 'settlement']).default('app'),
  fileId: z.string().uuid().nullable().optional(),
});
const ExpensePatch = z.object({ booksMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), category: z.string().trim().min(1).max(40).optional(), total: money.optional(), billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), vendorName: z.string().trim().min(1).max(120).optional() });
const Settings = z.object({ checkin: z.boolean().optional(), checkinTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() });
const Month = z.string().regex(/^\d{4}-\d{2}$/).optional();

/**
 * Khata (the books). Everyone on the team can add bills and sales; only the
 * owner and managers see totals and profit.
 */
@UseGuards(TenantGuard)
@Controller('khata')
export class KhataController {
  constructor(private readonly db: DbService, private readonly khata: KhataService) {}

  @Post('bills/read')
  readBill(@CurrentTenant() t: Tenant, @Body(new ZodPipe(ReadBill)) b: z.infer<typeof ReadBill>) {
    return this.khata.readBill(t.businessId, t.userId, b.fileIds, b.booksMonth);
  }

  @Post('bills')
  saveBill(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Bill)) b: z.infer<typeof Bill>) {
    return this.db.withTenant(t.businessId, (tx) => this.khata.saveBill(tx, b, t.userId), t.userId);
  }

  @Roles('owner', 'manager')
  @Get('expenses')
  expenses(@CurrentTenant() t: Tenant, @Query('month') month?: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const p = await this.khata.plan(tx);
      return this.khata.listExpenses(tx, Month.safeParse(month).success && month ? month : monthOf(new Date(), p.tz));
    });
  }

  @Roles('owner', 'manager')
  @Patch('expenses/:id')
  updateExpense(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ExpensePatch)) b: z.infer<typeof ExpensePatch>) {
    return this.db.withTenant(t.businessId, (tx) => this.khata.updateExpense(tx, id, b, t.userId), t.userId);
  }

  @Roles('owner', 'manager')
  @Delete('expenses/:id')
  deleteExpense(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, (tx) => this.khata.deleteExpense(tx, id, t.userId), t.userId);
  }

  @Roles('owner', 'manager')
  @Get('vendors')
  vendors(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(`SELECT id, name, gstin, default_category AS category, auto_save AS "autoSave", confirmed_bills AS bills FROM vendors ORDER BY confirmed_bills DESC, name LIMIT 200`),
    );
  }

  @Roles('owner', 'manager')
  @Patch('vendors/:id')
  vendor(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ autoSave: z.boolean() }))) b: { autoSave: boolean }) {
    return this.db.withTenant(t.businessId, (tx) => this.khata.setVendorAutoSave(tx, id, b.autoSave), t.userId);
  }

  @Post('sales')
  sale(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Sale)) b: z.infer<typeof Sale>) {
    return this.db.withTenant(t.businessId, (tx) => this.khata.logSale(tx, b, t.userId), t.userId);
  }

  @Post('settlement/read')
  settlement(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Files)) b: z.infer<typeof Files>) {
    return this.khata.readSettlement(t.businessId, t.userId, b.fileIds);
  }

  @Roles('owner', 'manager')
  @Get('summary')
  summary(@CurrentTenant() t: Tenant, @Query('month') month?: string) {
    return this.db.withTenant(t.businessId, (tx) => this.khata.summary(tx, month));
  }

  @Get('categories')
  categories() {
    return EXPENSE_CATEGORIES;
  }

  @Get('settings')
  settings(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => (await tx.one(`SELECT khata_settings AS s FROM business_profiles WHERE business_id = app_current_business()`))?.s ?? {});
  }

  @Roles('owner', 'manager')
  @Patch('settings')
  saveSettings(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Settings)) b: z.infer<typeof Settings>) {
    return this.db.withTenant(t.businessId, async (tx) =>
      (await tx.one(`UPDATE business_profiles SET khata_settings = khata_settings || $1::jsonb WHERE business_id = app_current_business() RETURNING khata_settings AS s`, [JSON.stringify(b)])).s,
    t.userId);
  }

  /** The month's report (Plus and above): the printable page reads this. */
  @Roles('owner', 'manager')
  @Get('report')
  report(@CurrentTenant() t: Tenant, @Query('month') month?: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const p = await this.khata.require(tx, 'monthlyReport');
      const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthOf(new Date(), p.tz);
      const biz = await tx.one(`SELECT b.name, p.gstin FROM businesses b LEFT JOIN business_profiles p ON p.business_id = b.id WHERE b.id = app_current_business()`);
      const sales = await tx.q(`SELECT to_char(entry_date, 'YYYY-MM-DD') AS date, mode, amount::float AS amount, note, via FROM revenue_entries WHERE deleted_at IS NULL AND to_char(entry_date, 'YYYY-MM') = $1 ORDER BY entry_date`, [m]);
      return { business: biz, currency: p.currency, books: await books(tx, m, p.tz), expenses: await this.khata.listExpenses(tx, m), sales };
    });
  }

  /** Excel (Pro and above): totals match the Money view exactly, since both come from the same books. */
  @Roles('owner', 'manager')
  @Get('report.xlsx')
  async excel(@CurrentTenant() t: Tenant, @Res() res: Response, @Query('month') month?: string) {
    const data = await this.db.withTenant(t.businessId, async (tx) => {
      const p = await this.khata.require(tx, 'excelExport');
      const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthOf(new Date(), p.tz);
      const b = await books(tx, m, p.tz);
      const biz = await tx.one(`SELECT name FROM businesses WHERE id = app_current_business()`);
      const sales = await tx.q(`SELECT to_char(entry_date, 'YYYY-MM-DD') AS date, mode, amount::float AS amount, note FROM revenue_entries WHERE deleted_at IS NULL AND to_char(entry_date, 'YYYY-MM') = $1 ORDER BY entry_date`, [m]);
      return { m, b, biz, sales, expenses: await this.khata.listExpenses(tx, m) };
    });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Orbit Khata';
    const inr = '"₹"#,##0.00';
    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 34 }, { width: 18 }];
    s.addRows([
      [`${data.biz.name} — books for ${data.m}`],
      ['Based on bills and sales added to Orbit. For your accountant to verify; not tax advice.'],
      [],
      ['Revenue: online payments', data.b.revenue.online],
      ['Revenue: paid at the counter', data.b.revenue.counter],
      ['Revenue: cash and other sales', data.b.revenue.cash],
      ['Revenue total', data.b.revenue.total],
      [],
      ...data.b.expenses.byCategory.map((c) => [`Expenses: ${c.category.replace('_', ' ')}`, c.amount]),
      ['Expenses total', data.b.expenses.total],
      [],
      ['Profit (revenue − expenses)', data.b.profit],
      [],
      ['GST paid on bills (input tax)', data.b.gst.paidOnBills],
      ['GST on paid Orbit invoices (output tax)', data.b.gst.collected],
    ]);
    s.getColumn(2).numFmt = inr;
    s.getRow(1).font = { bold: true, size: 14 };
    for (const r of [7, 10 + data.b.expenses.byCategory.length - 1, 12 + data.b.expenses.byCategory.length]) s.getRow(r).font = { bold: true };
    const e = wb.addWorksheet('Bills');
    e.columns = [
      { header: 'Date', key: 'billDate', width: 12 }, { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'GSTIN', key: 'gstin', width: 18 }, { header: 'Bill no.', key: 'billNumber', width: 14 },
      { header: 'Category', key: 'category', width: 16 }, { header: 'Subtotal', key: 'subtotal', width: 12 }, { header: 'CGST', key: 'cgst', width: 10 }, { header: 'SGST', key: 'sgst', width: 10 },
      { header: 'IGST', key: 'igst', width: 10 }, { header: 'Cess', key: 'cess', width: 10 }, { header: 'Total', key: 'total', width: 12 }, { header: 'Bill image in Orbit', key: 'link', width: 40 },
    ];
    for (const x of data.expenses as any[]) {
      e.addRow({ ...x, cgst: x.tax?.cgst ?? null, sgst: x.tax?.sgst ?? null, igst: x.tax?.igst ?? null, cess: x.tax?.cess ?? null, link: x.fileIds?.length ? `${process.env.PUBLIC_BASE_URL ?? ''}/bridge?view=money&bill=${x.id}` : '' });
    }
    e.getRow(1).font = { bold: true };
    for (const k of ['subtotal', 'cgst', 'sgst', 'igst', 'cess', 'total']) e.getColumn(k).numFmt = inr;
    const c = wb.addWorksheet('Sales logged');
    c.columns = [{ header: 'Date', key: 'date', width: 12 }, { header: 'Mode', key: 'mode', width: 10 }, { header: 'Amount', key: 'amount', width: 14 }, { header: 'Note', key: 'note', width: 40 }];
    c.addRows(data.sales);
    c.getRow(1).font = { bold: true };
    c.getColumn('amount').numFmt = inr;
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename="orbit-books-${data.m}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
}

@Global()
@Module({ imports: [SnapModule], controllers: [KhataController], providers: [KhataService], exports: [KhataService] })
export class KhataModule {}
