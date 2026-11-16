import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TEMPLATES, WEEKDAYS, isValidWeeklyHours, parseIndianPrice, asciiDigits, type BusinessType, type WeeklyHours } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { AiService } from '../ai/ai.service';
import { AiUnavailableError } from '../ai/provider';
import { FilesService } from '../files/files.service';
import { UsageService } from '../billing/usage.service';
import { AppError, badRequest } from '../common/errors';
import { logger } from '../logger';

export type SnapKind = 'price_list' | 'card' | 'hours' | 'bill' | 'settlement';
/** Below this, a field is shown in amber with "Please check". */
export const CHECK_BELOW = 0.8;

const num = z.preprocess((v) => (v === '' || v == null ? null : typeof v === 'string' ? Number(asciiDigits(v).replace(/[^\d.]/g, '')) || null : v), z.number().nonnegative().nullable());
const conf = z.preprocess((v) => (typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0.5), z.number());
const str = (max = 200) => z.preprocess((v) => (v == null || v === '' ? null : String(v).trim().slice(0, max)), z.string().nullable());

const PriceListOut = z.object({
  is_price_list: z.boolean().default(true),
  readable: z.boolean().default(true),
  services: z.array(z.object({
    name: str(120),
    name_en: str(120).optional(),
    category: str(60).optional(),
    price_text: str(60).optional(),
    price: num.optional(),
    duration_minutes: num.optional(),
    description: str(300).optional(),
    language: str(10).optional(),
    confidence: conf.optional(),
    variants: z.array(z.object({ label: str(40), price_text: str(60).optional(), price: num.optional() })).optional(),
  })).default([]),
});

const BillOut = z.object({
  is_bill: z.boolean().default(true),
  readable: z.boolean().default(true),
  vendor_name: str(120),
  vendor_gstin: str(20).optional(),
  bill_number: str(60).optional(),
  bill_date: str(20).optional(),
  bill_date_text: str(40).optional(),
  items: z.array(z.object({ name: str(160), qty: num.optional(), rate: num.optional(), amount: num.optional() })).default([]),
  subtotal: num.optional(),
  cgst: num.optional(), sgst: num.optional(), igst: num.optional(), cess: num.optional(),
  total: num,
  payment_mode: str(30).optional(),
  category_hint: str(40).optional(),
  confidence: z.record(conf).default({}),
});

const SettlementOut = z.object({ is_settlement: z.boolean().default(true), readable: z.boolean().default(true), total: num, date: str(20).optional(), mode: str(20).optional(), confidence: conf.optional() });
const CardOut = z.object({ readable: z.boolean().default(true), name: str(120).optional(), phone: str(30).optional(), address: str(300).optional(), hours: z.any().optional(), confidence: z.record(conf).default({}) });
const HoursOut = z.object({ readable: z.boolean().default(true), hours: z.record(z.array(z.array(z.string()))).nullable().optional(), confidence: conf.optional() });

const SYSTEM = [
  'You read photos for Orbit, an assistant for small businesses in India. Reply with ONE JSON object only, exactly in the requested shape.',
  'Copy names and words exactly as written, in their original script (Hindi, Kannada, English...). Never translate in place; put an English translation only in the *_en field.',
  'Never guess. If you cannot read a value, use null and give a low confidence (0 to 1). If the whole photo is too blurry or dark to read, set "readable": false.',
  'Prices: copy the price exactly as written into price_text (e.g. "350/-", "₹1,200", "500 onwards", "1.5 lakh"); also give the number in price when clear.',
].join('\n');

const PROMPTS: Record<SnapKind, string> = {
  price_list: `KIND: price_list
This should be a price list, menu, rate card or brochure. If it is not, set "is_price_list": false.
Return {"is_price_list": bool, "readable": bool, "services": [{"name": "as written", "name_en": "English name if not English, else null", "category": "section heading or null",
"price_text": "as written", "price": number|null, "duration_minutes": number|null (only if shown), "description": "or null", "language": "en|hi|kn|...", "confidence": 0-1,
"variants": [{"label": "e.g. Men / Women / Small", "price_text": "as written", "price": number|null}] (only when one service has several prices, else omit)}]}`,
  card: `KIND: card
A business card or shop signboard. Return {"readable": bool, "name": "business name or null", "phone": "or null", "address": "or null",
"hours": {"mon": [["10:00","20:00"]], ...} or null, "confidence": {"name": 0-1, "phone": 0-1, "address": 0-1}}`,
  hours: `KIND: hours
An opening-hours board. Return {"readable": bool, "hours": {"mon": [["HH:MM","HH:MM"]], "tue": [...], ..., "sun": []} (24h times, [] = closed), "confidence": 0-1}`,
  bill: `KIND: bill
A purchase bill, invoice or receipt the business PAID (rent, electricity, stock, salaries...). If it is not a bill, set "is_bill": false.
Return {"is_bill": bool, "readable": bool, "vendor_name": "as written", "vendor_gstin": "15-character GSTIN or null", "bill_number": "or null", "bill_date_text": "the date exactly as printed, e.g. 06/11/2026", "bill_date": "YYYY-MM-DD or null (Indian bills write the DAY first: 06/11/2026 is 6 November 2026, not June 11)",
"items": [{"name": "as written", "qty": number|null, "rate": number|null, "amount": number|null}], "subtotal": number|null, "cgst": number|null, "sgst": number|null, "igst": number|null, "cess": number|null,
"total": number|null, "payment_mode": "cash|upi|card|bank|null", "category_hint": "rent|salaries|supplies|utilities|electricity|internet|marketing|equipment|repairs|transport|food|professional_fees|other",
"confidence": {"vendor_name": 0-1, "bill_number": 0-1, "bill_date": 0-1, "total": 0-1, "tax": 0-1}}`,
  settlement: `KIND: settlement
A UPI app or card-machine settlement / daily summary screenshot. If it is not, set "is_settlement": false.
Return {"is_settlement": bool, "readable": bool, "total": number|null (the total received), "date": "YYYY-MM-DD or null", "mode": "upi|card|null", "confidence": 0-1}`,
};

/** Pull the JSON object out of a model reply (it may add ``` fences or a sentence). */
export function jsonFrom(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('no JSON in reply');
  }
}

const key = (s: string | null | undefined) => (s ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface SnapServiceDraft {
  ref: string;
  name: string;
  nameEn: string | null;
  category: string | null;
  price: number | null;
  priceType: 'fixed' | 'from' | 'range' | 'per_hour';
  priceMax: number | null;
  priceText: string | null;
  durationMin: number;
  durationSuggested: boolean;
  description: string | null;
  language: string | null;
  confidence: number;
  check: string[];
  variantOf: string | null;
  duplicate: { id: string; name: string; price: number | null } | null;
}

/**
 * Snap: photos in, a draft out. Reads price lists, business cards, hours boards,
 * bills and settlement screenshots with the business's AI tier, validates the
 * reply, and stores the draft. Nothing is saved to the business until the owner
 * confirms the draft (see apply in SnapController / Khata).
 */
@Injectable()
export class SnapService {
  constructor(private readonly db: DbService, private readonly ai: AiService, private readonly files: FilesService, private readonly usage: UsageService) {}

  /** Read the photos. The AI call runs outside any database transaction (it can take ~15 s). */
  async read(businessId: string, kind: SnapKind, fileIds: string[], userId: string) {
    if (!fileIds.length || fileIds.length > 5) throw badRequest('photos', 'Add 1 to 5 photos.');
    const { snapId, images } = await this.db.withTenant(businessId, async (tx) => {
      // A price list, card or hours board is one Orbit action against the owner's daily allowance.
      if (kind !== 'bill' && kind !== 'settlement') {
        const allowed = await this.usage.assistantAllowed(tx);
        if (!allowed.allowed) throw new AppError(429, 'limit', 'You have used today’s Orbit actions. Try again tomorrow, or type it in for now.');
      }
      const known = await tx.q(`SELECT id FROM files WHERE id = ANY($1::uuid[])`, [fileIds]);
      if (known.length !== new Set(fileIds).size) throw badRequest('photos', 'That photo is no longer here. Please upload it again.');
      const snap = await tx.one(`INSERT INTO snaps (kind, file_ids, created_by) VALUES ($1, $2, $3) RETURNING id`, [kind, fileIds, userId]);
      return { snapId: snap.id as string, images: await this.files.forVision(tx, fileIds) };
    }, userId);
    let raw: unknown;
    let problem: string | null = null;
    try {
      const res = await this.ai.see(businessId, kind === 'bill' || kind === 'settlement' ? 'khata' : 'orbit', { system: SYSTEM, prompt: PROMPTS[kind], images, maxTokens: 4000 });
      raw = jsonFrom(res.text);
    } catch (e) {
      logger.warn(`snap ${kind} failed: ${(e as Error).message}`, 'Snap');
      problem = e instanceof AiUnavailableError ? 'unavailable' : 'unreadable';
    }
    return this.db.withTenant(businessId, async (tx) => {
      const out = problem ? { problem, result: undefined } : await this.normalise(tx, kind, raw);
      await tx.q(`UPDATE snaps SET result = $2, problem = $3, status = CASE WHEN $3::text IS NULL THEN 'draft' ELSE 'failed' END WHERE id = $1`, [snapId, JSON.stringify(out.result ?? null), out.problem]);
      return { id: snapId, kind, fileIds, problem: out.problem, ...(out.result ? { result: out.result } : {}) };
    }, userId);
  }

  private async normalise(tx: Tx, kind: SnapKind, raw: unknown): Promise<{ problem: string | null; result?: any }> {
    if (kind === 'price_list') {
      const p = PriceListOut.safeParse(raw);
      if (!p.success) return { problem: 'unreadable' };
      if (!p.data.is_price_list) return { problem: 'not_a_price_list' };
      const services = await this.priceList(tx, p.data.services);
      if (!p.data.readable || !services.length) return { problem: 'unreadable' };
      return { problem: null, result: { services } };
    }
    if (kind === 'bill') {
      const p = BillOut.safeParse(raw);
      if (!p.success) return { problem: 'unreadable' };
      if (!p.data.is_bill) return { problem: 'not_a_bill' };
      if (!p.data.readable || p.data.total == null) return { problem: 'unreadable' };
      return { problem: null, result: p.data };
    }
    if (kind === 'settlement') {
      const p = SettlementOut.safeParse(raw);
      if (!p.success) return { problem: 'unreadable' };
      if (!p.data.is_settlement) return { problem: 'not_a_settlement' };
      if (!p.data.readable || p.data.total == null) return { problem: 'unreadable' };
      return { problem: null, result: p.data };
    }
    if (kind === 'card') {
      const p = CardOut.safeParse(raw);
      if (!p.success || !p.data.readable || !(p.data.name || p.data.phone || p.data.address)) return { problem: 'unreadable' };
      return { problem: null, result: { name: p.data.name ?? null, phone: p.data.phone ?? null, address: p.data.address ?? null, hours: toWeekly(p.data.hours), confidence: p.data.confidence } };
    }
    const p = HoursOut.safeParse(raw);
    const hours = p.success ? toWeekly(p.data.hours) : null;
    if (!p.success || !p.data.readable || !hours) return { problem: 'unreadable' };
    return { problem: null, result: { hours, confidence: p.data.confidence ?? 0.5 } };
  }

  /** Price list rows → editable drafts: prices re-read with Indian formats, durations suggested, duplicates found. */
  private async priceList(tx: Tx, rows: z.infer<typeof PriceListOut>['services']): Promise<SnapServiceDraft[]> {
    const biz = await tx.one(`SELECT type FROM businesses WHERE id = app_current_business()`);
    const template = TEMPLATES[biz.type as BusinessType] ?? TEMPLATES.other;
    const existing = await tx.q(`SELECT id, name, name_en, price::float AS price FROM services WHERE deleted_at IS NULL`);
    const typical = Math.round(template.services.reduce((s, x) => s + x.durationMin, 0) / Math.max(1, template.services.length) / 5) * 5 || 30;
    const out: SnapServiceDraft[] = [];
    let n = 0;
    const push = (r: (typeof rows)[number], name: string, priceText: string | null | undefined, priceNum: number | null | undefined, variantOf: string | null) => {
      if (!name) return;
      const parsed = parseIndianPrice(priceText ?? null) ?? (priceNum != null ? parseIndianPrice(priceNum) : null);
      const confidence = r.confidence ?? 0.5;
      const check: string[] = [];
      if (confidence < CHECK_BELOW) check.push('name', 'price');
      // The model's number and the text disagree: show it, ask the owner.
      if (parsed && priceNum != null && Math.abs(parsed.price - priceNum) > 0.5 && !check.includes('price')) check.push('price');
      if (!parsed && (priceText || priceNum != null)) check.push('price');
      const shown = r.duration_minutes && r.duration_minutes > 0 && r.duration_minutes <= 600 ? Math.round(r.duration_minutes) : null;
      const like = template.services.find((s) => key(s.name) === key(r.name_en ?? r.name) || key(r.name_en ?? r.name).includes(key(s.name)));
      const k = key(name);
      const ke = key(r.name_en);
      const dup = existing.find((e) => key(e.name) === k || (ke && (key(e.name) === ke || key(e.name_en) === ke)));
      out.push({
        ref: `s${++n}`,
        name,
        nameEn: r.name_en && key(r.name_en) !== k ? r.name_en : null,
        category: r.category ?? null,
        price: parsed?.price ?? null,
        priceType: parsed?.type ?? 'fixed',
        priceMax: parsed?.priceMax ?? null,
        priceText: priceText ?? null,
        durationMin: shown ?? like?.durationMin ?? typical,
        durationSuggested: !shown,
        description: r.description ?? null,
        language: r.language ?? null,
        confidence,
        check,
        variantOf,
        duplicate: dup ? { id: dup.id, name: dup.name, price: dup.price } : null,
      });
    };
    for (const r of rows) {
      if (!r.name) continue;
      if (r.variants?.length) for (const v of r.variants) push(r, v.label ? `${r.name} – ${v.label}` : r.name, v.price_text, v.price, r.name);
      else push(r, r.name, r.price_text, r.price, null);
    }
    return out;
  }
}

/** {"mon": [["10:00","20:00"]], ...} → WeeklyHours (null when unusable). */
export function toWeekly(h: unknown): WeeklyHours | null {
  if (!h || typeof h !== 'object') return null;
  const re = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
  const out = {} as WeeklyHours;
  for (const d of WEEKDAYS) {
    const v = (h as Record<string, unknown>)[d];
    const ranges = Array.isArray(v) ? (v as unknown[]).filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && re.test(String(r[0])) && re.test(String(r[1]))).map(([a, b]) => ({ from: pad(a), to: pad(b) })).filter((r) => r.from < r.to) : [];
    out[d] = { open: ranges.length > 0, ranges };
  }
  return isValidWeeklyHours(out) && WEEKDAYS.some((d) => out[d].open) ? out : null;
}
