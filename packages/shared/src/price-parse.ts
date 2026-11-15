/**
 * Reads prices the way they are written on Indian price boards and bills:
 * "₹350", "Rs. 1,200", "350/-", "1,20,000", "1.5 lakh", "2L", "350-500",
 * "from 500", "500 onwards", "500+", "₹800/hr", and Devanagari or Kannada digits.
 * Returns null when there is no price (e.g. "on request").
 */
export type PriceType = 'fixed' | 'from' | 'range' | 'per_hour';
export interface ParsedPrice { price: number; priceMax: number | null; type: PriceType }

const DIGITS: Record<string, string> = {};
'०१२३४५६७८९'.split('').forEach((d, i) => (DIGITS[d] = String(i)));
'೦೧೨೩೪೫೬೭೮೯'.split('').forEach((d, i) => (DIGITS[d] = String(i)));

/** Devanagari / Kannada digits to 0-9. */
export function asciiDigits(s: string): string {
  return s.replace(/[०-९೦-೯]/g, (d) => DIGITS[d] ?? d);
}

const NUM = /(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?\s*(lakhs?|lacs?|l\b|k\b|thousand|हज़ार|हजार|ಸಾವಿರ|लाख|ಲಕ್ಷ)?/i;

function toNumber(m: RegExpMatchArray): number {
  const whole = Number(m[1].replace(/,/g, ''));
  const frac = m[2] ? Number(`0.${m[2]}`) : 0;
  const unit = (m[3] ?? '').toLowerCase();
  const mult = /^(lakhs?|lacs?|l|लाख|ಲಕ್ಷ)$/.test(unit) ? 100_000 : /^(k|thousand|हज़ार|हजार|ಸಾವಿರ)$/.test(unit) ? 1000 : 1;
  return Math.round((whole + frac) * mult * 100) / 100;
}

export function parseIndianPrice(raw: string | number | null | undefined): ParsedPrice | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? { price: raw, priceMax: null, type: 'fixed' } : null;
  let s = asciiDigits(String(raw)).trim();
  if (!s || /on request|ask|enquire|call/i.test(s)) return null;
  // "350/-" and "/-" endings are just "rupees only".
  s = s.replace(/\/-/g, '').replace(/₹|rs\.?|inr|rupees?|रु\.?|रुपये|ರೂ\.?/gi, ' ');
  const perHour = /\/\s*(hr|hour|h)\b|per\s*hour|प्रति घंटा|ಗಂಟೆಗೆ/i.test(s);
  const from = /\b(from|starting|starts|onwards|min\.?)\b|\+\s*$|से शुरू|ರಿಂದ/i.test(s);
  const nums = [...s.matchAll(new RegExp(NUM.source, 'gi'))].map(toNumber).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  if (nums.length >= 2 && /\d\s*(-|–|to|से|ರಿಂದ)\s*[\d₹]/i.test(s) && nums[1] > nums[0]) return { price: nums[0], priceMax: nums[1], type: 'range' };
  return { price: nums[0], priceMax: null, type: perHour ? 'per_hour' : from ? 'from' : 'fixed' };
}
