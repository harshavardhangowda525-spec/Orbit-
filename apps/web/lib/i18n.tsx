'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LANGUAGES, pickLanguage, renderSentence, translate, formatMoney, type Sentence, type FormatOptions } from '@orbit/shared';

interface I18n {
  lang: string;
  setLang: (l: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  ts: (s: Sentence) => string;
  money: (amount: number, currency?: string) => string;
  languages: typeof LANGUAGES;
}

const Ctx = createContext<I18n | null>(null);
const KEY = 'orbit.lang';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState('en');
  const [fmt, setFmt] = useState<FormatOptions>({});

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {}
    setLangState(saved ?? pickLanguage(navigator.languages ?? [navigator.language]));
    setFmt({ timeZone: 'Asia/Kolkata' });
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: string) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {}
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => translate(lang, key, params ?? {}, fmt),
      ts: (s) => renderSentence(lang, s, fmt),
      money: (amount, currency = 'INR') => formatMoney(lang, currency, amount),
      languages: LANGUAGES,
    }),
    [lang, setLang, fmt],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
