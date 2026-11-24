import type { Appearance, FestivalKey, MilestoneKey, PlanExperience, Sentence, ThemeKey } from '@orbit/shared';
import type { CrewMember, TickerItem } from '@/components/bridge/Hero';
import type { Decision } from '@/components/bridge/NeedsYou';
import type { FeedGroup } from '@/components/bridge/Feed';
import type { HeldAction } from '@/components/trust/UndoBar';

export interface ExperiencePlanChange {
  id: string;
  fromPlan: string | null;
  toPlan: string;
  toPlanName: string;
  direction: 'up' | 'down' | 'same';
  seenAt: string | null;
  createdAt: string;
  newAgents: string[];
  pausedAgents: string[];
  themeReset: boolean;
  highlights: Sentence[];
  checklist: { key: string; label: Sentence; done: boolean; action: 'details' | 'crew' | 'story' | 'report' | 'wins' }[];
}

export interface ExperienceMilestone {
  id: string;
  key: MilestoneKey;
  value: number | null;
  reachedAt: string;
  seenAt: string | null;
  currency: string;
}

export interface ExperienceData {
  plan: { code: string; name: string; experience: PlanExperience; whiteLabel: boolean };
  allPlans: { code: string; name: string; sortOrder: number; experience: PlanExperience }[];
  appearance: Appearance & {
    effectiveTheme: ThemeKey;
    effectiveAvatar: 'initials' | 'characters' | 'photos';
    effectiveBrandColor: string | null;
    themeReset: boolean;
    activeFestival: FestivalKey | null;
  };
  locations: { id: string; name: string }[];
  successManager: { name: string; role?: string; phone?: string; whatsapp?: string; email?: string } | null;
  planChange: ExperiencePlanChange | null;
  wins: { titleKey: string; kind: 'money' | 'bookings' | 'hours' | 'messages' | 'empty'; value: number; currency: string; sentence: Sentence } | null;
  morningStory: {
    currency: string;
    yesterdayMoney: number;
    yesterdaySpent: number;
    yesterdayNet: number;
    bookingsToday: number;
    nextBookingAt: string | null;
    bestMoment: { agent: string; sentence: Sentence } | null;
    suggestion: Sentence;
  } | null;
  milestones: { unseen: ExperienceMilestone | null; reached: ExperienceMilestone[] };
}

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
  /** The Undo window: actions about to go out, and ones that just finished. */
  held: HeldAction[];
  experience?: ExperienceData;
}

export const VIEWS = ['today', 'crew', 'people', 'money', 'rewind', 'tomorrow', 'powers', 'details', 'plan'] as const;
export type View = (typeof VIEWS)[number];
