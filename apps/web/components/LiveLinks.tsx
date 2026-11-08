'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';

export interface Links {
  publicUrl: string;
  qrSvg: string;
  widgetCode: string;
  testChatUrl: string;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          window.prompt(label, text);
        }
      }}
    >
      {done ? `✓ ${t('common.copied')}` : label}
    </button>
  );
}

/** The "Your Orbit is live" kit: link, QR code, widget code and a test button. */
export function LiveLinks({ links, businessName }: { links: Links; businessName: string }) {
  const { t } = useI18n();
  const share = `https://wa.me/?text=${encodeURIComponent(t('ob.live.share_text', { business: businessName, url: links.publicUrl }))}`;
  return (
    <div className="stack">
      <div className="card stack">
        <b>{t('ob.live.link')}</b>
        <a href={links.publicUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }} data-testid="public-link">{links.publicUrl}</a>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <CopyButton text={links.publicUrl} label={t('common.copy')} />
          <a className="btn small" href={share} target="_blank" rel="noreferrer">{t('ob.live.share_whatsapp')}</a>
        </div>
      </div>
      <a className="btn primary big block" href={links.testChatUrl} target="_blank" rel="noreferrer">💬 {t('ob.live.test')}</a>
      <div className="card stack" style={{ textAlign: 'center' }}>
        <b>{t('ob.live.qr')}</b>
        <div className="qr" dangerouslySetInnerHTML={{ __html: links.qrSvg }} />
        <p className="small muted">{t('ob.live.qr_sub')}</p>
        <button className="btn small" onClick={() => {
          const w = window.open('', '_blank');
          if (!w) return;
          w.document.write(`<title>${businessName}</title><div style="text-align:center;font-family:sans-serif;padding:40px"><h1>${businessName}</h1><div style="width:320px;margin:0 auto">${links.qrSvg}</div><p style="font-size:20px">${t('ob.live.qr_print')}</p></div>`);
          w.document.close();
          w.print();
        }}>{t('ob.live.print')}</button>
      </div>
      <details className="card">
        <summary><b>{t('ob.live.widget')}</b></summary>
        <p className="small muted" style={{ marginTop: 8 }}>{t('ob.live.widget_sub')}</p>
        <div className="code-box">{links.widgetCode}</div>
        <div style={{ marginTop: 8 }}><CopyButton text={links.widgetCode} label={t('common.copy')} /></div>
      </details>
    </div>
  );
}

export function Checklist({ items }: { items: { key: string; done: boolean }[] }) {
  const { t } = useI18n();
  const left = items.filter((i) => !i.done).length;
  return (
    <div className="card">
      <h2>{t('check.title')}</h2>
      <p className="small muted">{t('check.sub', { count: left })}</p>
      {items.map((i) => (
        <div key={i.key} className={`check ${i.done ? 'done' : ''}`}>
          <span className="dot" aria-hidden>{i.done ? '✓' : ''}</span>
          <div className="grow">
            <div>{t(`check.${i.key}`)}</div>
            <div className="small muted">{t(`check.${i.key}.why`)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
