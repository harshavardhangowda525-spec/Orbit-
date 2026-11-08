import type { AgentKey } from './types';

/**
 * Default plan configuration. These values are only used to SEED the `plans`
 * table — at runtime every limit and price is read from the database and is
 * editable from the admin panel without code changes.
 */
export interface PlanLimits {
  aiConversationsPerMonth: number | null; // null = unlimited
  staffCalendars: number | null;
  locations: number | null;
  callMinutesPerMonth: number;
  tasksPerMonth: number | null;
  campaignsPerMonth: number | null;
  storageMb: number;
  /** What happens past a limit: block with an upgrade prompt, or charge per unit. */
  overage: 'block' | 'charge';
  overagePrices?: Record<string, { INR: number; USD: number }>;
}

export interface PlanFeatures {
  agents: AgentKey[];
  /** Power types allowed on this plan; ['*'] = all. */
  powers: string[];
  customDomain: boolean;
  orbitBranding: boolean;
  dailyBriefing: boolean;
  voiceCommands: boolean;
  rewind: boolean;
  tomorrow: boolean;
  advancedReports: boolean;
  multiBranch: boolean;
  googleBusinessProfile: boolean;
  prioritySupport: boolean;
}

export interface PlanConfig {
  code: 'free' | 'base' | 'business';
  name: string;
  /** Monthly price in whole currency units. */
  prices: { INR: number; USD: number };
  limits: PlanLimits;
  features: PlanFeatures;
  sortOrder: number;
}

export const DEFAULT_PLANS: PlanConfig[] = [
  {
    code: 'free',
    name: 'Free',
    prices: { INR: 0, USD: 0 },
    sortOrder: 1,
    limits: {
      aiConversationsPerMonth: 50,
      staffCalendars: 1,
      locations: 1,
      callMinutesPerMonth: 0,
      tasksPerMonth: 100,
      campaignsPerMonth: 0,
      storageMb: 100,
      overage: 'block',
    },
    features: {
      agents: ['orbit', 'aria'],
      powers: ['website_chat', 'chat_link'],
      customDomain: false,
      orbitBranding: true,
      dailyBriefing: false,
      voiceCommands: false,
      rewind: false,
      tomorrow: false,
      advancedReports: false,
      multiBranch: false,
      googleBusinessProfile: false,
      prioritySupport: false,
    },
  },
  {
    code: 'base',
    name: 'Base',
    prices: { INR: 1999, USD: 49 },
    sortOrder: 2,
    limits: {
      aiConversationsPerMonth: 1500,
      staffCalendars: 5,
      locations: 1,
      callMinutesPerMonth: 0,
      tasksPerMonth: 5000,
      campaignsPerMonth: 4,
      storageMb: 2000,
      overage: 'block',
    },
    features: {
      agents: ['orbit', 'aria', 'nudge', 'ledger'],
      powers: ['website_chat', 'chat_link', 'whatsapp', 'instagram', 'gmail', 'google_calendar', 'razorpay'],
      customDomain: true,
      orbitBranding: false,
      dailyBriefing: true,
      voiceCommands: false,
      rewind: false,
      tomorrow: false,
      advancedReports: false,
      multiBranch: false,
      googleBusinessProfile: true,
      prioritySupport: false,
    },
  },
  {
    code: 'business',
    name: 'Business',
    prices: { INR: 24999, USD: 299 },
    sortOrder: 3,
    limits: {
      aiConversationsPerMonth: null,
      staffCalendars: null,
      locations: null,
      callMinutesPerMonth: 1000,
      tasksPerMonth: null,
      campaignsPerMonth: null,
      storageMb: 20000,
      overage: 'charge',
      overagePrices: { callMinute: { INR: 6, USD: 0.08 } },
    },
    features: {
      agents: ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'],
      powers: ['*'],
      customDomain: true,
      orbitBranding: false,
      dailyBriefing: true,
      voiceCommands: true,
      rewind: true,
      tomorrow: true,
      advancedReports: true,
      multiBranch: true,
      googleBusinessProfile: true,
      prioritySupport: true,
    },
  },
];

export function planAllowsAgent(features: PlanFeatures, agent: AgentKey): boolean {
  return features.agents.includes(agent);
}

export function planAllowsPower(features: PlanFeatures, power: string): boolean {
  return features.powers.includes('*') || features.powers.includes(power);
}
