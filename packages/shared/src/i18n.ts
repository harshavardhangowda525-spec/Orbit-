import type { Sentence } from './types';
import en from './locales/en.json';
import hi from './locales/hi.json';
import kn from './locales/kn.json';

/**
 * Translations live in JSON files (one per language). Adding Tamil, Telugu,
 * Marathi, etc. means adding a JSON file and registering it in LANGUAGES —
 * no other code changes.
 */
export type Dictionary = Record<string, string>;

export const LANGUAGES: { code: string; name: string; nativeName: string; dict: Dictionary }[] = [
  { code: 'en', name: 'English', nativeName: 'English', dict: en },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dict: hi },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', dict: kn },
];

export const SUPPORTED_LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

export function dictionaryFor(lang: string): Dictionary {
  return LANGUAGES.find((l) => l.code === lang)?.dict ?? en;
}

export interface FormatOptions {
  /** Business timezone, used for "~t:" time params. */
  timeZone?: string;
}

const LOCALE: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };
export const localeFor = (lang: string) => LOCALE[lang] ?? `${lang}-IN`;

export function formatMoney(lang: string, currency: string, amount: number): string {
  return new Intl.NumberFormat(localeFor(lang), { style: 'currency', currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
}

export function formatTime(lang: string, iso: string | Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(localeFor(lang), { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(iso));
}

/**
 * Param values with a prefix are formatted for the viewer's language:
 *   "@some.key"         -> translated text
 *   "~t:<ISO time>"     -> local time, e.g. "4:00 pm"
 *   "~m:<CUR>:<amount>" -> money, e.g. "₹2,400"
 */
function formatParam(lang: string, v: string | number, opts: FormatOptions): string {
  if (typeof v !== 'string') return new Intl.NumberFormat(localeFor(lang)).format(v);
  if (v.startsWith('@')) return translate(lang, v.slice(1), {}, opts);
  if (v.startsWith('~t:')) return formatTime(lang, v.slice(3), opts.timeZone);
  if (v.startsWith('~m:')) {
    const [, cur, amt] = v.split(':');
    return formatMoney(lang, cur, Number(amt));
  }
  return v;
}

/** Translate `key` with {{param}} interpolation, falling back to English, then to the key itself. */
export function translate(lang: string, key: string, params: Record<string, string | number> = {}, opts: FormatOptions = {}): string {
  const dict = dictionaryFor(lang);
  // Singular form: "key.one" is used when count is 1, if the language defines it.
  const k = params.count === 1 && (dict[`${key}.one`] ?? (en as Dictionary)[`${key}.one`]) ? `${key}.one` : key;
  const template = dict[k] ?? (en as Dictionary)[k] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) return '';
    return formatParam(lang, v, opts);
  });
}

export function renderSentence(lang: string, s: Sentence, opts: FormatOptions = {}): string {
  return translate(lang, s.key, s.params ?? {}, opts);
}

/** Pick the best supported language from a browser Accept-Language style list. */
export function pickLanguage(preferred: readonly string[], supported: readonly string[] = SUPPORTED_LANGUAGE_CODES): string {
  for (const p of preferred) {
    const base = p.toLowerCase().split('-')[0];
    if (supported.includes(base)) return base;
  }
  return 'en';
}
