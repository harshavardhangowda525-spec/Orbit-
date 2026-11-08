import type { Sentence, Weekday } from './types';

export interface PulseInputs {
  weekday: Weekday;
  bookingsToday: number;
  /** Average bookings on the same weekday over recent weeks; null when there is no history yet. */
  usualBookings: number | null;
  moneyToday: number;
  usualMoney: number | null;
  peopleWaiting: number;
  pendingCards: number;
  badReviewsOpen: number;
  failedTasks: number;
}

export type PulseMood = 'great' | 'good' | 'watch' | 'low';

export interface PulseResult {
  score: number;
  mood: PulseMood;
  sentence: Sentence;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Business Pulse: a 0–100 score with one plain sentence explaining it.
 * Pure and deterministic so it can be unit-tested and snapshotted.
 */
export function computePulse(i: PulseInputs): PulseResult {
  let score = 70;

  if (i.usualBookings !== null && i.usualBookings > 0) {
    const ratio = i.bookingsToday / i.usualBookings;
    score += clamp((ratio - 1) * 25, -25, 20);
  } else if (i.usualBookings === 0 && i.bookingsToday > 0) {
    score += 10;
  }
  if (i.usualMoney !== null && i.usualMoney > 0) {
    const ratio = i.moneyToday / i.usualMoney;
    score += clamp((ratio - 1) * 10, -10, 10);
  }
  score -= clamp(i.peopleWaiting * 3, 0, 15);
  score -= clamp(i.badReviewsOpen * 8, 0, 16);
  score -= clamp(i.pendingCards * 2, 0, 10);
  score -= clamp(i.failedTasks * 5, 0, 10);
  score = Math.round(clamp(score, 0, 100));

  const mood: PulseMood = score >= 80 ? 'great' : score >= 60 ? 'good' : score >= 40 ? 'watch' : 'low';
  const weekday = `@weekday.${i.weekday}`;

  let sentence: Sentence;
  if (i.badReviewsOpen > 0) {
    sentence = { key: 'pulse.bad_review', params: { count: i.badReviewsOpen } };
  } else if (i.peopleWaiting >= 3) {
    sentence = { key: 'pulse.people_waiting', params: { count: i.peopleWaiting } };
  } else if (i.usualBookings === null) {
    sentence = { key: 'pulse.no_history', params: { count: i.bookingsToday } };
  } else {
    const usual = Math.round(i.usualBookings);
    const diff = i.bookingsToday - usual;
    if (diff >= 1) sentence = { key: 'pulse.strong_more', params: { diff, weekday } };
    else if (diff <= -1) sentence = { key: 'pulse.quiet_fewer', params: { diff: -diff, weekday } };
    else sentence = { key: 'pulse.steady', params: { weekday } };
  }

  return { score, mood, sentence };
}
