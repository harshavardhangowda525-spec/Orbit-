'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { homeFor, useSession } from '@/lib/session';
import { LanguagePicker } from '@/components/LanguagePicker';

export default function Home() {
  const { t } = useI18n();
  const { me, loading } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading && me) router.replace(homeFor(me));
  }, [loading, me, router]);

  return (
    <main className="page">
      <div className="row between">
        <strong>Orbit</strong>
        <LanguagePicker compact />
      </div>
      <div className="center stack">
        <div style={{ fontSize: '3rem' }}>🪐</div>
        <h1>{t('landing.title')}</h1>
        <p className="muted">{t('landing.subtitle')}</p>
        <Link className="btn primary big block" href="/login">
          {t('landing.cta')}
        </Link>
        <p className="small muted">{t('landing.under2')}</p>
      </div>
    </main>
  );
}
