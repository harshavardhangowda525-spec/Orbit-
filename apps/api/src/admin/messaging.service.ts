import { Controller, Get, Injectable, OnModuleInit, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { Public } from '../auth/guards';
import { liveToBusiness } from '../realtime/live';
import { runtime } from '../config';
import { logger } from '../logger';

/** Messages Orbit sends to business owners (not to their customers). */
export type Lang = 'en' | 'hi' | 'kn';
type Content = Partial<Record<Lang, { subject: string; body: string }>>;
export interface Segment {
  plans?: string[];
  renewalWithinDays?: number;
  inactiveDays?: number;
  signedUpAfter?: string;
  signedUpBefore?: string;
  businessIds?: string[];
}

const c = (en: [string, string], hi: [string, string], kn: [string, string]): Content => ({
  en: { subject: en[0], body: en[1] }, hi: { subject: hi[0], body: hi[1] }, kn: { subject: kn[0], body: kn[1] },
});

/** Built-in automatic messages (admins can edit text, timing, channels and languages; edits are kept). */
export const DEFAULT_TEMPLATES: { key: string; name: string; category: 'transactional' | 'marketing'; channels: string[]; timing: Record<string, unknown>; content: Content }[] = [
  ...[7, 3, 1].map((d) => ({
    key: `renewal_${d}`, name: `Renewal reminder (${d} day${d > 1 ? 's' : ''} before)`, category: 'transactional' as const, channels: ['inapp', 'email'], timing: { daysBefore: d },
    content: c(
      [`Your Orbit {{plan}} plan renews in ${d} day${d > 1 ? 's' : ''}`, `Hi {{owner}}, your Orbit {{plan}} plan for {{business}} renews on {{date}} ({{amount}}). Nothing to do if your payment method is up to date.`],
      [`आपका Orbit {{plan}} प्लान ${d} दिन में रिन्यू होगा`, `नमस्ते {{owner}}, {{business}} का Orbit {{plan}} प्लान {{date}} को रिन्यू होगा ({{amount}})। अगर भुगतान का तरीका सही है तो कुछ करने की ज़रूरत नहीं।`],
      [`ನಿಮ್ಮ Orbit {{plan}} ಪ್ಲಾನ್ ${d} ದಿನದಲ್ಲಿ ನವೀಕರಣ`, `ನಮಸ್ಕಾರ {{owner}}, {{business}} ನ Orbit {{plan}} ಪ್ಲಾನ್ {{date}} ರಂದು ನವೀಕರಣಗೊಳ್ಳುತ್ತದೆ ({{amount}}). ಪಾವತಿ ವಿಧಾನ ಸರಿಯಿದ್ದರೆ ಏನೂ ಮಾಡಬೇಕಿಲ್ಲ.`],
    ),
  })),
  {
    key: 'payment_failed', name: 'Payment failed', category: 'transactional', channels: ['inapp', 'email'], timing: {},
    content: c(
      ['Your Orbit payment did not go through', 'Hi {{owner}}, the payment for your Orbit {{plan}} plan did not go through. Your Crew keeps working for {{graceDays}} days. Please update your payment method: {{link}}'],
      ['आपका Orbit भुगतान नहीं हुआ', 'नमस्ते {{owner}}, आपके Orbit {{plan}} प्लान का भुगतान नहीं हुआ। आपका Crew {{graceDays}} दिन तक काम करता रहेगा। कृपया भुगतान का तरीका अपडेट करें: {{link}}'],
      ['ನಿಮ್ಮ Orbit ಪಾವತಿ ಆಗಲಿಲ್ಲ', 'ನಮಸ್ಕಾರ {{owner}}, ನಿಮ್ಮ Orbit {{plan}} ಪ್ಲಾನ್ ಪಾವತಿ ಆಗಲಿಲ್ಲ. ನಿಮ್ಮ Crew {{graceDays}} ದಿನ ಕೆಲಸ ಮುಂದುವರಿಸುತ್ತದೆ. ದಯವಿಟ್ಟು ಪಾವತಿ ವಿಧಾನ ನವೀಕರಿಸಿ: {{link}}'],
    ),
  },
  {
    key: 'grace_reminder', name: 'Grace period reminder', category: 'transactional', channels: ['inapp', 'email'], timing: { everyDays: 2 },
    content: c(
      ['{{daysLeft}} days left to keep Orbit {{plan}}', 'Hi {{owner}}, we still could not collect the payment for {{business}}. In {{daysLeft}} days the plan moves to Free (nothing is deleted). Update your payment: {{link}}'],
      ['Orbit {{plan}} रखने के लिए {{daysLeft}} दिन बचे', 'नमस्ते {{owner}}, {{business}} का भुगतान अभी तक नहीं हुआ। {{daysLeft}} दिन में प्लान Free हो जाएगा (कुछ भी डिलीट नहीं होगा)। भुगतान अपडेट करें: {{link}}'],
      ['Orbit {{plan}} ಉಳಿಸಲು {{daysLeft}} ದಿನ ಬಾಕಿ', 'ನಮಸ್ಕಾರ {{owner}}, {{business}} ಪಾವತಿ ಇನ್ನೂ ಆಗಿಲ್ಲ. {{daysLeft}} ದಿನದಲ್ಲಿ ಪ್ಲಾನ್ Free ಆಗುತ್ತದೆ (ಏನೂ ಅಳಿಸುವುದಿಲ್ಲ). ಪಾವತಿ ನವೀಕರಿಸಿ: {{link}}'],
    ),
  },
  {
    key: 'plan_expired', name: 'Plan ended (moved to Free)', category: 'transactional', channels: ['inapp', 'email'], timing: {},
    content: c(
      ['{{business}} is now on Orbit Free', 'Hi {{owner}}, your Orbit {{plan}} plan has ended and {{business}} is on Free. Your data is safe. On Free you lose: {{lost}}. Renew any time: {{link}}'],
      ['{{business}} अब Orbit Free पर है', 'नमस्ते {{owner}}, आपका Orbit {{plan}} प्लान खत्म हो गया और {{business}} अब Free पर है। आपका डेटा सुरक्षित है। Free पर ये नहीं मिलेगा: {{lost}}। कभी भी रिन्यू करें: {{link}}'],
      ['{{business}} ಈಗ Orbit Free ನಲ್ಲಿದೆ', 'ನಮಸ್ಕಾರ {{owner}}, ನಿಮ್ಮ Orbit {{plan}} ಪ್ಲಾನ್ ಮುಗಿದಿದೆ, {{business}} ಈಗ Free ನಲ್ಲಿದೆ. ನಿಮ್ಮ ಡೇಟಾ ಸುರಕ್ಷಿತ. Free ನಲ್ಲಿ ಇವು ಇರುವುದಿಲ್ಲ: {{lost}}. ಯಾವಾಗ ಬೇಕಾದರೂ ನವೀಕರಿಸಿ: {{link}}'],
    ),
  },
  {
    key: 'usage_80', name: 'Usage at 80%', category: 'transactional', channels: ['email'], timing: {},
    content: c(
      ['Orbit has used 80% of {{period}} replies', 'Hi {{owner}}, Orbit has used {{used}} of {{cap}} replies for {{business}} {{period}}. Upgrade to keep Orbit answering: {{link}}'],
      ['Orbit ने {{period}} के 80% जवाब इस्तेमाल किए', 'नमस्ते {{owner}}, Orbit ने {{business}} के लिए {{period}} {{cap}} में से {{used}} जवाब इस्तेमाल किए। Orbit जवाब देता रहे, इसके लिए अपग्रेड करें: {{link}}'],
      ['Orbit {{period}} 80% ಉತ್ತರಗಳನ್ನು ಬಳಸಿದೆ', 'ನಮಸ್ಕಾರ {{owner}}, Orbit {{business}} ಗಾಗಿ {{period}} {{cap}} ರಲ್ಲಿ {{used}} ಉತ್ತರ ಬಳಸಿದೆ. Orbit ಉತ್ತರಿಸುತ್ತಲೇ ಇರಲು ಅಪ್‌ಗ್ರೇಡ್ ಮಾಡಿ: {{link}}'],
    ),
  },
  {
    key: 'usage_100', name: 'Usage at 100%', category: 'transactional', channels: ['email'], timing: {},
    content: c(
      ['Orbit is paused: customers are waiting', 'Hi {{owner}}, Orbit has used {{period}} replies for {{business}}. {{count}} customers are waiting in your inbox. Reply, or upgrade so Orbit keeps answering: {{link}}'],
      ['Orbit रुका है: ग्राहक इंतज़ार कर रहे हैं', 'नमस्ते {{owner}}, Orbit ने {{business}} के लिए {{period}} जवाब इस्तेमाल कर लिए। {{count}} ग्राहक आपके इनबॉक्स में इंतज़ार कर रहे हैं। जवाब दें या अपग्रेड करें: {{link}}'],
      ['Orbit ವಿರಾಮದಲ್ಲಿದೆ: ಗ್ರಾಹಕರು ಕಾಯುತ್ತಿದ್ದಾರೆ', 'ನಮಸ್ಕಾರ {{owner}}, Orbit {{business}} ಗಾಗಿ {{period}} ಉತ್ತರಗಳನ್ನು ಬಳಸಿದೆ. {{count}} ಗ್ರಾಹಕರು ನಿಮ್ಮ ಇನ್‌ಬಾಕ್ಸ್‌ನಲ್ಲಿ ಕಾಯುತ್ತಿದ್ದಾರೆ. ಉತ್ತರಿಸಿ ಅಥವಾ ಅಪ್‌ಗ್ರೇಡ್ ಮಾಡಿ: {{link}}'],
    ),
  },
  {
    key: 'trial_ending', name: 'Trial ending', category: 'transactional', channels: ['inapp', 'email'], timing: { daysBefore: 3 },
    content: c(
      ['Your Orbit {{plan}} trial ends on {{date}}', 'Hi {{owner}}, the {{plan}} trial for {{business}} ends on {{date}}. Keep everything by choosing a plan: {{link}}'],
      ['आपका Orbit {{plan}} ट्रायल {{date}} को खत्म होगा', 'नमस्ते {{owner}}, {{business}} का {{plan}} ट्रायल {{date}} को खत्म होगा। सब कुछ जारी रखने के लिए प्लान चुनें: {{link}}'],
      ['ನಿಮ್ಮ Orbit {{plan}} ಟ್ರಯಲ್ {{date}} ರಂದು ಮುಗಿಯುತ್ತದೆ', 'ನಮಸ್ಕಾರ {{owner}}, {{business}} ನ {{plan}} ಟ್ರಯಲ್ {{date}} ರಂದು ಮುಗಿಯುತ್ತದೆ. ಎಲ್ಲವನ್ನೂ ಉಳಿಸಲು ಪ್ಲಾನ್ ಆರಿಸಿ: {{link}}'],
    ),
  },
  {
    key: 'welcome_upgrade', name: 'Welcome after upgrade', category: 'transactional', channels: ['inapp', 'email'], timing: {},
    content: c(
      ['Welcome to Orbit {{plan}}, {{owner}}', 'Thank you! {{business}} is now on Orbit {{plan}}. New for you: {{new}}. Open The Bridge to see it: {{link}}'],
      ['Orbit {{plan}} में स्वागत है, {{owner}}', 'धन्यवाद! {{business}} अब Orbit {{plan}} पर है। आपके लिए नया: {{new}}। देखने के लिए The Bridge खोलें: {{link}}'],
      ['Orbit {{plan}} ಗೆ ಸ್ವಾಗತ, {{owner}}', 'ಧನ್ಯವಾದ! {{business}} ಈಗ Orbit {{plan}} ನಲ್ಲಿದೆ. ನಿಮಗೆ ಹೊಸದು: {{new}}. ನೋಡಲು The Bridge ತೆರೆಯಿರಿ: {{link}}'],
    ),
  },
];

export const render = (text: string, params: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));

/** Next allowed time to send outside quiet hours (business's timezone). In-app messages are never held. */
export function outsideQuietHours(now: Date, tz: string, quietStart = 21, quietEnd = 9): Date {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(now));
  const quiet = quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
  if (!quiet) return now;
  const hoursAhead = (quietEnd - hour + 24) % 24 || 24;
  const t = new Date(now.getTime() + hoursAhead * 3600_000);
  t.setUTCMinutes(0, 0, 0);
  return t;
}

/**
 * Messaging centre: Orbit -> business owners. Automatic messages come from
 * editable templates; admins can also send one-off messages and broadcasts to a
 * segment. Channels: in-app (the bell), email (when EMAIL_API_KEY is set);
 * WhatsApp and push are recorded as unavailable until they are connected.
 * Marketing respects opt-outs; email waits out quiet hours.
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly jobs: JobsService) {}

  onModuleInit() {
    this.jobs.register('messages.deliver', () => this.deliverDue());
    this.jobs.register('messages.broadcasts', () => this.sendScheduledBroadcasts());
  }

  async seedTemplates(tx: Tx) {
    for (const t of DEFAULT_TEMPLATES) {
      await tx.q(
        `INSERT INTO message_templates (key, name, category, channels, timing, content) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING`,
        [t.key, t.name, t.category, t.channels, JSON.stringify(t.timing), JSON.stringify(t.content)],
      );
    }
  }

  /** Owners (and staff marked as owners) of a business, with language and preferences. */
  private recipients(tx: Tx, businessIds: string[], marketing: boolean) {
    return tx.q(
      `SELECT m.business_id, u.id AS user_id, u.email, COALESCE(u.language, b.default_language, 'en') AS language, u.name AS owner, b.name AS business, b.timezone,
              COALESCE(np.quiet_start, 21) AS quiet_start, COALESCE(np.quiet_end, 9) AS quiet_end
       FROM memberships m JOIN users u ON u.id = m.user_id JOIN businesses b ON b.id = m.business_id
       LEFT JOIN notification_preferences np ON np.user_id = u.id
       WHERE m.business_id = ANY($1::uuid[]) AND m.role = 'owner' AND m.status = 'active' AND b.status <> 'suspended'
         AND ($2::boolean = false OR COALESCE(np.marketing, true))`,
      [businessIds, marketing],
    );
  }

  /** Queue messages for owners; returns how many were queued. Duplicates (same dedupe key) are skipped. */
  private async queue(
    tx: Tx,
    rows: any[],
    o: { content: Content; channels: string[]; params?: (r: any) => Record<string, unknown>; templateKey?: string; broadcastId?: string; dedupe?: string; link?: string },
  ) {
    let n = 0;
    for (const r of rows) {
      const lang = (['en', 'hi', 'kn'].includes(r.language) ? r.language : 'en') as Lang;
      const tpl = o.content[lang] ?? o.content.en!;
      const params = { owner: (r.owner ?? '').split(' ')[0] || '', business: r.business, link: o.link ? `${runtime.webBaseUrl}${o.link}` : runtime.webBaseUrl, ...(o.params?.(r) ?? {}) };
      for (const ch of o.channels) {
        const when = ch === 'inapp' ? new Date() : outsideQuietHours(new Date(), r.timezone, r.quiet_start, r.quiet_end);
        const ins = await tx.one(
          `INSERT INTO owner_messages (business_id, user_id, template_key, broadcast_id, dedupe_key, channel, subject, body, link, scheduled_for)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedupe_key, channel, user_id) DO NOTHING RETURNING id`,
          [r.business_id, r.user_id, o.templateKey ?? null, o.broadcastId ?? null, o.dedupe ? `${o.dedupe}` : null, ch, render(tpl.subject, params), render(tpl.body, params), o.link ?? null, when],
        );
        if (ins) n++;
      }
    }
    return n;
  }

  /** An automatic message from a template to a business's owners. */
  async sendTemplate(businessId: string, key: string, params: Record<string, unknown> = {}, opts: { dedupe?: string; link?: string; channels?: string[] } = {}) {
    return this.db.adminTx(async (tx) => {
      const t = await tx.one(`SELECT * FROM message_templates WHERE key = $1 AND enabled`, [key]);
      if (!t) return 0;
      const rows = await this.recipients(tx, [businessId], t.category === 'marketing');
      const channels = opts.channels ? t.channels.filter((c: string) => opts.channels!.includes(c)) : t.channels;
      const n = await this.queue(tx, rows, { content: t.content, channels, params: () => params, templateKey: key, dedupe: opts.dedupe ?? `${key}:${businessId}:${Date.now()}`, link: opts.link ?? '/bridge?view=plan' });
      if (n) tx.afterCommit(() => this.jobs.enqueue('messages.deliver', {}, { jobId: `deliver-owner:${Date.now()}` }).catch(() => undefined));
      return n;
    });
  }

  /** Businesses in a segment (plans, renewal window, inactivity, signup dates, explicit ids). */
  async segment(tx: Tx, s: Segment): Promise<string[]> {
    const rows = await tx.q(
      `SELECT b.id FROM businesses b JOIN plans p ON p.id = b.plan_id
       WHERE b.status <> 'suspended'
         AND (cardinality($1::text[]) = 0 OR p.code = ANY($1))
         AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.business_id = b.id AND s.status = 'active' AND s.current_end BETWEEN now() AND now() + make_interval(days => $2)))
         AND ($3::int IS NULL OR COALESCE(b.last_active_at, b.created_at) < now() - make_interval(days => $3))
         AND ($4::timestamptz IS NULL OR b.created_at >= $4)
         AND ($5::timestamptz IS NULL OR b.created_at < $5)
         AND (cardinality($6::uuid[]) = 0 OR b.id = ANY($6))`,
      [s.plans ?? [], s.renewalWithinDays ?? null, s.inactiveDays ?? null, s.signedUpAfter ?? null, s.signedUpBefore ?? null, s.businessIds ?? []],
    );
    return rows.map((r) => r.id as string);
  }

  async previewAudience(s: Segment, category: 'transactional' | 'marketing') {
    return this.db.adminTx(async (tx) => {
      const ids = await this.segment(tx, s);
      const people = ids.length ? await this.recipients(tx, ids, category === 'marketing') : [];
      return { businesses: ids.length, owners: people.length };
    });
  }

  /** Send a broadcast now (or at its scheduled time via the job). */
  async sendBroadcast(id: string) {
    const n = await this.db.adminTx(async (tx) => {
      const b = await tx.one(`UPDATE broadcasts SET status = 'sending' WHERE id = $1 AND status IN ('draft', 'scheduled') RETURNING *`, [id]);
      if (!b) return 0;
      const ids = await this.segment(tx, b.segment ?? {});
      const rows = ids.length ? await this.recipients(tx, ids, b.category === 'marketing') : [];
      const count = await this.queue(tx, rows, { content: b.content, channels: b.channels, broadcastId: b.id, dedupe: `broadcast:${b.id}`, link: b.link ?? '/bridge' });
      await tx.q(`UPDATE broadcasts SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
      return count;
    });
    await this.deliverDue();
    return n;
  }

  async sendScheduledBroadcasts() {
    const due = await this.db.adminTx((tx) => tx.q(`SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= now()`));
    for (const d of due) await this.sendBroadcast(d.id);
    return due.length;
  }

  /** Deliver queued messages whose time has come. */
  async deliverDue() {
    const due = await this.db.adminTx((tx) =>
      tx.q(`SELECT om.*, u.email FROM owner_messages om LEFT JOIN users u ON u.id = om.user_id WHERE om.status = 'queued' AND om.scheduled_for <= now() ORDER BY om.created_at LIMIT 200`),
    );
    for (const m of due) {
      try {
        if (m.channel === 'inapp') {
          const n = await this.db.withTenant(m.business_id, async (tx) => {
            const row = await tx.one(
              `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, 'orbit_message', $2, $3, $4) RETURNING id`,
              [m.user_id, JSON.stringify({ key: 'notify.raw', params: { text: m.subject } }), JSON.stringify({ key: 'notify.raw', params: { text: m.body } }), `/m/${m.id}`],
            );
            liveToBusiness(tx, { type: 'notification.new' });
            return row.id as string;
          });
          await this.db.adminTx((tx) => tx.q(`UPDATE owner_messages SET status = 'sent', sent_at = now(), notification_id = $2 WHERE id = $1`, [m.id, n]));
        } else if (m.channel === 'email') {
          const ok = await sendEmail(m.email, m.subject ?? 'Orbit', m.body, m.id);
          await this.db.adminTx((tx) => tx.q(`UPDATE owner_messages SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() END, error = $3 WHERE id = $1`, [m.id, ok.status, ok.error ?? null]));
        } else {
          await this.db.adminTx((tx) => tx.q(`UPDATE owner_messages SET status = 'unavailable', error = $2 WHERE id = $1`, [m.id, `${m.channel} to owners is not connected yet`]));
        }
      } catch (e) {
        logger.error(`owner message ${m.id} failed: ${(e as Error).message}`, (e as Error).stack, 'Messaging');
        await this.db.adminTx((tx) => tx.q(`UPDATE owner_messages SET status = 'failed', error = $2 WHERE id = $1`, [m.id, (e as Error).message.slice(0, 300)])).catch(() => undefined);
      }
    }
    return due.length;
  }

  /** Delivery, read and click counts for a template or a broadcast. Reads come from the bell (in-app) or the email open pixel. */
  async stats(filter: { templateKey?: string; broadcastId?: string }) {
    return this.db.adminTx((tx) =>
      tx.one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE om.status = 'sent')::int AS sent,
                count(*) FILTER (WHERE om.status = 'failed')::int AS failed,
                count(*) FILTER (WHERE om.status IN ('unavailable', 'skipped'))::int AS unavailable,
                count(*) FILTER (WHERE om.status = 'queued')::int AS queued,
                count(*) FILTER (WHERE om.read_at IS NOT NULL OR n.read_at IS NOT NULL)::int AS read,
                count(*) FILTER (WHERE om.clicked_at IS NOT NULL)::int AS clicked
         FROM owner_messages om LEFT JOIN notifications n ON n.id = om.notification_id
         WHERE ($1::text IS NULL OR om.template_key = $1) AND ($2::uuid IS NULL OR om.broadcast_id = $2)`,
        [filter.templateKey ?? null, filter.broadcastId ?? null],
      ),
    );
  }
}

/** Email through Resend's API (EMAIL_API_KEY, EMAIL_FROM). Without a key, email is recorded as unavailable. */
async function sendEmail(to: string | null, subject: string, body: string, messageId: string): Promise<{ status: 'sent' | 'failed' | 'unavailable'; error?: string }> {
  if (!to) return { status: 'unavailable', error: 'no email address' };
  const key = process.env.EMAIL_API_KEY;
  if (!key) return { status: 'unavailable', error: 'Email sending is not set up (EMAIL_API_KEY)' };
  const api = (process.env.API_PUBLIC_URL ?? '').replace(/\/$/, '');
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const linked = esc(body).replace(/(https?:\/\/[^\s]+)/g, (u) => `<a href="${api ? `${api}/m/${messageId}/click?to=${encodeURIComponent(u)}` : u}">${u}</a>`);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1a3a">${linked.replace(/\n/g, '<br>')}</div>${api ? `<img src="${api}/m/${messageId}/open.gif" width="1" height="1" alt="">` : ''}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Orbit <onboarding@resend.dev>', to: [to], subject, html, text: body }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ message: e.message }) }) as any);
  if (res.ok) return { status: 'sent' };
  const d: any = await res.json().catch(() => ({}));
  return { status: 'failed', error: String(d?.message ?? `email error ${res.status}`).slice(0, 300) };
}

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

/** Read and click tracking for owner messages (ids are unguessable UUIDs). */
@Controller('m')
export class OwnerMessageTrackingController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get(':id/open.gif')
  async open(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    await this.db.adminTx((tx) => tx.q(`UPDATE owner_messages SET read_at = COALESCE(read_at, now()) WHERE id = $1`, [id])).catch(() => undefined);
    res.setHeader('content-type', 'image/gif');
    res.setHeader('cache-control', 'no-store');
    res.end(PIXEL);
  }

  @Public()
  @Get(':id/click')
  async click(@Param('id', ParseUUIDPipe) id: string, @Query('to') to: string | undefined, @Res() res: Response) {
    const m = await this.db.adminTx((tx) => tx.one(`UPDATE owner_messages SET clicked_at = COALESCE(clicked_at, now()), read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING link`, [id])).catch(() => null);
    // Only ever redirect into Orbit itself.
    const target = to && to.startsWith(runtime.webBaseUrl) ? to : `${runtime.webBaseUrl}${m?.link ?? '/bridge'}`;
    res.redirect(302, target);
  }
}
