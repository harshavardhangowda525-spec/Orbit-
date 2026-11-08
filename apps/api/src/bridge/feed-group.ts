import type { Sentence } from '@orbit/shared';

export interface FeedItem {
  id: string;
  agent: string;
  type: string;
  sentence: Sentence;
  at: string;
  entityType: string | null;
  entityId: string | null;
  valueAmount: number;
}

export interface FeedGroup {
  id: string;
  agent: string;
  type: string;
  at: string;
  /** Group sentence, e.g. "Aria booked 5 appointments". Single items use their own sentence. */
  sentence: Sentence;
  items: FeedItem[];
}

/** Event types that read better grouped when they happen back to back. */
export const GROUPABLE = new Set(['booking_created', 'question_answered', 'reminder_sent', 'payment_received', 'review_request_sent', 'lead_captured']);

/** Group consecutive similar events (same agent + type) into one expandable line. Input must be newest first. */
export function groupFeed(items: FeedItem[], agentNames: Record<string, string> = {}): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && GROUPABLE.has(item.type) && last.type === item.type && last.agent === item.agent && sameDay(last.items[0].at, item.at)) {
      last.items.push(item);
      continue;
    }
    groups.push({ id: item.id, agent: item.agent, type: item.type, at: item.at, sentence: item.sentence, items: [item] });
  }
  for (const g of groups) {
    if (g.items.length > 1) {
      const total = g.items.reduce((s, i) => s + (i.valueAmount || 0), 0);
      g.sentence = { key: `feed.group.${g.type}`, params: { count: g.items.length, agent: agentNames[g.agent] ?? cap(g.agent), ...(total ? { amount: total } : {}) } };
    }
  }
  return groups;
}

const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
