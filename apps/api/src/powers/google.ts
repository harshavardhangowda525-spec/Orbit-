import { config, runtime } from '../config';

/** Thin Google OAuth + REST client (fetch). Kept small so it is easy to mock in tests. */
export const GOOGLE_SCOPES: Record<string, string[]> = {
  google_calendar: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'],
  // modify = read enquiries, mark them read, and send replies. No delete, no settings.
  gmail: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'],
};

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // ms epoch
  scope?: string;
}

export class GoogleError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const googleConfigured = () => !!(config.googleClientId && runtime.googleClientSecret);

export function authUrl(power: string, state: string) {
  const p = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: runtime.googleRedirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES[power].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function call(url: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(url, {
    ...init,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new GoogleError(res.status, data.error?.status ?? data.error ?? 'error', data.error_description ?? data.error?.message ?? `Google error ${res.status}`);
  return data;
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const d = await call('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: runtime.googleClientSecret, redirect_uri: runtime.googleRedirectUri, grant_type: 'authorization_code' }),
  });
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in ?? 3600) * 1000, scope: d.scope };
}

export async function refreshTokens(refresh: string): Promise<GoogleTokens> {
  const d = await call('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refresh, client_id: config.googleClientId, client_secret: runtime.googleClientSecret, grant_type: 'refresh_token' }),
  });
  return { access_token: d.access_token, refresh_token: refresh, expires_at: Date.now() + (d.expires_in ?? 3600) * 1000, scope: d.scope };
}

export async function revoke(token: string) {
  await call(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
}

export const userEmail = (access: string) => call('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${access}` } }).then((d) => d.email as string);

const auth = (access: string) => ({ authorization: `Bearer ${access}` });

export const calendar = {
  async freeBusy(access: string, from: Date, to: Date) {
    const d = await call('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', headers: auth(access), json: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] } });
    return ((d.calendars?.primary?.busy ?? []) as { start: string; end: string }[]).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  },
  insert: (access: string, ev: unknown) => call('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: auth(access), json: ev }),
  patch: (access: string, id: string, ev: unknown) => call(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'PATCH', headers: auth(access), json: ev }),
  remove: (access: string, id: string) => call(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth(access) }).catch((e) => {
    if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
  }),
};

export const gmail = {
  listUnread: (access: string) => call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: 'in:inbox is:unread newer_than:2d -category:promotions -category:social', maxResults: '10' })}`, { headers: auth(access) }).then((d) => (d.messages ?? []) as { id: string; threadId: string }[]),
  get: (access: string, id: string) => call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth(access) }),
  markRead: (access: string, id: string) => call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, { method: 'POST', headers: auth(access), json: { removeLabelIds: ['UNREAD'] } }),
  send: (access: string, raw: string, threadId?: string) => call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: auth(access), json: { raw, threadId } }),
};

/** Parse a Gmail API message into plain fields. */
export function parseGmail(m: any) {
  const headers: Record<string, string> = Object.fromEntries((m.payload?.headers ?? []).map((h: any) => [h.name.toLowerCase(), h.value]));
  const from = headers.from ?? '';
  const email = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const name = from.includes('<') ? from.split('<')[0].replace(/"/g, '').trim() : null;
  const find = (p: any): string | null => {
    if (!p) return null;
    if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
    for (const part of p.parts ?? []) {
      const t = find(part);
      if (t) return t;
    }
    return null;
  };
  const text = (find(m.payload) ?? m.snippet ?? '').replace(/\r/g, '');
  // Drop quoted history ("On ... wrote:" and "> " lines) so Aria sees only the new message.
  const fresh = text.split(/\nOn .+wrote:\n|\n-{2,} ?Original Message/)[0].split('\n').filter((l: string) => !l.startsWith('>')).join('\n').trim();
  return { id: m.id as string, threadId: m.threadId as string, email, name, subject: headers.subject ?? '', messageId: headers['message-id'] ?? null, body: fresh.slice(0, 4000), autoReply: !!headers['auto-submitted'] && headers['auto-submitted'] !== 'no' };
}

/** RFC 2822 reply, base64url encoded for the Gmail send API. */
export function buildReply(o: { to: string; from?: string; subject: string; inReplyTo?: string | null; body: string }) {
  const subject = /^re:/i.test(o.subject) ? o.subject : `Re: ${o.subject || 'Your enquiry'}`;
  const lines = [
    `To: ${o.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    '',
    o.body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}
