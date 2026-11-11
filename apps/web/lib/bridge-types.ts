import type { Sentence } from '@orbit/shared';
import type { CrewMember, TickerItem } from '@/components/bridge/Hero';
import type { Decision } from '@/components/bridge/NeedsYou';
import type { FeedGroup } from '@/components/bridge/Feed';

export interface BridgeData {
  business: { id: string; name: string; slug: string; timezone: string; currency: string; status: string };
  owner: { firstName: string | null };
  now: string;
  dayPart: 'morning' | 'afternoon' | 'evening';
  mode: 'morning' | 'evening';
  isNew: boolean;
  pulse: { score: number; mood: string; sentence: Sentence; numbers: { moneyToday: number; bookingsToday: number; needYou: number; peopleWaiting: number } };
  briefing: Sentence[];
  needsYou: Decision[];
  feed: FeedGroup[];
  ticker: TickerItem[];
  earnings: { total: number; minutesSaved: number; byAgent: { agent: string; name: string; value: number; minutes: number }[] };
  crew: CrewMember[];
  suggestions: string[];
}

export const VIEWS = ['today', 'crew', 'people', 'money', 'rewind', 'tomorrow', 'powers', 'details', 'plan'] as const;
export type View = (typeof VIEWS)[number];

