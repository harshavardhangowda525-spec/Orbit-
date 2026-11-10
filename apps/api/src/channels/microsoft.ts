/**
 * Microsoft identity platform + Graph for Outlook email (work, school and
 * personal accounts: tenant "common"). Same shape as the Gmail client.
 */
export const MS_SCOPES = ['openid', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'];
const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const msConfig = {
  get clientId() {
    return process.env.MICROSOFT_CLIENT_ID ?? '';
  },
  get clientSecret() {
    return process.env.MICROSOFT_CLIENT_SECRET ?? '';
  },
  get redirectUri() {
    return process.env.MICROSOFT_REDIRECT_URI ?? 'http://localhost:4000/powers/oauth/microsoft/callback';
  },
  get ready() {
    return !!(this.clientId && this.clientSecret);
  },
};

export interface MsTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

export class MsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function authUrl(state: string) {
  const p = new URLSearchParams({
    client_id: msConfig.clientId,
    response_type: 'code',
    redirect_uri: msConfig.redirectUri,
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    prompt: 'select_account',
    state,
  });
  return `${LOGIN}/authorize?${p}`;
}

async function token(params: Record<string, string>): Promise<MsTokens> {
  const res = await fetch(`${LOGIN}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: msConfig.clientId, client_secret: msConfig.clientSecret, scope: MS_SCOPES.join(' '), ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new MsError(res.status || 400, d.error_description ?? d.error ?? 'Microsoft sign-in failed');
  return { access_token: d.access_token, refresh_token: d.refresh_token ?? params.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
}

export const exchangeCode = (code: string) => token({ grant_type: 'authorization_code', code, redirect_uri: msConfig.redirectUri });
export const refresh = (refreshToken: string) => token({ grant_type: 'refresh_token', refresh_token: refreshToken });

async function graph(path: string, access: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${access}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const d = text ? JSON.parse(text) : {};
  if (!res.ok) throw new MsError(res.status, d?.error?.message ?? `Microsoft Graph error ${res.status}`);
  return d;
}

export async function mailbox(access: string): Promise<string | null> {
  const d = await graph('/me?$select=mail,userPrincipalName', access);
  return (d.mail ?? d.userPrincipalName ?? null)?.toLowerCase() ?? null;
}

export interface OutlookMessage {
  id: string;
  conversationId: string;
  subject: string;
  email: string | null;
  name: string | null;
  body: string;
  autoReply: boolean;
}

/** Unread mail in the inbox (newest 10), bodies as plain text without the quoted thread. */
export async function unread(access: string): Promise<OutlookMessage[]> {
  const q = new URLSearchParams({ $filter: 'isRead eq false', $top: '10', $select: 'id,conversationId,subject,from,uniqueBody,body,receivedDateTime', $orderby: 'receivedDateTime desc' });
  const d = await graph(`/me/mailFolders/inbox/messages?${q}`, access, { headers: { prefer: 'outlook.body-content-type="text"' } });
  return (d.value ?? []).map((m: any) => ({
    id: m.id,
    conversationId: m.conversationId,
    subject: m.subject ?? '',
    email: m.from?.emailAddress?.address?.toLowerCase() ?? null,
    name: m.from?.emailAddress?.name ?? null,
    body: String(m.uniqueBody?.content ?? m.body?.content ?? '').trim().slice(0, 4000),
    autoReply: /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)/i.test(m.subject ?? ''),
  }));
}

export const markRead = (access: string, id: string) => graph(`/me/messages/${encodeURIComponent(id)}`, access, { method: 'PATCH', body: { isRead: true } });

/** Reply in the same thread (keeps the subject and quoting the way Outlook does). */
export const reply = (access: string, id: string, text: string) => graph(`/me/messages/${encodeURIComponent(id)}/reply`, access, { body: { comment: text } });

export const send = (access: string, to: string, subject: string, text: string) =>
  graph('/me/sendMail', access, { body: { message: { subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true } });
