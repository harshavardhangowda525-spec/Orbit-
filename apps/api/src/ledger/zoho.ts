/**
 * Zoho Books (India data centre by default): OAuth and the few Books APIs Orbit
 * uses: organisation, contacts, taxes, invoices and customer payments.
 */
export const ZOHO_SCOPES = [
  'ZohoBooks.settings.READ',
  'ZohoBooks.contacts.CREATE',
  'ZohoBooks.contacts.READ',
  'ZohoBooks.invoices.CREATE',
  'ZohoBooks.invoices.UPDATE',
  'ZohoBooks.customerpayments.CREATE',
];

export const zohoConfig = {
  get clientId() {
    return process.env.ZOHO_CLIENT_ID ?? '';
  },
  get clientSecret() {
    return process.env.ZOHO_CLIENT_SECRET ?? '';
  },
  get redirectUri() {
    return process.env.ZOHO_REDIRECT_URI ?? 'http://localhost:4000/powers/oauth/zoho/callback';
  },
  /** Where owners sign in: India by default; Zoho tells us the right data centre on the way back. */
  get accounts() {
    return (process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.in').replace(/\/$/, '');
  },
  get ready() {
    return !!(this.clientId && this.clientSecret);
  },
};

export interface ZohoTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  api_domain: string;
  accounts: string;
  organization_id?: string;
}

export class ZohoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function authUrl(state: string) {
  const p = new URLSearchParams({ scope: ZOHO_SCOPES.join(','), client_id: zohoConfig.clientId, response_type: 'code', redirect_uri: zohoConfig.redirectUri, access_type: 'offline', prompt: 'consent', state });
  return `${zohoConfig.accounts}/oauth/v2/auth?${p}`;
}

/** Only real Zoho account servers may be used for the token exchange. */
export function accountsServer(fromCallback: string | undefined): string {
  try {
    const u = new URL(fromCallback ?? '');
    if (u.protocol === 'https:' && /^accounts\.zoho\.(com|in|eu|com\.au|jp|ca|sa|uk|com\.cn)$/.test(u.hostname)) return `https://${u.hostname}`;
  } catch {
    /* fall back */
  }
  return zohoConfig.accounts;
}

async function token(accounts: string, params: Record<string, string>) {
  const q = new URLSearchParams({ client_id: zohoConfig.clientId, client_secret: zohoConfig.clientSecret, ...params });
  const res = await fetch(`${accounts}/oauth/v2/token?${q}`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new ZohoError(res.status || 400, d.error ?? 'Zoho sign-in failed');
  return d;
}

export async function exchangeCode(code: string, accounts: string): Promise<ZohoTokens> {
  const d = await token(accounts, { grant_type: 'authorization_code', code, redirect_uri: zohoConfig.redirectUri });
  return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, api_domain: d.api_domain ?? 'https://www.zohoapis.in', accounts };
}

export async function refresh(t: ZohoTokens): Promise<ZohoTokens> {
  const d = await token(t.accounts, { grant_type: 'refresh_token', refresh_token: t.refresh_token ?? '' });
  return { ...t, access_token: d.access_token, expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000, api_domain: d.api_domain ?? t.api_domain };
}

async function books(t: ZohoTokens, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  const q = new URLSearchParams({ ...(t.organization_id ? { organization_id: t.organization_id } : {}), ...(init.query ?? {}) });
  const res = await fetch(`${t.api_domain}/books/v3${path}${q.toString() ? `?${q}` : ''}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Zoho-oauthtoken ${t.access_token}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || (d.code !== undefined && d.code !== 0)) throw new ZohoError(res.status >= 400 ? res.status : 400, d.message ?? `Zoho Books error ${res.status}`);
  return d;
}

export async function organization(t: ZohoTokens): Promise<{ id: string; name: string }> {
  const d = await books({ ...t, organization_id: undefined }, '/organizations');
  const o = (d.organizations ?? []).find((x: any) => x.is_default_org) ?? d.organizations?.[0];
  if (!o) throw new ZohoError(400, 'No Zoho Books organisation on this account.');
  return { id: String(o.organization_id), name: o.name };
}

export interface ZohoTax {
  tax_id: string;
  tax_percentage: number;
  tax_type: string;
  tax_specific_type?: string;
}

export async function taxes(t: ZohoTokens): Promise<ZohoTax[]> {
  return (await books(t, '/settings/taxes')).taxes ?? [];
}

/** The Zoho tax for a GST rate: the CGST+SGST group within the state, IGST across states. */
export function pickTax(list: ZohoTax[], rate: number, interState: boolean): string | undefined {
  if (!rate) return undefined;
  const same = list.filter((x) => Number(x.tax_percentage) === rate);
  const hit = interState ? same.find((x) => (x.tax_specific_type ?? '').toLowerCase() === 'igst') : same.find((x) => x.tax_type === 'tax_group');
  return hit?.tax_id;
}

export async function createContact(t: ZohoTokens, c: { name: string; phone?: string | null; email?: string | null; gstin?: string | null; state?: string | null }): Promise<string> {
  const d = await books(t, '/contacts', {
    body: {
      contact_name: c.name,
      contact_type: 'customer',
      gst_treatment: c.gstin ? 'business_gst' : 'consumer',
      ...(c.gstin ? { gst_no: c.gstin } : {}),
      ...(c.state ? { place_of_contact: c.state } : {}),
      contact_persons: c.phone || c.email ? [{ first_name: c.name.slice(0, 100), phone: c.phone ?? undefined, email: c.email ?? undefined, is_primary_contact: true }] : [],
    },
  });
  return String(d.contact.contact_id);
}

export async function createInvoice(t: ZohoTokens, body: Record<string, unknown>): Promise<string> {
  const d = await books(t, '/invoices', { body, query: { ignore_auto_number_generation: 'true' } });
  const id = String(d.invoice.invoice_id);
  await books(t, `/invoices/${id}/status/sent`, { method: 'POST' }).catch(() => undefined);
  return id;
}

export const voidInvoice = (t: ZohoTokens, id: string) => books(t, `/invoices/${encodeURIComponent(id)}/status/void`, { method: 'POST' });

export async function createPayment(t: ZohoTokens, body: Record<string, unknown>): Promise<string> {
  const d = await books(t, '/customerpayments', { body });
  return String(d.payment.payment_id);
}
