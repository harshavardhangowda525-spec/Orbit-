import { asciiDigits } from './price-parse';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const monthOf = (w: string): number | undefined => MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)];
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * A date as printed on an Indian bill, read day-first: "06/11/2026", "6-11-26",
 * "06.11.2026" are 6 November. Also "6 Nov 2026", "Nov 6, 2026" and ISO
 * "2026-11-06". Returns YYYY-MM-DD, or null when it is not a date.
 */
export function parseIndianDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = asciiDigits(String(raw)).trim().toLowerCase();
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?[\s-]*([a-z]{3,9})[\s,-]*(\d{2,4})/);
  const word1 = m ? monthOf(m[2]) : undefined;
  if (m && word1) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = Number(m[1]);
    return valid(y, word1, d) ? `${y}-${pad(word1)}-${pad(d)}` : null;
  }
  m = s.match(/([a-z]{3,9})[\s.-]*(\d{1,2})(?:st|nd|rd|th)?[\s,-]*(\d{2,4})/);
  const word2 = m ? monthOf(m[1]) : undefined;
  if (m && word2) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = Number(m[2]);
    return valid(y, word2, d) ? `${y}-${pad(word2)}-${pad(d)}` : null;
  }
  return null;
}
