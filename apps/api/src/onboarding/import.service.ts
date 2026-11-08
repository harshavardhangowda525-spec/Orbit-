import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { logger } from '../logger';

/** What quick import could fill in. The owner reviews everything on one screen. */
export interface ImportResult {
  source: 'website' | 'instagram' | 'google_maps' | 'unknown';
  ok: boolean;
  /** Translation key for a plain sentence telling the owner what happened. */
  messageKey: string;
  fields: {
    name?: string;
    phone?: string;
    address?: string;
    description?: string;
    website?: string;
    instagram?: string;
    photos?: string[];
  };
}

/**
 * Import adapters. Each source sits behind its own function so a real provider
 * (e.g. Google Places API) can be plugged in without touching onboarding.
 * Sources without an official API are never scraped.
 */
@Injectable()
export class ImportService {
  async run(input: string): Promise<ImportResult> {
    const raw = input.trim();
    const ig = raw.match(/^@([\w.]{1,30})$/) ?? raw.match(/instagram\.com\/([\w.]{1,30})/i);
    if (ig) return this.instagram(ig[1]);
    if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\./i.test(raw)) return this.googleMaps(raw);
    const url = /^https?:\/\//i.test(raw) ? raw : /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(raw) ? `https://${raw}` : null;
    if (url) return this.website(url);
    return { source: 'unknown', ok: false, messageKey: 'import.unknown', fields: {} };
  }

  /** Instagram has no public profile API for this; we keep the link and the owner types the rest. */
  private instagram(handle: string): ImportResult {
    return { source: 'instagram', ok: true, messageKey: 'import.instagram_saved', fields: { instagram: `https://instagram.com/${handle}` } };
  }

  /** Full details need the Google Places API (key not configured yet); we read the place name from the link. */
  private googleMaps(link: string): ImportResult {
    const m = link.match(/\/maps\/place\/([^/@?]+)/);
    const name = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() : undefined;
    return { source: 'google_maps', ok: !!name, messageKey: name ? 'import.maps_name_only' : 'import.maps_link_saved', fields: name ? { name } : {} };
  }

  async website(url: string): Promise<ImportResult> {
    const fail: ImportResult = { source: 'website', ok: false, messageKey: 'import.website_failed', fields: { website: url } };
    try {
      const html = await safeFetchText(url);
      if (!html) return fail;
      const fields = parseBusinessHtml(html, url);
      const ok = !!(fields.name || fields.phone || fields.description);
      return { source: 'website', ok, messageKey: ok ? 'import.website_ok' : 'import.website_failed', fields: { website: url, ...fields } };
    } catch (e) {
      logger.warn(`website import failed: ${(e as Error).message}`, 'Import');
      return fail;
    }
  }
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Fetch a public web page with SSRF protection, a timeout and a size cap. */
async function safeFetchText(start: string, maxBytes = 1_000_000): Promise<string | null> {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) return null;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'OrbitImport/1.0', accept: 'text/html' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return null;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function meta(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decode(content) : undefined;
}

/** Extract business details from a page: JSON-LD LocalBusiness first, then meta tags. Exported for tests. */
export function parseBusinessHtml(html: string, baseUrl: string): ImportResult['fields'] {
  const out: ImportResult['fields'] = {};
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const items: any[] = Array.isArray(data) ? data : data['@graph'] ?? [data];
      const biz = items.find((i) => i && typeof i === 'object' && (i.telephone !== undefined || i.address !== undefined));
      if (biz) {
        if (typeof biz.name === 'string') out.name = decode(biz.name);
        if (typeof biz.telephone === 'string') out.phone = biz.telephone.trim();
        if (typeof biz.description === 'string') out.description = decode(biz.description);
        const a = biz.address;
        if (typeof a === 'string') out.address = decode(a);
        else if (a && typeof a === 'object') {
          out.address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ');
        }
        const img = Array.isArray(biz.image) ? biz.image : biz.image ? [biz.image] : [];
        const photos = img.map((i: any) => (typeof i === 'string' ? i : i?.url)).filter((u: unknown) => typeof u === 'string');
        if (photos.length) out.photos = photos.slice(0, 6);
        break;
      }
    } catch {
      /* ignore bad JSON-LD */
    }
  }
  const title = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1];
  out.name ??= meta(html, 'property', 'og:site_name') ?? (title ? decode(title).split(/\s[|\u2013-]\s/)[0] : undefined);
  out.description ??= meta(html, 'name', 'description') ?? meta(html, 'property', 'og:description');
  out.phone ??= html.match(/href=["']tel:([+\d\s-]{6,20})["']/i)?.[1]?.trim();
  if (!out.photos) {
    const og = meta(html, 'property', 'og:image');
    if (og) out.photos = [new URL(og, baseUrl).toString()];
  }
  if (out.description && out.description.length > 400) out.description = out.description.slice(0, 397) + '...';
  return out;
}
