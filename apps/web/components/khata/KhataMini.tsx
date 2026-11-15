'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AgentDot } from '@/components/bridge/Hero';
import './khata.css';

/** The Khata card on The Bridge: this month's earned, spent and kept. Hidden for staff (no money permission). */
export function KhataMini({ refresh, onOpen }: { refresh: unknown; onOpen: () => void }) {
  const { t, money } = useI18n();
  const [s, setS] = useState<{ currency: string; revenue: { total: number }; expenses: { total: number }; profit: number } | null>(null);
  useEffect(() => {
    api('/khata/summary').then(setS).catch(() => setS(null));
  }, [refresh]);
  if (!s) return null;
  return (
    <button className="card khata-card rowbtn" onClick={onOpen} data-testid="khata-card" style={{ textAlign: 'left', width: '100%' }}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <AgentDot agent="khata" size="sm" />
        <b>{t('khata.card.title')}</b>
      </div>
      <div className="khata-mini">
        <div><span>{t('khata.revenue')}</span><b>{money(s.revenue.total, s.currency)}</b></div>
        <div><span>{t('khata.expenses')}</span><b>{money(s.expenses.total, s.currency)}</b></div>
        <div><span>{t('khata.profit')}</span><b>{money(s.profit, s.currency)}</b></div>
      </div>
    </button>
  );
}
