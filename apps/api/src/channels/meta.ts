import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta Graph API for customer channels: WhatsApp Cloud API, Messenger and
 * Instagram messaging. One Orbit Meta app receives every business's webhooks;
 * each business connects its own number/page with its own access token.
 */
export type MetaChannel = 'whatsapp' | 'messenger' | 'instagram';
export const META_CHANNELS: MetaChannel[] = ['whatsapp', 'messenger', 'instagram'];

export const metaConfig = {
  get appSecret() {
    return process.env.META_APP_SECRET ?? '';
  },
  get verifyToken() {
    return process.env.META_VERIFY_TOKEN ?? '';
  },
  get version() {
    return process.env.META_GRAPH_VERSION || 'v27.0';
  },
  get graph() {
    return `https://graph.facebook.com/${this.version}`;
  },
  get appId() {
    return process.env.META_APP_ID ?? '';
  },
  /** Facebook Login for Business configuration of the "WhatsApp Embedded Signup" kind. */
  get whatsappConfigId() {
    return process.env.META_WA_CONFIG_ID ?? '';
  },
  /** Facebook Login for Business configuration for Pages + Instagram messaging. */
  get loginConfigId() {
    return process.env.META_LOGIN_CONFIG_ID ?? '';
  },
  /** One-click connect needs the app id and the configuration ids as well. */
  get oneClick() {
    return { whatsapp: !!(this.ready && this.appId && this.whatsappConfigId), pages: !!(this.ready && this.appId && this.loginConfigId) };
  },
  /** Webhooks can be received (and channels connected) only with the app secret and verify token set. */
  get ready() {
    return !!(this.appSecret && this.verifyToken);
  },
};

export class MetaError extends Error {
  constructor(public status: number, message: string, public code?: number) {
    super(message);
  }
}

async function graph(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${metaConfig.graph}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new MetaError(res.status, data?.error?.message ?? `Meta API error ${res.status}`, data?.error?.code);
  return data;
}

/** Webhook signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
export function validSignature(raw: Buffer | undefined, header: string | undefined): boolean {
  if (!raw || !header?.startsWith('sha256=') || !metaConfig.appSecret) return false;
  const expected = createHmac('sha256', metaConfig.appSecret).update(raw).digest();
  const got = Buffer.from(header.slice(7), 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------- connecting ----------

/** Checks the details the owner entered and returns a label for the connection. */
export async function checkAccount(channel: MetaChannel, accountId: string, token: string): Promise<string> {
  if (channel === 'whatsapp') {
    const d = await graph(`/${encodeURIComponent(accountId)}?fields=display_phone_number,verified_name`, token);
    return [d.verified_name, d.display_phone_number].filter(Boolean).join(' · ') || accountId;
  }
  if (channel === 'messenger') {
    const d = await graph(`/${encodeURIComponent(accountId)}?fields=name`, token);
    return d.name ?? accountId;
  }
  const d = await graph(`/${encodeURIComponent(accountId)}?fields=username,name`, token);
  return d.username ? `@${d.username}` : d.name ?? accountId;
}

/** Turn on webhooks for this page / Instagram account (WhatsApp is set up in the Meta app instead). */
export async function subscribeApp(channel: MetaChannel, pageId: string, token: string) {
  if (channel === 'whatsapp') return;
  await graph(`/${encodeURIComponent(pageId)}/subscribed_apps`, token, { body: { subscribed_fields: ['messages'] } });
}

// ---------- one-click connect (Embedded Signup / Facebook Login for Business) ----------

/** The short-lived code from the Meta popup -> a business token (server to server, within 30 seconds). */
export async function exchangeCode(code: string): Promise<string> {
  const q = new URLSearchParams({ client_id: metaConfig.appId, client_secret: metaConfig.appSecret, code });
  const res = await fetch(`${metaConfig.graph}/oauth/access_token?${q}`, { signal: AbortSignal.timeout(20_000) });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new MetaError(res.status || 400, d?.error?.message ?? 'Meta did not accept the sign-in. Please try again.');
  return d.access_token;
}

/** Receive this WhatsApp account's messages through Orbit's app. */
export async function subscribeWaba(wabaId: string, token: string) {
  await graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, token, { method: 'POST' });
}

/** Register the number for Cloud API with a two-step verification PIN. */
export async function registerNumber(phoneNumberId: string, token: string, pin: string) {
  await graph(`/${encodeURIComponent(phoneNumberId)}/register`, token, { body: { messaging_product: 'whatsapp', pin } });
}

export interface PageChoice {
  id: string;
  name: string;
  token: string;
  instagram: { id: string; username: string | null } | null;
}

/** Pages the owner granted, each with its Page token and linked Instagram professional account. */
export async function listPages(userToken: string): Promise<PageChoice[]> {
  const d = await graph(`/me/accounts?fields=id,name,access_token,instagram_business_account%7Bid,username%7D&limit=100`, userToken);
  return (d.data ?? []).filter((p: any) => p.id && p.access_token).map((p: any) => ({
    id: String(p.id),
    name: p.name ?? String(p.id),
    token: p.access_token,
    instagram: p.instagram_business_account?.id ? { id: String(p.instagram_business_account.id), username: p.instagram_business_account.username ?? null } : null,
  }));
}

// ---------- sending ----------

export interface SendResult {
  id: string;
}

export async function sendWhatsAppText(phoneNumberId: string, token: string, to: string, body: string): Promise<SendResult> {
  const d = await graph(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/\D/g, ''), type: 'text', text: { body, preview_url: true } },
  });
  return { id: d.messages?.[0]?.id ?? '' };
}

/** Outside the 24-hour window WhatsApp only allows approved templates; the message goes in as the {{1}} body variable. */
export async function sendWhatsAppTemplate(phoneNumberId: string, token: string, to: string, template: { name: string; language: string }, body: string): Promise<SendResult> {
  const d = await graph(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    body: {
      messaging_product: 'whatsapp',
      to: to.replace(/\D/g, ''),
      type: 'template',
      template: { name: template.name, language: { code: template.language }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.slice(0, 1024) }] }] },
    },
  });
  return { id: d.messages?.[0]?.id ?? '' };
}

/** Messenger and Instagram. Inside 24 hours: a normal reply. Up to 7 days: only a person may reply (HUMAN_AGENT tag). */
export async function sendPageMessage(pageId: string, token: string, recipientId: string, body: string, humanAgent: boolean): Promise<SendResult> {
  const d = await graph(`/${encodeURIComponent(pageId)}/messages`, token, {
    body: {
      recipient: { id: recipientId },
      message: { text: body.slice(0, 2000) },
      ...(humanAgent ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : { messaging_type: 'RESPONSE' }),
    },
  });
  return { id: d.message_id ?? '' };
}

/** Display name of a Messenger / Instagram sender (best effort). */
export async function senderName(channel: MetaChannel, userId: string, token: string): Promise<string | null> {
  try {
    const d = await graph(`/${encodeURIComponent(userId)}?fields=${channel === 'instagram' ? 'name,username' : 'first_name,last_name,name'}`, token);
    return d.name ?? ([d.first_name, d.last_name].filter(Boolean).join(' ') || d.username || null);
  } catch {
    return null;
  }
}

// ---------- receiving ----------

export interface Inbound {
  channel: MetaChannel;
  /** WhatsApp phone_number_id, or the page / Instagram account id that received it. */
  accountId: string;
  /** WhatsApp: the customer's number (digits). Messenger/Instagram: their scoped id. */
  from: string;
  name: string | null;
  messageId: string;
  text: string;
  at: Date;
}

export interface StatusUpdate {
  channel: MetaChannel;
  accountId: string;
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error: string | null;
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[Photo]', video: '[Video]', audio: '[Voice note]', document: '[Document]', sticker: '[Sticker]', location: '[Location]', contacts: '[Contact card]',
};

function whatsappText(m: any): string {
  if (m.type === 'text') return m.text?.body ?? '';
  if (m.type === 'button') return m.button?.text ?? '';
  if (m.type === 'interactive') return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
  const caption = m[m.type]?.caption;
  const label = MEDIA_LABEL[m.type] ?? `[${m.type}]`;
  return caption ? `${label} ${caption}` : label;
}

/** Everything useful in one webhook delivery. Unknown shapes are ignored, never thrown on. */
export function parseWebhook(body: any): { messages: Inbound[]; statuses: StatusUpdate[] } {
  const messages: Inbound[] = [];
  const statuses: StatusUpdate[] = [];
  const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];
  if (body?.object === 'whatsapp_business_account') {
    for (const e of entries) {
      for (const ch of e.changes ?? []) {
        const v = ch.value ?? {};
        const accountId = String(v.metadata?.phone_number_id ?? '');
        if (!accountId) continue;
        const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [String(c.wa_id), c.profile?.name ?? null]));
        for (const m of v.messages ?? []) {
          const text = whatsappText(m).trim();
          if (!m.id || !m.from || !text) continue;
          messages.push({ channel: 'whatsapp', accountId, from: String(m.from), name: names.get(String(m.from)) ?? null, messageId: String(m.id), text, at: new Date(Number(m.timestamp) * 1000 || Date.now()) });
        }
        for (const s of v.statuses ?? []) {
          if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
          statuses.push({ channel: 'whatsapp', accountId, messageId: String(s.id), status: s.status, error: s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? null });
        }
      }
    }
  } else if (body?.object === 'page' || body?.object === 'instagram') {
    const channel: MetaChannel = body.object === 'page' ? 'messenger' : 'instagram';
    for (const e of entries) {
      const accountId = String(e.id ?? '');
      for (const ev of e.messaging ?? []) {
        const m = ev.message;
        if (!m || m.is_echo || !ev.sender?.id || !m.mid) continue;
        const text = (m.text ?? (m.attachments?.length ? MEDIA_LABEL[m.attachments[0].type] ?? '[Attachment]' : '')).trim();
        if (!text) continue;
        messages.push({ channel, accountId, from: String(ev.sender.id), name: null, messageId: String(m.mid), text, at: new Date(Number(ev.timestamp) || Date.now()) });
      }
    }
  }
  return { messages, statuses };
}
