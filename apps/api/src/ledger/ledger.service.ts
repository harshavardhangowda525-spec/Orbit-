import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { computeInvoice, fiscalYear, formatMoney, GST_STATES, gstinState, invoiceNumber, localParts, planAllowsPower, translate, type InvoiceLineInput, type PlanFeatures } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { BookingsService } from '../bookings/bookings.service';
import { ChannelsService } from '../channels/channels.service';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { AppError, badRequest, notFound } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { hashToken } from '../realtime/ws.gateway';
import { config, runtime } from '../config';
import { logger } from '../logger';
import { open, seal } from '../powers/crypto';
import * as rzp from './razorpay';

const DAY = 24 * 60 * 60 * 1000;
/** Gentle reminders after the due date: 1, 3 and 7 days. */
const REMINDER_DAYS = [1, 3, 7];

const Line = z.object({
  description: z.string().trim().min(1).max(300),
  qty: z.coerce.number().positive().max(100000),
  unitPrice: z.coerce.number().min(0).max(100_000_000),
  taxRate: z.coerce.number().refine((r) => [0, 5, 12, 18, 28].includes(r), 'GST rate must be 0, 5, 12, 18 or 28.').optional(),
});
const InvoiceInput = z.object({
  customerId: z.string().uuid().optional(),
  customer: z.object({ name: z.string().trim().max(120).optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().email().max(254).optional(), gstin: z.string().trim().max(15).optional(), state: z.string().regex(/^\d{2}$/).optional() }).optional(),
  bookingId: z.string().uuid().optional(),
  lines: z.array(Line).min(1).max(50),
  dueDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(1000).optional(),
});
const Profile = z.object({
  legalName: z.string().trim().max(200).optional(),
  gstin: z.string().trim().toUpperCase().max(15).optional().or(z.literal('')),
  defaultTaxRate: z.coerce.number().refine((r) => [0, 5, 12, 18, 28].includes(r)).optional(),
  pricesIncludeTax: z.boolean().optional(),
  invoicePrefix: z.string().trim().max(10).regex(/^[A-Za-z0-9-]*$/).optional(),
  invoiceNotes: z.string().trim().max(1000).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
});
const Paid = z.object({ method: z.enum(['cash', 'upi', 'card', 'bank', 'other']).default('cash'), reference: z.string().trim().max(100).optional() });

const money = (lang: string, cur: string, n: number) => formatMoney(lang, cur, Number(n));

/**
 * Ledger: GST-ready invoices, Razorpay payment links, reminders and the money
 * summary. Issued invoices are numbered consecutively per financial year and can
 * never be edited (the database refuses); mistakes are fixed by cancelling and
 * issuing a new one.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  /** Accounting sync (Zoho Books) listens here; runs after the transaction commits. */
  afterIssue?: (tx: Tx, invoiceId: string) => void;
  afterPayment?: (tx: Tx, invoiceId: string, paymentId: string) => void;
  afterCancel?: (tx: Tx, invoiceId: string) => void;

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly bookings: BookingsService,
    private readonly channels: ChannelsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.jobs.register('ledger.reminders', () => this.remindAll());
    this.jobs.register('ledger.sync_links', () => this.syncAll());
    this.jobs.register('ledger.deposit_expiry', () => this.expireDepositsAll());
    this.bookings.setDepositProvider((tx, booking, service, customer) => this.depositFor(tx, booking, service, customer));
  }

  // ---------- deposits ----------

  /**
   * A booking for a service that needs a deposit: an issued deposit invoice with a
   * Razorpay link. Without Razorpay there is nothing to collect, so the booking
   * is simply confirmed.
   */
  private async depositFor(tx: Tx, booking: any, svc: any, customer: any) {
    const keys = await this.razorpay(tx);
    if (!keys) return null;
    const amount = Number(svc.deposit_amount ?? Math.max(1, Math.round(Number(svc.price) * 0.25)));
    const start = new Date(booking.start_at).getTime();
    const now = Date.now();
    // Pay within 2 hours, and at least 30 minutes before the appointment (never less than 15 minutes from now).
    const payBy = new Date(Math.max(now + 15 * 60_000, Math.min(now + 2 * 60 * 60_000, start - 30 * 60_000)));
    const s = await this.seller(tx);
    const when = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: s.timezone }).format(new Date(start));
    const tot = this.totals(s, [{ description: `Deposit: ${svc.name} (${when})`, qty: 1, unitPrice: amount, taxRate: s.default_tax_rate ?? 18 }]);
    const draft = await tx.one(
      `INSERT INTO invoices (kind, customer_id, booking_id, line_items, tax, subtotal, tax_total, total, status, due_at, currency, customer_snapshot)
       VALUES ('deposit', $1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, '{}') RETURNING id`,
      [customer.id, booking.id, JSON.stringify(tot.lines), JSON.stringify(taxJson(tot)), tot.subtotal, tot.taxTotal, tot.total, payBy, s.currency],
    );
    const inv = await this.issue(tx, draft.id);
    const token = `${tx.businessId}.${randomBytes(18).toString('base64url')}`;
    const page = `${config.publicBaseUrl}/i/${token}`;
    const link = await rzp.createLink(keys.keys, {
      amount: Number(inv.total), currency: inv.currency, reference: inv.number, invoiceId: inv.id, description: `${s.name} · deposit for ${svc.name}`,
      customer: { name: customer.name, contact: customer.phone, email: customer.email }, callbackUrl: page,
    });
    await tx.q(`UPDATE invoices SET pay_link_id = $2, pay_link_url = $3, public_token_hash = $4, sent_at = now(), due_at = $5 WHERE id = $1`, [inv.id, link.id, link.url, hashToken(token), payBy]);
    return { url: link.url, amount: Number(inv.total), payBy };
  }

  /** Unpaid deposits past their time: check Razorpay once more, then free the slot. */
  async expireDepositsAll() {
    const ids = await this.db.adminTx((tx) => tx.q<{ business_id: string }>(`SELECT DISTINCT business_id FROM invoices WHERE kind = 'deposit' AND status IN ('sent', 'overdue') AND due_at < now()`));
    let n = 0;
    for (const { business_id } of ids) n += await this.expireDeposits(business_id).catch((e) => (logger.error(`deposit expiry failed: ${e.message}`, e.stack, 'Ledger'), 0));
    return n;
  }

  async expireDeposits(businessId: string) {
    return this.db.withTenant(businessId, async (tx) => {
      let n = 0;
      for (const inv of await tx.q(`SELECT id, booking_id FROM invoices WHERE kind = 'deposit' AND status IN ('sent', 'overdue') AND due_at < now()`)) {
        await this.syncInvoice(tx, inv.id).catch(() => undefined);
        if ((await tx.one(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status === 'paid') continue;
        await tx.q(`UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [inv.id]);
        const keys = await this.razorpay(tx);
        const link = await tx.one(`SELECT pay_link_id FROM invoices WHERE id = $1`, [inv.id]);
        if (keys && link?.pay_link_id) await rzp.cancelLink(keys.keys, link.pay_link_id).catch(() => undefined);
        const bk = inv.booking_id ? await tx.one(`SELECT status FROM bookings WHERE id = $1`, [inv.booking_id]) : null;
        if (bk?.status === 'pending') await this.bookings.cancel(tx, inv.booking_id, 'deposit_not_paid', 'owner');
        n++;
      }
      return n;
    });
  }

  // ---------- profile ----------

  private async seller(tx: Tx) {
    return tx.one(
      `SELECT b.name, b.currency, b.timezone, b.country, p.legal_name, p.gstin, p.gst_state, p.default_tax_rate::float AS default_tax_rate, p.prices_include_tax,
              p.invoice_prefix, p.invoice_notes, p.payment_terms_days, p.address, p.city, p.postal_code, p.phone, p.email
       FROM businesses b LEFT JOIN business_profiles p ON p.business_id = b.id WHERE b.id = app_current_business()`,
    );
  }

  async profile(t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const s = await this.seller(tx);
      return {
        legalName: s.legal_name, gstin: s.gstin, state: s.gst_state, stateName: s.gst_state ? GST_STATES[s.gst_state] ?? null : null,
        defaultTaxRate: s.default_tax_rate ?? 18, pricesIncludeTax: s.prices_include_tax ?? true, invoicePrefix: s.invoice_prefix ?? 'INV',
        invoiceNotes: s.invoice_notes, paymentTermsDays: s.payment_terms_days ?? 7, currency: s.currency,
        razorpay: !!(await this.razorpay(tx)),
      };
    });
  }

  async updateProfile(t: Tenant, raw: unknown) {
    const b = Profile.safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', b.error.issues[0]?.message ?? 'Please check the details.');
    const p = b.data;
    let state: string | null | undefined;
    if (p.gstin !== undefined) {
      state = p.gstin ? gstinState(p.gstin) : null;
      if (p.gstin && !state) throw badRequest('invalid_gstin', 'That GSTIN does not look right. It has 15 characters, like 29ABCDE1234F1Z5.');
    }
    await this.db.withTenant(t.businessId, async (tx) => {
      await tx.q(`INSERT INTO business_profiles DEFAULT VALUES ON CONFLICT (business_id) DO NOTHING`);
      await tx.q(
        `UPDATE business_profiles SET legal_name = COALESCE($1, legal_name), gstin = CASE WHEN $2::boolean THEN NULLIF($3, '') ELSE gstin END,
           gst_state = CASE WHEN $2::boolean THEN $4 ELSE gst_state END, default_tax_rate = COALESCE($5, default_tax_rate),
           prices_include_tax = COALESCE($6, prices_include_tax), invoice_prefix = COALESCE(NULLIF($7, ''), invoice_prefix),
           invoice_notes = COALESCE($8, invoice_notes), payment_terms_days = COALESCE($9, payment_terms_days)
         WHERE business_id = app_current_business()`,
        [p.legalName ?? null, p.gstin !== undefined, p.gstin ?? null, state ?? null, p.defaultTaxRate ?? null, p.pricesIncludeTax ?? null, p.invoicePrefix ?? null, p.invoiceNotes ?? null, p.paymentTermsDays ?? null],
      );
    }, t.userId);
    return this.profile(t);
  }

  // ---------- drafts ----------

  private totals(s: any, lines: InvoiceLineInput[], buyerState?: string | null) {
    return computeInvoice(lines, { inclusive: s.prices_include_tax ?? true, registered: !!s.gstin, sellerState: s.gst_state, buyerState: buyerState ?? s.gst_state });
  }

  async create(t: Tenant, raw: unknown) {
    const b = InvoiceInput.safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', b.error.issues[0]?.message ?? 'Please check the invoice.');
    const i = b.data;
    return this.db.withTenant(t.businessId, async (tx) => {
      const s = await this.seller(tx);
      let customerId = i.customerId ?? null;
      if (customerId && !(await tx.one(`SELECT 1 FROM customers WHERE id = $1 AND deleted_at IS NULL`, [customerId]))) throw notFound('We could not find that customer.');
      if (!customerId && (i.customer?.phone || i.customer?.email || i.customer?.name)) {
        const c = i.customer!.phone || i.customer!.email
          ? await this.bookings.upsertCustomer(tx, { name: i.customer!.name, phone: i.customer!.phone, email: i.customer!.email }, 'ledger', s.country)
          : await tx.one(`INSERT INTO customers (name, source) VALUES ($1, 'ledger') RETURNING id`, [i.customer!.name]);
        customerId = c.id;
      }
      const lines = i.lines.map((l) => ({ ...l, taxRate: l.taxRate ?? s.default_tax_rate ?? 18 }));
      const buyer = i.customer?.gstin ? gstinState(i.customer.gstin) : i.customer?.state ?? null;
      const tot = this.totals(s, lines, buyer);
      const inv = await tx.one(
        `INSERT INTO invoices (customer_id, booking_id, line_items, tax, subtotal, tax_total, total, status, due_at, currency, notes, customer_snapshot, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', now() + make_interval(days => $8), $9, $10, $11, $12) RETURNING id`,
        [customerId, i.bookingId ?? null, JSON.stringify(tot.lines), JSON.stringify(taxJson(tot)), tot.subtotal, tot.taxTotal, tot.total, i.dueDays ?? s.payment_terms_days ?? 7, s.currency,
         i.notes ?? null, JSON.stringify({ gstin: i.customer?.gstin?.toUpperCase() ?? null, state: buyer }), t.userId],
      );
      return this.detail(tx, inv.id);
    }, t.userId);
  }

  /** Draft from a booking: the service at its booked price. */
  async fromBooking(t: Tenant, bookingId: string) {
    const bk = await this.db.withTenant(t.businessId, (tx) =>
      tx.one(`SELECT bk.id, bk.customer_id, bk.price::float AS price, bk.start_at, s.name AS service, b.timezone FROM bookings bk JOIN services s ON s.id = bk.service_id, businesses b WHERE bk.id = $1 AND b.id = app_current_business()`, [bookingId]),
    );
    if (!bk) throw notFound();
    if (bk.price === null) throw badRequest('no_price', 'This service has no price yet. Add the amount on the invoice.');
    const date = localParts(new Date(bk.start_at), bk.timezone).date;
    return this.create(t, { customerId: bk.customer_id ?? undefined, bookingId: bk.id, lines: [{ description: `${bk.service} (${date})`, qty: 1, unitPrice: bk.price }] });
  }

  // ---------- issuing and sending ----------

  /** Gives a draft its number (next in this financial year) and freezes seller and customer details. */
  private async issue(tx: Tx, id: string) {
    const inv = await tx.one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
    if (!inv) throw notFound();
    if (inv.status !== 'draft') return inv;
    const s = await this.seller(tx);
    const fy = fiscalYear(new Date(), s.timezone);
    const { last_seq } = await tx.one(
      `INSERT INTO invoice_counters (fiscal_year, last_seq) VALUES ($1, 1)
       ON CONFLICT (business_id, fiscal_year) DO UPDATE SET last_seq = invoice_counters.last_seq + 1 RETURNING last_seq`,
      [fy],
    );
    const c = inv.customer_id ? await tx.one(`SELECT name, phone, email FROM customers WHERE id = $1`, [inv.customer_id]) : null;
    const buyerState = inv.customer_snapshot?.state ?? null;
    const tot = this.totals(s, inv.line_items, buyerState);
    return tx.one(
      `UPDATE invoices SET number = $2, fiscal_year = $3, seq = $4, issued_at = now(), line_items = $5, tax = $6, subtotal = $7, tax_total = $8, total = $9,
         place_of_supply = $10, seller_snapshot = $11, customer_snapshot = $12, status = 'sent'
       WHERE id = $1 RETURNING *`,
      [
        id, invoiceNumber(s.invoice_prefix ?? 'INV', fy, last_seq), fy, last_seq, JSON.stringify(tot.lines), JSON.stringify(taxJson(tot)), tot.subtotal, tot.taxTotal, tot.total,
        buyerState ?? s.gst_state ?? null,
        JSON.stringify({ name: s.name, legalName: s.legal_name, gstin: s.gstin, state: s.gst_state, address: [s.address, s.city, s.postal_code].filter((x, i, all) => x && !all.slice(0, i).some((y) => y && String(y).toLowerCase().includes(String(x).toLowerCase()))).join(', ') || null, phone: s.phone, email: s.email, notes: s.invoice_notes }),
        JSON.stringify({ ...inv.customer_snapshot, name: c?.name ?? inv.customer_snapshot?.name ?? null, phone: c?.phone ?? null, email: c?.email ?? null }),
      ],
    ).then((row) => {
      this.afterIssue?.(tx, id);
      return row;
    });
  }

  /** Issue (if needed), add a payment link, and send it to the customer on their best channel. */
  async send(t: Tenant, id: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const inv = await this.issue(tx, id);
      if (inv.status === 'cancelled' || inv.status === 'paid') throw badRequest('invoice_final', 'This invoice is already paid or cancelled.');
      if (!inv.customer_id) throw badRequest('no_customer', 'Add a customer to send this invoice. You can still mark it paid at the counter.');
      const token = `${t.businessId}.${randomBytes(18).toString('base64url')}`;
      const url = `${config.publicBaseUrl}/i/${token}`;
      let payUrl = inv.pay_link_url as string | null;
      const keys = await this.razorpay(tx);
      if (keys && !inv.pay_link_id && Number(inv.total) > 0) {
        try {
          const link = await rzp.createLink(keys.keys, {
            amount: Number(inv.total), currency: inv.currency, reference: inv.number, invoiceId: inv.id, description: `${inv.seller_snapshot.name} · ${inv.number}`,
            customer: { name: inv.customer_snapshot.name, contact: inv.customer_snapshot.phone, email: inv.customer_snapshot.email }, callbackUrl: url,
          });
          await tx.q(`UPDATE invoices SET pay_link_id = $2, pay_link_url = $3 WHERE id = $1`, [inv.id, link.id, link.url]);
          payUrl = link.url;
        } catch (e) {
          logger.warn(`razorpay link for ${inv.number} failed: ${(e as Error).message}`, 'Ledger');
        }
      }
      await tx.q(`UPDATE invoices SET public_token_hash = $2, sent_at = now() WHERE id = $1`, [inv.id, hashToken(token)]);
      const c = await tx.one(`SELECT id, name, phone, email, consent, opted_out_at, language FROM customers WHERE id = $1`, [inv.customer_id]);
      const lang = c.language ?? 'en';
      const body = translate(lang, 'ledger.msg.invoice', { name: (c.name ?? '').split(' ')[0] || '', number: inv.number, business: inv.seller_snapshot.name, amount: money(lang, inv.currency, inv.total), url });
      const r = await this.channels.deliver(tx, 'whatsapp', { customer: c, body, agent: 'ledger' });
      await postFeed(tx, 'ledger', 'invoice_sent', { key: 'feed.ledger.invoice_sent', params: { number: inv.number, customer: (c.name ?? '').split(' ')[0] || '—', amount: `~m:${inv.currency}:${inv.total}` } }, { entityType: 'invoice', entityId: inv.id, channel: r.channel ?? undefined });
      liveToBusiness(tx, { type: 'invoice.updated', data: { id: inv.id } });
      return { ...(await this.detail(tx, inv.id)), url, payUrl, delivered: r.delivered, channel: r.channel };
    }, t.userId);
  }

  async markPaid(t: Tenant, id: string, raw: unknown) {
    const b = Paid.safeParse(raw ?? {});
    if (!b.success) throw badRequest('invalid_input', 'Please choose how it was paid.');
    return this.db.withTenant(t.businessId, async (tx) => {
      await this.issue(tx, id); // paid at the counter straight from a draft: it still gets its number
      await this.recordPayment(tx, id, { provider: 'manual', ref: b.data.reference ?? null, method: b.data.method });
      return this.detail(tx, id);
    }, t.userId);
  }

  /** Idempotent: the same provider payment is recorded once. */
  private async recordPayment(tx: Tx, invoiceId: string, p: { provider: string; ref: string | null; method: string | null; amount?: number }) {
    const inv = await tx.one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    if (!inv || inv.status === 'paid' || inv.status === 'cancelled') return false;
    if (p.ref && (await tx.one(`SELECT 1 FROM payments WHERE provider = $1 AND provider_ref = $2`, [p.provider, p.ref]))) return false;
    const amount = p.amount ?? Number(inv.total);
    const pay = await tx.one(`INSERT INTO payments (invoice_id, provider, provider_ref, amount, method, status, paid_at) VALUES ($1, $2, $3, $4, $5, 'paid', now()) RETURNING id`, [inv.id, p.provider, p.ref, amount, p.method]);
    await tx.q(`UPDATE invoices SET status = 'paid', amount_paid = $2, paid_at = now() WHERE id = $1`, [inv.id, amount]);
    if (inv.kind === 'deposit' && inv.booking_id) {
      const bk = await tx.one(`UPDATE bookings SET status = 'confirmed', deposit_payment_id = $2 WHERE id = $1 AND status = 'pending' RETURNING id`, [inv.booking_id, pay.id]);
      if (bk) liveToBusiness(tx, { type: 'booking.changed', data: { id: bk.id } });
    }
    this.afterPayment?.(tx, inv.id, pay.id);
    const who = (inv.customer_snapshot?.name ?? '').split(' ')[0] || '—';
    await postFeed(tx, 'ledger', 'payment_received', { key: 'feed.ledger.paid', params: { amount: `~m:${inv.currency}:${amount}`, customer: who, number: inv.number ?? '' } }, { entityType: 'invoice', entityId: inv.id, valueAmount: amount });
    liveToBusiness(tx, { type: 'invoice.updated', data: { id: inv.id } });
    return true;
  }

  async cancel(t: Tenant, id: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const inv = await tx.one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
      if (!inv) throw notFound();
      if (inv.status === 'paid') throw badRequest('invoice_final', 'A paid invoice cannot be cancelled. Record a refund instead.');
      if (inv.status === 'cancelled') return this.detail(tx, id);
      await tx.q(`UPDATE invoices SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [id]);
      if (inv.status !== 'draft') this.afterCancel?.(tx, id);
      const keys = inv.pay_link_id ? await this.razorpay(tx) : null;
      if (keys) await rzp.cancelLink(keys.keys, inv.pay_link_id).catch((e) => logger.warn(`cancel link ${inv.pay_link_id}: ${(e as Error).message}`, 'Ledger'));
      await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'invoice.cancel', entity: 'invoice', entityId: id, before: { number: inv.number, total: inv.total } }, tx);
      return this.detail(tx, id);
    }, t.userId);
  }

  /** Ask Razorpay whether a link was paid (works even if the webhook was never set up). */
  async refresh(t: Tenant, id: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      await this.syncInvoice(tx, id);
      return this.detail(tx, id);
    }, t.userId);
  }

  private async syncInvoice(tx: Tx, id: string) {
    const inv = await tx.one(`SELECT id, pay_link_id, status FROM invoices WHERE id = $1`, [id]);
    if (!inv?.pay_link_id || !['sent', 'overdue'].includes(inv.status)) return;
    const keys = await this.razorpay(tx);
    if (!keys) return;
    const l = await rzp.getLink(keys.keys, inv.pay_link_id);
    if (l.status === 'paid') await this.recordPayment(tx, inv.id, { provider: 'razorpay', ref: l.paymentId ?? inv.pay_link_id, method: l.method, amount: l.amountPaid || undefined });
  }

  // ---------- deposit settings ----------

  async depositServices(t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(`SELECT id, name, price::float AS price, deposit_required AS "depositRequired", deposit_amount::float AS "depositAmount" FROM services WHERE active AND deleted_at IS NULL AND duration_min > 0 ORDER BY sort_order`),
    );
  }

  async setDeposit(t: Tenant, id: string, raw: unknown) {
    const b = z.object({ required: z.boolean(), amount: z.coerce.number().positive().max(10_000_000).nullable().optional() }).safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', 'Please check the deposit amount.');
    const r = await this.db.withTenant(t.businessId, (tx) =>
      tx.one(`UPDATE services SET deposit_required = $2, deposit_amount = $3 WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, price::float AS price, deposit_required AS "depositRequired", deposit_amount::float AS "depositAmount"`, [id, b.data.required, b.data.amount ?? null]),
    t.userId);
    if (!r) throw notFound();
    return r;
  }

  // ---------- reading ----------

  private async detail(tx: Tx, id: string) {
    const i = await tx.one(
      `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`,
      [id],
    );
    if (!i) throw notFound();
    return shape(i);
  }

  async get(t: Tenant, id: string) {
    return this.db.withTenant(t.businessId, (tx) => this.detail(tx, id));
  }

  async list(t: Tenant, status?: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const rows = await tx.q(
        `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
         WHERE ($1::text IS NULL OR i.status = $1 OR ($1 = 'unpaid' AND i.status IN ('sent', 'overdue')))
         ORDER BY i.created_at DESC LIMIT 200`,
        [status ?? null],
      );
      return rows.map(shape);
    });
  }

  async summary(t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const r = await tx.one(
        `WITH tz AS (SELECT timezone FROM businesses WHERE id = app_current_business()),
              b AS (SELECT (date_trunc('day', now() AT TIME ZONE (SELECT timezone FROM tz))) AT TIME ZONE (SELECT timezone FROM tz) AS day,
                           (date_trunc('month', now() AT TIME ZONE (SELECT timezone FROM tz))) AT TIME ZONE (SELECT timezone FROM tz) AS month)
         SELECT (SELECT COALESCE(sum(amount), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.day)::float AS today,
                (SELECT COALESCE(sum(amount), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.month)::float AS month,
                (SELECT COALESCE(sum(total - amount_paid), 0) FROM invoices WHERE status IN ('sent', 'overdue'))::float AS outstanding,
                (SELECT count(*) FROM invoices WHERE status IN ('sent', 'overdue') AND due_at < now())::int AS overdue,
                (SELECT count(*) FROM invoices WHERE status = 'draft')::int AS drafts,
                (SELECT currency FROM businesses WHERE id = app_current_business()) AS currency`,
      );
      return r;
    });
  }

  /** The customer's view (public link with an unguessable token). */
  async publicInvoice(token: string) {
    const businessId = token.split('.')[0];
    if (!/^[0-9a-f-]{36}$/.test(businessId)) throw notFound();
    return this.db.withTenant(businessId, async (tx) => {
      const i = await tx.one(`SELECT * FROM invoices WHERE public_token_hash = $1 AND status <> 'draft'`, [hashToken(token)]);
      if (!i) throw notFound('We could not find this invoice.');
      // Back from Razorpay? Check the link now so the page shows "Paid".
      await this.syncInvoice(tx, i.id).catch(() => undefined);
      const fresh = await tx.one(`SELECT * FROM invoices WHERE id = $1`, [i.id]);
      const x = shape(fresh);
      return { number: x.number, status: x.status, issuedAt: x.issuedAt, dueAt: x.dueAt, paidAt: x.paidAt, currency: x.currency, lines: x.lines, subtotal: x.subtotal, taxTotal: x.taxTotal, total: x.total, tax: x.tax,
        seller: fresh.seller_snapshot, customer: { name: fresh.customer_snapshot?.name ?? null, gstin: fresh.customer_snapshot?.gstin ?? null }, placeOfSupply: x.placeOfSupply,
        placeOfSupplyName: x.placeOfSupply ? GST_STATES[x.placeOfSupply] ?? null : null, payUrl: ['sent', 'overdue'].includes(x.status) ? fresh.pay_link_url : null };
    });
  }

  // ---------- Razorpay connection and webhook ----------

  private async razorpay(tx: Tx): Promise<{ id: string; keys: rzp.RazorpayKeys } | null> {
    const c = await tx.one(`SELECT id, encrypted_tokens FROM power_connections WHERE power_type = 'razorpay' AND status = 'connected' ORDER BY created_at DESC LIMIT 1`);
    const keys = c && open<rzp.RazorpayKeys>(c.encrypted_tokens);
    return keys ? { id: c.id, keys } : null;
  }

  async connectRazorpay(t: Tenant, raw: unknown, apiBase: string) {
    const plan = await this.db.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [t.businessId]);
    if (!planAllowsPower(plan!.features, 'razorpay')) throw badRequest('upgrade_needed', 'This Power is not on your plan. Upgrade to use it.');
    const b = z.object({ keyId: z.string().trim().regex(/^rzp_(live|test)_[A-Za-z0-9]{6,}$/, 'The Key ID starts with rzp_live_ or rzp_test_.'), keySecret: z.string().trim().min(10).max(200) }).safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', b.error.issues[0]?.message ?? 'Please check the keys.');
    try {
      await rzp.checkKeys(b.data);
    } catch (e) {
      throw badRequest('razorpay_check_failed', `Razorpay did not accept these keys: ${(e as Error).message}`);
    }
    const webhookSecret = randomBytes(18).toString('base64url');
    const mode = b.data.keyId.startsWith('rzp_live_') ? 'Live' : 'Test';
    const id = await this.db.withTenant(t.businessId, async (tx) => {
      const old = await tx.q<{ id: string }>(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE power_type = 'razorpay' AND status <> 'disconnected' RETURNING id`);
      if (old.length) await tx.q(`DELETE FROM channel_routes WHERE power_connection_id = ANY($1::uuid[])`, [old.map((o) => o.id)]);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, external_account, encrypted_tokens, status, connected_by, last_sync_at) VALUES ('razorpay', $1, $2, $3, 'connected', $4, now()) RETURNING id`,
        [`${mode} · ${b.data.keyId.slice(0, 13)}…`, b.data.keyId, seal({ ...b.data, webhookSecret }), t.userId],
      );
      await tx.q(`INSERT INTO channel_routes (channel, external_id, business_id, power_connection_id) VALUES ('razorpay', $1::text, app_current_business(), $2::uuid)`, [c.id, c.id]);
      await postFeed(tx, 'orbit', 'power_connected', { key: 'feed.orbit.power_connected', params: { power: '@power.razorpay' } }, { entityType: 'power', entityId: c.id });
      return c.id as string;
    }, t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'power.connect', entity: 'power', entityId: id, after: { type: 'razorpay', mode } });
    return { ok: true, id, webhookUrl: `${apiBase}/webhooks/razorpay/${id}`, webhookSecret, event: 'payment_link.paid' };
  }

  async webhook(connectionId: string, raw: Buffer | undefined, signature: string | undefined, body: any) {
    const route = await this.db.one<{ business_id: string }>(`SELECT business_id FROM channel_routes WHERE channel = 'razorpay' AND external_id = $1`, [connectionId]);
    if (!route) throw notFound();
    return this.db.withTenant(route.business_id, async (tx) => {
      const c = await tx.one(`SELECT encrypted_tokens FROM power_connections WHERE id = $1 AND status = 'connected'`, [connectionId]);
      const keys = c && open<rzp.RazorpayKeys>(c.encrypted_tokens);
      if (!keys || !rzp.validWebhook(raw, signature, keys.webhookSecret)) throw new AppError(401, 'bad_signature', 'Invalid signature.');
      if (body?.event !== 'payment_link.paid') return { ignored: body?.event ?? null };
      const link = body.payload?.payment_link?.entity ?? {};
      const pay = body.payload?.payment?.entity ?? {};
      const inv = await tx.one(`SELECT id FROM invoices WHERE pay_link_id = $1 OR id::text = $2`, [link.id ?? '', link.notes?.orbit_invoice_id ?? '00000000-0000-0000-0000-000000000000']);
      if (!inv) return { ignored: 'unknown_link' };
      const recorded = await this.recordPayment(tx, inv.id, { provider: 'razorpay', ref: pay.id ?? link.id, method: pay.method ?? null, amount: (link.amount_paid ?? pay.amount ?? 0) / 100 || undefined });
      return { ok: true, recorded };
    });
  }

  // ---------- reminders ----------

  async remindAll(now = new Date()) {
    const ids = await this.db.adminTx((tx) => tx.q<{ business_id: string }>(`SELECT DISTINCT business_id FROM invoices WHERE kind = 'invoice' AND status IN ('sent', 'overdue') AND due_at < now() AND reminders_sent < $1`, [REMINDER_DAYS.length]));
    let sent = 0;
    for (const { business_id } of ids) sent += await this.remind(business_id, now).catch((e) => (logger.error(`ledger reminders failed: ${e.message}`, e.stack, 'Ledger'), 0));
    return sent;
  }

  /** Overdue invoices: mark them, and send a polite reminder 1, 3 and 7 days after the due date, in daytime only. */
  async remind(businessId: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const tz = (await tx.one(`SELECT timezone FROM businesses WHERE id = app_current_business()`)).timezone;
      await tx.q(`UPDATE invoices SET status = 'overdue' WHERE kind = 'invoice' AND status = 'sent' AND due_at < $1`, [now]);
      const hour = localParts(now, tz).hour;
      if (hour < 10 || hour >= 19) return 0;
      const due = await tx.q(`SELECT * FROM invoices WHERE kind = 'invoice' AND status = 'overdue' AND reminders_sent < $1 AND customer_id IS NOT NULL`, [REMINDER_DAYS.length]);
      let sent = 0;
      for (const inv of due) {
        if (now.getTime() < new Date(inv.due_at).getTime() + REMINDER_DAYS[inv.reminders_sent] * DAY) continue;
        await this.syncInvoice(tx, inv.id).catch(() => undefined); // paid meanwhile? then no reminder
        if ((await tx.one(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).status !== 'overdue') continue;
        const c = await tx.one(`SELECT id, name, phone, email, consent, opted_out_at, language FROM customers WHERE id = $1`, [inv.customer_id]);
        const lang = c.language ?? 'en';
        const token = `${businessId}.${randomBytes(18).toString('base64url')}`;
        await tx.q(`UPDATE invoices SET public_token_hash = $2 WHERE id = $1`, [inv.id, hashToken(token)]);
        const body = translate(lang, 'ledger.msg.reminder', { name: (c.name ?? '').split(' ')[0] || '', number: inv.number, business: inv.seller_snapshot.name, amount: money(lang, inv.currency, inv.total - inv.amount_paid), url: `${config.publicBaseUrl}/i/${token}` });
        const r = await this.channels.deliver(tx, 'whatsapp', { customer: c, body, agent: 'ledger' });
        await tx.q(`UPDATE invoices SET reminders_sent = reminders_sent + 1, last_reminded_at = now() WHERE id = $1`, [inv.id]);
        sent++;
        if (r.delivered) {
          await postFeed(tx, 'ledger', 'invoice_reminder', { key: 'feed.ledger.reminder', params: { number: inv.number, customer: (c.name ?? '').split(' ')[0] || '—' } }, { entityType: 'invoice', entityId: inv.id, channel: r.channel ?? undefined });
        }
      }
      return sent;
    });
  }

  async syncAll() {
    const ids = await this.db.adminTx((tx) => tx.q<{ business_id: string }>(`SELECT DISTINCT business_id FROM invoices WHERE status IN ('sent', 'overdue') AND pay_link_id IS NOT NULL AND sent_at > now() - interval '45 days'`));
    for (const { business_id } of ids) {
      await this.db.withTenant(business_id, async (tx) => {
        for (const i of await tx.q(`SELECT id FROM invoices WHERE status IN ('sent', 'overdue') AND pay_link_id IS NOT NULL AND sent_at > now() - interval '45 days'`)) {
          await this.syncInvoice(tx, i.id).catch((e) => logger.warn(`sync ${i.id}: ${(e as Error).message}`, 'Ledger'));
        }
      }).catch((e) => logger.error(`ledger sync failed: ${e.message}`, e.stack, 'Ledger'));
    }
  }
}

function taxJson(t: ReturnType<typeof computeInvoice>) {
  return { cgst: t.cgst, sgst: t.sgst, igst: t.igst, interState: t.interState, byRate: t.byRate };
}

function shape(i: any) {
  return {
    id: i.id, number: i.number, status: i.status, kind: i.kind, currency: i.currency,
    customerId: i.customer_id, customerName: i.customer_name ?? i.customer_snapshot?.name ?? null, customerPhone: i.customer_phone ?? null, bookingId: i.booking_id,
    lines: i.line_items, tax: i.tax, subtotal: Number(i.subtotal), taxTotal: Number(i.tax_total), total: Number(i.total), amountPaid: Number(i.amount_paid),
    dueAt: i.due_at, issuedAt: i.issued_at, sentAt: i.sent_at, paidAt: i.paid_at, cancelledAt: i.cancelled_at, createdAt: i.created_at,
    payUrl: i.pay_link_url, placeOfSupply: i.place_of_supply, notes: i.notes, reminders: i.reminders_sent,
  };
}

@UseGuards(TenantGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('summary')
  summary(@CurrentTenant() t: Tenant) {
    return this.ledger.summary(t);
  }

  @Get('profile')
  profile(@CurrentTenant() t: Tenant) {
    return this.ledger.profile(t);
  }

  @Roles('owner', 'manager')
  @Patch('profile')
  updateProfile(@CurrentTenant() t: Tenant, @Body() body: unknown) {
    return this.ledger.updateProfile(t, body);
  }

  @Get('invoices')
  list(@CurrentTenant() t: Tenant, @Query('status') status?: string) {
    return this.ledger.list(t, status && /^(draft|sent|paid|overdue|cancelled|unpaid)$/.test(status) ? status : undefined);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('invoices')
  create(@CurrentTenant() t: Tenant, @Body() body: unknown) {
    return this.ledger.create(t, body);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('invoices/from-booking/:bookingId')
  fromBooking(@CurrentTenant() t: Tenant, @Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.ledger.fromBooking(t, bookingId);
  }

  @Get('invoices/:id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.get(t, id);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('invoices/:id/send')
  send(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.send(t, id);
  }

  @Roles('owner', 'manager', 'staff')
  @Post('invoices/:id/paid')
  paid(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.ledger.markPaid(t, id, body);
  }

  @Roles('owner', 'manager')
  @Post('invoices/:id/cancel')
  cancel(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.cancel(t, id);
  }

  @Post('invoices/:id/refresh')
  refresh(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.refresh(t, id);
  }

  @Get('services')
  services(@CurrentTenant() t: Tenant) {
    return this.ledger.depositServices(t);
  }

  @Roles('owner', 'manager')
  @Patch('services/:id/deposit')
  deposit(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.ledger.setDeposit(t, id, body);
  }

  @Roles('owner', 'manager')
  @Post('razorpay/connect')
  connect(@CurrentTenant() t: Tenant, @Body() body: unknown, @Req() req: Request) {
    return this.ledger.connectRazorpay(t, body, `${req.protocol}://${req.get('host')}`);
  }
}

@Controller()
export class LedgerPublicController {
  constructor(private readonly ledger: LedgerService) {}

  @Public()
  @Get('public/invoices/:token')
  invoice(@Param('token') token: string) {
    if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,40}$/.test(token)) throw notFound();
    return this.ledger.publicInvoice(token);
  }

  @Public()
  @SkipThrottle()
  @Post('webhooks/razorpay/:connectionId')
  @HttpCode(200)
  webhook(@Param('connectionId', ParseUUIDPipe) id: string, @Req() req: Request, @Headers('x-razorpay-signature') sig: string | undefined) {
    return this.ledger.webhook(id, (req as any).rawBody, sig, req.body);
  }
}

@Module({ controllers: [LedgerController, LedgerPublicController], providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
