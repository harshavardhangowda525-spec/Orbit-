import { WEEKDAYS, type Weekday, type WeeklyHours } from './types';

/** Local date parts for an instant in an IANA timezone. */
export function localParts(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = parts.weekday.toLowerCase().slice(0, 3) as Weekday;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

/** Morning mode (briefing first) until 3 pm local, evening mode (summary first) after. */
export function bridgeMode(at: Date, timeZone: string): 'morning' | 'evening' {
  return localParts(at, timeZone).hour < 15 ? 'morning' : 'evening';
}

export function isOpenAt(hours: WeeklyHours, at: Date, timeZone: string): boolean {
  const { weekday, hhmm } = localParts(at, timeZone);
  const d = hours[weekday];
  if (!d || !d.open) return false;
  return d.ranges.some((r) => r.from <= hhmm && hhmm < r.to);
}

export function isValidWeeklyHours(h: unknown): h is WeeklyHours {
  if (!h || typeof h !== 'object') return false;
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  return WEEKDAYS.every((d) => {
    const v = (h as Record<string, unknown>)[d] as { open?: unknown; ranges?: unknown } | undefined;
    if (!v || typeof v.open !== 'boolean' || !Array.isArray(v.ranges)) return false;
    return (v.ranges as { from: string; to: string }[]).every((r) => re.test(r.from) && re.test(r.to) && r.from < r.to);
  });
}
