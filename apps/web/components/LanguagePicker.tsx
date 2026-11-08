'use client';

import { useI18n } from '@/lib/i18n';
import { api, session } from '@/lib/api';

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, languages, t } = useI18n();
  return (
    <select
      aria-label={t('common.language')}
      className={compact ? 'chip' : 'input'}
      value={lang}
      onChange={(e) => {
        setLang(e.target.value);
        if (session.token()) api('/auth/me', { method: 'PATCH', body: { language: e.target.value }, business: false }).catch(() => undefined);
      }}
    >
      {languages.map((l) => (
        <option key={l.code} value={l.code}>
          {l.nativeName}
        </option>
      ))}
    </select>
  );
}
