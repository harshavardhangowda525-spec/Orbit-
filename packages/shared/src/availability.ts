import { WEEKDAYS, type WeeklyHours, type Weekday } from './types';
import { localParts } from './time';

/**
 * Availability engine. Pure and timezone-aware: works in the business's local
 * time for opening hours and converts to UTC instants for everything else.
 */

/** Offset (ms) of `timeZone` from UTC at instant `at`. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant for a local wall-clock time ("2026-11-10", "16:30") in `timeZone`. Handles DST. */
export function zonedTimeToUtc(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass corrects for an offset change between guess and result (DST edges).
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Add whole days to a "YYYY-MM-DD" date string. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const idx = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(idx + 6) % 7];
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface StaffAvailability {
  id: string | null; // null = the business itself (no staff set up)
  name?: string;
  /** null = follows business hours. */
  hours: WeeklyHours | null;
  /** Leave as local date ranges, inclusive: [{from:"2026-11-12", to:"2026-11-13"}]. */
  leave?: { from: string; to: string }[];
  /** Existing bookings and external calendar busy times, already including buffers. */
  busy: Interval[];
}

export interface SlotQuery {
  timeZone: string;
  businessHours: WeeklyHours;
  holidays?: string[]; // local dates when the business is closed
  staff: StaffAvailability[];
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  /** First local date to search and how many days. */
  fromDate: string;
  days: number;
  now: Date;
  /** Earliest bookable time from now. */
  minLeadMin?: number;
  /** Slot start granularity. */
  stepMin?: number;
  /** Stop after this many slots. */
  limit?: number;
}

export interface Slot {
  start: Date;
  end: Date;
  staffId: string | null;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

function openRanges(hours: WeeklyHours, date: string, timeZone: string): Interval[] {
  const day = hours[weekdayOf(date)];
  if (!day?.open) return [];
  return day.ranges.map((r) => ({ start: zonedTimeToUtc(date, r.from, timeZone), end: zonedTimeToUtc(date, r.to, timeZone) }));
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const start = x.start > y.start ? x.start : y.start;
    const end = x.end < y.end ? x.end : y.end;
    if (start < end) out.push({ start, end });
  }
  return out;
}

/**
 * Free slots, earliest first. A slot fits when the service (plus its buffers)
 * lies inside opening hours for that staff member and overlaps none of their
 * busy times. When several staff are free at the same start, the first listed wins
 * (callers order staff by preference or load).
 */
export function findSlots(q: SlotQuery): Slot[] {
  const step = q.stepMin ?? 15;
  const lead = q.minLeadMin ?? 30;
  const before = q.bufferBeforeMin ?? 0;
  const after = q.bufferAfterMin ?? 0;
  const limit = q.limit ?? 200;
  const earliest = new Date(q.now.getTime() + lead * 60_000);
  const holidays = new Set(q.holidays ?? []);
  const out: Slot[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < q.days && out.length < limit; i++) {
    const date = addDays(q.fromDate, i);
    if (holidays.has(date)) continue;
    const business = openRanges(q.businessHours, date, q.timeZone);
    const candidates: Slot[] = [];
    for (const s of q.staff) {
      if (s.leave?.some((l) => l.from <= date && date <= l.to)) continue;
      const windows = s.hours ? intersect(business, openRanges(s.hours, date, q.timeZone)) : business;
      for (const w of windows) {
        // Align slot starts to the step, measured from the window start.
        for (let t = w.start.getTime(); t + q.durationMin * 60_000 <= w.end.getTime(); t += step * 60_000) {
          const start = new Date(t);
          if (start < earliest) continue;
          const end = new Date(t + q.durationMin * 60_000);
          const blocked: Interval = { start: new Date(t - before * 60_000), end: new Date(end.getTime() + after * 60_000) };
          if (s.busy.some((b) => overlaps(b, blocked))) continue;
          candidates.push({ start, end, staffId: s.id });
        }
      }
    }
    candidates.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const c of candidates) {
      if (seen.has(c.start.getTime())) continue; // one slot per start time ("any staff")
      seen.add(c.start.getTime());
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Pick `n` slots spread out (nearest first, then at least `gapMin` apart) — what Aria offers. */
export function spreadSlots(slots: Slot[], n = 3, gapMin = 60): Slot[] {
  const picked: Slot[] = [];
  for (const s of slots) {
    if (picked.every((p) => Math.abs(p.start.getTime() - s.start.getTime()) >= gapMin * 60_000)) picked.push(s);
    if (picked.length === n) break;
  }
  return picked;
}

/** Is `at` inside quiet hours (e.g. {from:"21:00", to:"09:00"}) in the business's local time? */
export function inQuietHours(at: Date, quiet: { from: string; to: string }, timeZone: string): boolean {
  const { hhmm } = localParts(at, timeZone);
  return quiet.from > quiet.to ? hhmm >= quiet.from || hhmm < quiet.to : hhmm >= quiet.from && hhmm < quiet.to;
}

/**
 * Move a send time out of quiet hours. Prefers the next allowed time; if that
 * would be after `latest` (e.g. the appointment itself), uses the last allowed
 * minute before quiet hours started instead. Returns null when neither works.
 */
export function respectQuietHours(at: Date, quiet: { from: string; to: string }, timeZone: string, latest?: Date): Date | null {
  if (!inQuietHours(at, quiet, timeZone)) return at;
  const { date, hhmm } = localParts(at, timeZone);
  const overnight = quiet.from > quiet.to;
  // Next allowed: the quiet window's end, today or tomorrow.
  const endDate = overnight && hhmm >= quiet.from ? addDays(date, 1) : date;
  const next = zonedTimeToUtc(endDate, quiet.to, timeZone);
  if (!latest || next < latest) return next;
  // Previous allowed: one minute before the quiet window started.
  const startDate = overnight && hhmm < quiet.to ? addDays(date, -1) : date;
  const prev = new Date(zonedTimeToUtc(startDate, quiet.from, timeZone).getTime() - 60_000);
  return prev < at ? prev : null;
}
