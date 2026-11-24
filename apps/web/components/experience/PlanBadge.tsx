'use client';

import type { AvatarStyle, PlanExperience } from '@orbit/shared';
import { AGENT_INITIAL } from '@/components/bridge/Hero';

/** Plan identity badge shown next to the business name (hidden on Free and Enterprise white-label). */
export function PlanBadge({ experience, whiteLabel }: { experience?: PlanExperience; whiteLabel?: boolean }) {
  if (!experience || experience.badge === 'none' || whiteLabel) return null;
  return (
    <span className={`plan-badge ${experience.badge}`} data-testid="plan-badge">
      {experience.label}
    </span>
  );
}

/** Illustrated SVG character faces / emblems for Pro+ Crew avatar styles. */
export function AgentGlyph({ agent, style = 'initials' }: { agent: string; style?: AvatarStyle }) {
  if (style === 'initials') return <>{AGENT_INITIAL[agent] ?? agent[0]?.toUpperCase()}</>;
  if (style === 'photos') {
    // Crisp emblem style
    const icons: Record<string, React.ReactNode> = {
      aria: <path d="M5 12h14M12 5l7 7-7 7" />,
      vox: <><rect x="9" y="4" width="6" height="10" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v3" /></>,
      nudge: <><path d="M6 15v-4a6 6 0 1 1 12 0v4l2 2H4l2-2Z" /><path d="M10 19a2 2 0 0 0 4 0" /></>,
      ledger: <><path d="M6 4h12v16l-3-2-3 2-3-2-3 2V4Z" /><path d="M9 9h6M9 13h4" /></>,
      spark: <path d="M12 3l2.2 6.2L20 12l-5.8 2.2L12 21l-2.2-6.8L4 12l5.8-2.8L12 3Z" />,
      khata: <><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
      orbit: <><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="9" strokeDasharray="3 3" /></>,
    };
    return (
      <svg className="avatar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {icons[agent] ?? <circle cx="12" cy="12" r="6" />}
      </svg>
    );
  }
  // Illustrated friendly character faces per agent
  const faces: Record<string, React.ReactNode> = {
    aria: <><circle cx="9" cy="10" r="1.4" fill="currentColor" /><circle cx="15" cy="10" r="1.4" fill="currentColor" /><path d="M8.5 14.5c1 1.5 6 1.5 7 0" /><path d="M5 9.5a7 7 0 0 1 14 0" /></>,
    vox: <><circle cx="9" cy="10" r="1.4" fill="currentColor" /><circle cx="15" cy="10" r="1.4" fill="currentColor" /><path d="M9 15h6" /><path d="M4 11v2M20 11v2" /></>,
    nudge: <><path d="M8 10.5c.5-1 1.5-1 2 0M14 10.5c.5-1 1.5-1 2 0" /><path d="M8.5 14.5c1.5 1.8 5.5 1.8 7 0" /></>,
    ledger: <><rect x="6.5" y="8.5" width="4.5" height="3.5" rx="1" /><rect x="13" y="8.5" width="4.5" height="3.5" rx="1" /><path d="M11 10h2M9 15.5c1.5 1 4.5 1 6 0" /></>,
    spark: <><path d="M8 9.5l1.5 1.5L11 9.5M13 9.5l1.5 1.5L16 9.5" /><path d="M8.5 14.5c1.5 2 5.5 2 7 0" /></>,
    khata: <><circle cx="9" cy="10" r="1.3" fill="currentColor" /><circle cx="15" cy="10" r="1.3" fill="currentColor" /><path d="M8 15c1.2 1.2 6.8 1.2 8 0M7 6.5h10" /></>,
    orbit: <><circle cx="9" cy="10" r="1.4" fill="currentColor" /><circle cx="15" cy="10" r="1.4" fill="currentColor" /><path d="M9 14.5c1.5 1.3 4.5 1.3 6 0" /></>,
  };
  return (
    <svg className="avatar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {faces[agent] ?? faces.orbit}
    </svg>
  );
}
