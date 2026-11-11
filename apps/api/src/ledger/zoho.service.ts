import { Controller, Get, Injectable, Module, OnModuleInit, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { planAllowsPower, type PlanFeatures } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { badRequest } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { runtime } from '../config';
import { logger } from '../logger';
import { open, seal } from '../powers/crypto';
import { LedgerModule, LedgerService } from './ledger.service';
import * as zoho from './zoho';

const MODE: Record<string, string> = { cash: 'cash', upi: 'banktransfer', card: 'creditcard', bank: 'banktransfer', other: 'cash' };

/**
 * Keeps the owner's Zoho Books in step with Orbit: every issued invoice becomes a
 * Zoho invoice (same number, same GST), every payment a customer payment against
 * it, and a cancelled invoice is voided there. Runs as background jobs after the
 * change is saved, so Zoho being slow never slows the owner down.
 */
@Injectable()
export class ZohoService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    const later = (tx: Tx, name: string, data: Record<string, unknown>, jobId: string) => {
      const businessId = tx.businessId!;
      tx.afterCommit(() => this.jobs.enqueue(name, { businessId, ...data }, { jobId }).catch(() => undefined));
    };
    this.ledger.afterIssue = (tx, invoiceId) => later(tx, 'zoho.invoice', { invoiceId }, `zoho-inv:${invoiceId}`);
    this.ledger.afterPayment = (tx, invoiceId, paymentId) => later(tx, 'zoho.payment', { invoiceId, paymentId }, `zoho-pay:${paymentId}`);
    this.ledger.afterCancel = (tx, invoiceId) => later(tx, 'zoho.void', { invoiceId }, `zoho-void:${invoiceId}`);
    this.jobs.register('zoho.invoice', (d) => this.db.withTenant(d.businessId, (tx) => this.pushInvoice(tx, d.invoiceId)));
    this.jobs.register('zoho.payment', (d) => this.db.withTenant(d.businessId, (tx) => this.pushPayment(tx, d.invoiceId, d.paymentId)));
    this.jobs.register('zoho.void', (d) => this.db.withTenant(d.businessId, (tx) => this.voidInvoice(tx, d.invoiceId)));
  }

  // ---------- connecting ----------

  async start(t: Tenant) {
    if (!zoho.zohoConfig.ready) throw badRequest('power_not_configured', 'Zoho Books is not set up on this server yet (ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET).');
    const plan = await this.db.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [t.businessId]);
    if (!planAllowsPower(plan!.features, 'zoho_books')) throw badRequest('upgrade_needed', 'This Power is not on your plan. Upgrade to use it.');
    const state = randomBytes(24).toString('base64url');
    await this.db.q(`INSERT INTO oauth_states (state, business_id, user_id, power_type, expires_at) VALUES ($1, $2, $3, 'zoho_books', now() + interval '10 minutes')`, [state, t.businessId, t.userId]);
    return { url: zoho.authUrl(state) };
  }

  async finish(state: string, code: string | undefined, error: string | undefined, accountsServer: string | undefined) {
    const s = await this.db.one(`DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() AND power_type = 'zoho_books' RETURNING *`, [state]);
    if (!s) return { ok: false, reason: 'expired' };
    if (error || !code) return { ok: false, reason: 'declined' };
    const tokens = await zoho.exchangeCode(code, zoho.accountsServer(accountsServer));
    const org = await zoho.organization(tokens);
    tokens.organization_id = org.id;
    await this.db.withTenant(s.business_id, async (tx) => {
      await tx.q(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE power_type = 'zoho_books' AND status <> 'disconnected'`);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, external_account, encrypted_tokens, status, connected_by, last_sync_at) VALUES ('zoho_books', $1, $2, $3, 'connected', $4, now()) RETURNING id`,
        [org.name, org.id, seal(tokens), s.user_id],
      );
      await postFeed(tx, 'orbit', 'power_connected', { key: 'feed.orbit.power_connected', params: { power: '@power.zoho_books' } }, { entityType: 'power', entityId: c.id });
    }, s.user_id);
    await this.audit.write({ businessId: s.business_id, actorId: s.user_id, action: 'power.connect', entity: 'power', after: { type: 'zoho_books', org: org.name } });
    return { ok: true };
  }

  // ---------- syncing ----------

  private async session(tx: Tx): Promise<{ conn: any; t: zoho.ZohoTokens } | null> {
    const conn = await tx.one(`SELECT * FROM power_connections WHERE power_type = 'zoho_books' AND status = 'connected' ORDER BY created_at DESC LIMIT 1`);
    let t = conn && open<zoho.ZohoTokens>(conn.encrypted_tokens);
    if (!conn || !t) return null;
    if (t.expires_at < Date.now() + 60_000) {
      try {
        t = await zoho.refresh(t);
        await tx.q(`UPDATE power_connections SET encrypted_tokens = $2 WHERE id = $1`, [conn.id, seal(t)]);
      } catch (e) {
        if (e instanceof zoho.ZohoError && e.status < 500) {
          await tx.q(`UPDATE power_connections SET status = 'error', error = 'token_expired' WHERE id = $1`, [conn.id]);
          await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'power_disconnected', $1, '/bridge?view=powers')`, [JSON.stringify({ key: 'notify.power_broken', params: { power: '@power.zoho_books' } })]);
          liveToBusiness(tx, { type: 'notification.new' });
          return null;
        }
        throw e;
      }
    }
    return { conn, t };
  }

  /** Refusals are shown on the Power (and the job stops); outages retry. */
  private async guard<T>(tx: Tx, conn: any, fn: () => Promise<T>): Promise<T | null> {
    try {
      const r = await fn();
      await tx.q(`UPDATE power_connections SET last_sync_at = now(), error = NULL WHERE id = $1`, [conn.id]);
      return r;
    } catch (e) {
      if (e instanceof zoho.ZohoError && e.status < 500 && e.status !== 429) {
        logger.warn(`zoho refused: ${e.message}`, 'Zoho');
        await tx.q(`UPDATE power_connections SET error = $2 WHERE id = $1`, [conn.id, e.message.slice(0, 300)]);
        return null;
      }
      throw e;
    }
  }

  async pushInvoice(tx: Tx, invoiceId: string): Promise<string | null> {
    const z = await this.session(tx);
    if (!z) return null;
    const inv = await tx.one(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
    if (!inv || inv.status === 'draft') return null;
    if (inv.external_refs?.zoho?.invoiceId) return inv.external_refs.zoho.invoiceId;
    return this.guard(tx, z.conn, async () => {
      let contactId: string | null = null;
      if (inv.customer_id) {
        const c = await tx.one(`SELECT id, name, phone, email, external_refs FROM customers WHERE id = $1`, [inv.customer_id]);
        contactId = c.external_refs?.zoho?.contactId ?? null;
        if (!contactId) {
          contactId = await zoho.createContact(z.t, { name: c.name ?? c.phone ?? 'Customer', phone: c.phone, email: c.email, gstin: inv.customer_snapshot?.gstin, state: inv.place_of_supply });
          await tx.q(`UPDATE customers SET external_refs = jsonb_set(external_refs, '{zoho}', $2::jsonb) WHERE id = $1`, [c.id, JSON.stringify({ contactId })]);
        }
      } else {
        contactId = await zoho.createContact(z.t, { name: inv.customer_snapshot?.name ?? 'Walk-in customer' });
      }
      const taxList = inv.tax_total > 0 ? await zoho.taxes(z.t) : [];
      const inter = !!inv.tax?.interState;
      const body = {
        customer_id: contactId,
        invoice_number: inv.number,
        reference_number: `Orbit ${inv.number}`,
        date: new Date(inv.issued_at).toISOString().slice(0, 10),
        due_date: inv.due_at ? new Date(inv.due_at).toISOString().slice(0, 10) : undefined,
        ...(inv.place_of_supply ? { place_of_supply: inv.place_of_supply } : {}),
        gst_treatment: inv.customer_snapshot?.gstin ? 'business_gst' : 'consumer',
        // Inclusive prices: each line's amount is just qty x price (the tax is inside it).
        is_inclusive_tax: Number(inv.tax_total) > 0 && inv.line_items.every((l: any) => Math.abs(Number(l.amount) - Number(l.qty) * Number(l.unitPrice)) < 0.01),
        line_items: inv.line_items.map((l: any) => ({ name: l.description.slice(0, 100), description: l.description, rate: l.unitPrice, quantity: l.qty, tax_id: zoho.pickTax(taxList, l.taxRate, inter) })),
        notes: inv.seller_snapshot?.notes ?? undefined,
      };
      const id = await zoho.createInvoice(z.t, body);
      await tx.q(`UPDATE invoices SET external_refs = jsonb_set(external_refs, '{zoho}', $2::jsonb) WHERE id = $1`, [inv.id, JSON.stringify({ invoiceId: id, contactId })]);
      return id;
    });
  }

  async pushPayment(tx: Tx, invoiceId: string, paymentId: string) {
    const z = await this.session(tx);
    if (!z) return null;
    const pay = await tx.one(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
    if (!pay || pay.external_refs?.zoho?.paymentId) return null;
    const zInvoice = await this.pushInvoice(tx, invoiceId);
    if (!zInvoice) return null;
    const inv = await tx.one(`SELECT external_refs, number FROM invoices WHERE id = $1`, [invoiceId]);
    return this.guard(tx, z.conn, async () => {
      const id = await zoho.createPayment(z.t, {
        customer_id: inv.external_refs.zoho.contactId,
        payment_mode: MODE[pay.method ?? 'other'] ?? 'cash',
        amount: Number(pay.amount),
        date: new Date(pay.paid_at ?? Date.now()).toISOString().slice(0, 10),
        reference_number: pay.provider_ref ?? inv.number,
        invoices: [{ invoice_id: zInvoice, amount_applied: Number(pay.amount) }],
      });
      await tx.q(`UPDATE payments SET external_refs = jsonb_set(external_refs, '{zoho}', $2::jsonb) WHERE id = $1`, [pay.id, JSON.stringify({ paymentId: id })]);
      return id;
    });
  }

  async voidInvoice(tx: Tx, invoiceId: string) {
    const z = await this.session(tx);
    if (!z) return null;
    const inv = await tx.one(`SELECT external_refs FROM invoices WHERE id = $1`, [invoiceId]);
    const id = inv?.external_refs?.zoho?.invoiceId;
    if (!id) return null;
    return this.guard(tx, z.conn, () => zoho.voidInvoice(z.t, id));
  }
}

@UseGuards(TenantGuard)
@Controller('ledger/zoho')
export class ZohoController {
  constructor(private readonly svc: ZohoService) {}

  @Roles('owner', 'manager')
  @Post('connect')
  connect(@CurrentTenant() t: Tenant) {
    return this.svc.start(t);
  }
}

@Controller('powers/oauth/zoho')
export class ZohoOAuthController {
  constructor(private readonly svc: ZohoService) {}

  @Public()
  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string | undefined, @Query('error') error: string | undefined, @Query('accounts-server') server: string | undefined, @Res() res: Response) {
    const r = await this.svc.finish(String(state ?? ''), code, error, server).catch((e) => {
      logger.error(`zoho callback failed: ${e.message}`, e.stack, 'Zoho');
      return { ok: false, reason: 'failed' };
    });
    const q = new URLSearchParams({ view: 'powers', power: 'zoho_books', result: r.ok ? 'connected' : (r as any).reason ?? 'failed' });
    res.redirect(302, `${runtime.webBaseUrl}/bridge?${q}`);
  }
}

@Module({ imports: [LedgerModule], controllers: [ZohoController, ZohoOAuthController], providers: [ZohoService], exports: [ZohoService] })
export class ZohoModule {}
