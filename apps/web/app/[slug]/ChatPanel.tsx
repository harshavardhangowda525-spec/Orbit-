'use client';

import { useState } from 'react';
import { translate } from '@orbit/shared';

/**
 * Customer chat entry point. Phase 1 shows Aria's greeting and quick replies;
 * Aria's real answers and bookings arrive in Phase 2.
 */
export function ChatPanel({ businessName, lang, openOnLoad }: { businessName: string; lang: string; openOnLoad: boolean }) {
  const [open, setOpen] = useState(openOnLoad);
  const [picked, setPicked] = useState<string | null>(null);
  const t = (k: string, p: Record<string, string | number> = {}) => translate(lang, k, p);
  if (!open) {
    return (
      <button className="btn primary big grow" onClick={() => setOpen(true)}>
        📅 {t('public.book_chat')}
      </button>
    );
  }
  return (
    <div className="card stack grow" role="dialog" aria-label={t('chat.title', { business: businessName })} style={{ position: 'fixed', inset: 'auto 8px 8px 8px', maxWidth: 520, margin: '0 auto', zIndex: 30 }}>
      <div className="row between">
        <b>{t('chat.title', { business: businessName })}</b>
        <button className="icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="note">{t('chat.greeting', { business: businessName })}</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {['book', 'prices', 'timings', 'human'].map((k) => (
          <button key={k} className="chip" onClick={() => setPicked(k)}>{t(`chat.chip.${k}`)}</button>
        ))}
      </div>
      {picked && <p className="small muted">{t('chat.soon')}</p>}
    </div>
  );
}
