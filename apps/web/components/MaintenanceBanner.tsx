'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** The Orbit team's maintenance message (Admin → Settings), shown to owners while it is on. */
export function MaintenanceBanner() {
  const [m, setM] = useState<{ message: string; blockWrites: boolean } | null>(null);
  useEffect(() => {
    const load = () => api<{ maintenance: { message: string; blockWrites: boolean } | null }>('/status', { business: false }).then((r) => setM(r.maintenance)).catch(() => undefined);
    load();
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, []);
  if (!m) return null;
  return (
    <p className="note small" role="status" data-testid="maintenance-banner">
      🛠 {m.message || 'Orbit is being updated.'}{m.blockWrites ? ' Changes are paused for a few minutes; everything you see is safe.' : ''}
    </p>
  );
}
