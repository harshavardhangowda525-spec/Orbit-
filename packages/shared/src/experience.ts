import type { PlanCode } from './plans';

/**
 * How each plan looks and feels (Phase 6). Stored on the plan (features.experience)
 * so admins can move perks between plans without code changes; these are the defaults.
 */
export const THEMES = ['space', 'light', 'midnight', 'sunrise', 'forest', 'festive', 'brand'] as const;
export type ThemeKey = (typeof THEMES)[number];
export const AVATAR_STYLES = ['initials', 'characters', 'photos'] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

export const PERKS = ['heroTrails', 'constellation', 'winsCard', 'morningStory', 'morningGreeting', 'magazineReport', 'milestones', 'brandColor', 'avatarStyles', 'successManager', 'whiteLabel'] as const;
export type Perk = (typeof PERKS)[number];

export interface PlanExperience {
  /** "Orbit Plus"; Enterprise (white label) shows the business's own name. */
  label: string;
  /** Plan colours: accent and a second stop for gradients. */
  accent: string;
  accent2: string;
  badge: 'none' | 'plain' | 'shine' | 'metal';
  themes: ThemeKey[];
  perks: Perk[];
}

export const DEFAULT_EXPERIENCE: Record<PlanCode, PlanExperience> = {
  free: { label: 'Orbit', accent: '#5B4CE0', accent2: '#7A68FF', badge: 'none', themes: ['space', 'light'], perks: [] },
  plus: { label: 'Orbit Plus', accent: '#5EE0B5', accent2: '#9AF0D2', badge: 'plain', themes: ['space', 'light', 'midnight'], perks: ['winsCard', 'milestones'] },
  pro: {
    label: 'Orbit Pro', accent: '#5B4CE0', accent2: '#A99BFF', badge: 'shine', themes: ['space', 'light', 'midnight', 'sunrise', 'forest', 'festive'],
    perks: ['winsCard', 'milestones', 'heroTrails', 'morningStory', 'avatarStyles'],
  },
  business: {
    label: 'Orbit Business', accent: '#FFC857', accent2: '#5B4CE0', badge: 'metal', themes: ['space', 'light', 'midnight', 'sunrise', 'forest', 'festive', 'brand'],
    perks: ['winsCard', 'milestones', 'heroTrails', 'morningStory', 'avatarStyles', 'constellation', 'morningGreeting', 'magazineReport', 'brandColor', 'successManager'],
  },
  enterprise: {
    label: 'Orbit Enterprise', accent: '#FFC857', accent2: '#5B4CE0', badge: 'metal', themes: ['space', 'light', 'midnight', 'sunrise', 'forest', 'festive', 'brand'],
    perks: ['winsCard', 'milestones', 'heroTrails', 'morningStory', 'avatarStyles', 'constellation', 'morningGreeting', 'magazineReport', 'brandColor', 'successManager', 'whiteLabel'],
  },
};

/** The plan's experience: what the admin set on the plan, filled in from the defaults. */
export function experienceOf(code: string, stored?: Partial<PlanExperience> | null): PlanExperience {
  const base = DEFAULT_EXPERIENCE[(code in DEFAULT_EXPERIENCE ? code : 'free') as PlanCode];
  return { ...base, ...(stored ?? {}), themes: stored?.themes ?? base.themes, perks: stored?.perks ?? base.perks };
}

/** The cheapest plan (by sort order) whose experience has this theme or perk: for "Pro" lock labels. */
export function planFor<T extends ThemeKey | Perk>(plans: { code: string; name: string; sortOrder: number; experience: PlanExperience }[], what: T): { code: string; name: string } | null {
  const p = [...plans].sort((a, b) => a.sortOrder - b.sortOrder).find((x) => x.code !== 'enterprise' && ((x.experience.themes as string[]).includes(what) || (x.experience.perks as string[]).includes(what)));
  return p ? { code: p.code, name: p.name } : null;
}

/** Owner's appearance choices (business_profiles.appearance). */
export interface Appearance {
  theme: ThemeKey;
  brandColor: string | null;
  avatarStyle: AvatarStyle;
  /** Festivals for the Festive theme (it turns on by itself around them). */
  festivals: FestivalKey[];
}
export const DEFAULT_APPEARANCE: Appearance = { theme: 'space', brandColor: null, avatarStyle: 'initials', festivals: ['diwali', 'christmas'] };

export const FESTIVALS = ['diwali', 'eid', 'christmas', 'pongal', 'holi', 'onam', 'ugadi', 'navratri'] as const;
export type FestivalKey = (typeof FESTIVALS)[number];
/**
 * Festival dates (main day, YYYY-MM-DD) for 2026–2028. Festive turns on 3 days before
 * and stays 2 days after. Lunar festivals move every year, so they are listed per year.
 */
export const FESTIVAL_DATES: Record<FestivalKey, string[]> = {
  diwali: ['2026-11-08', '2027-10-29', '2028-10-17'],
  eid: ['2026-03-20', '2026-05-27', '2027-03-10', '2027-05-17', '2028-02-27', '2028-05-05'],
  christmas: ['2026-12-25', '2027-12-25', '2028-12-25'],
  pongal: ['2026-01-14', '2027-01-15', '2028-01-15'],
  holi: ['2026-03-04', '2027-03-22', '2028-03-11'],
  onam: ['2026-08-26', '2027-09-12', '2028-09-01'],
  ugadi: ['2026-03-19', '2027-04-07', '2028-03-27'],
  navratri: ['2026-10-11', '2027-09-30', '2028-09-19'],
};

/** The festival happening around this local date (or null). */
export function festivalOn(date: string, chosen: FestivalKey[]): FestivalKey | null {
  const t = Date.parse(`${date}T12:00:00Z`);
  for (const f of chosen) {
    for (const d of FESTIVAL_DATES[f] ?? []) {
      const diff = (t - Date.parse(`${d}T12:00:00Z`)) / 86_400_000;
      if (diff >= -3 && diff <= 2) return f;
    }
  }
  return null;
}

/** Milestones worth celebrating (paid plans). */
export const MILESTONES = ['bookings_100', 'bookings_1000', 'earned_1lakh', 'earned_10lakh', 'year_1'] as const;
export type MilestoneKey = (typeof MILESTONES)[number];

/** Readable text on a brand colour (#rrggbb): dark ink on light colours, white on dark. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#14122e' : '#ffffff';
}
