import type { AgentKey } from './types';

/**
 * Default plan configuration. These values are only used to SEED the `plans`
 * table — at runtime every limit and price is read from the database and is
 * editable from the admin panel without code changes.
 */
export interface PlanLimits {
  aiConversationsPerMonth: number | null; // null = no monthly allowance (Free uses a daily one)
  /** Daily allowance. Free sets it; paid plans leave it null and get dailyCapMultiplier × their daily share. */
  aiConversationsPerDay: number | null;
  /** Paid plans: daily cap = ceil(monthly / 30 × this), so one busy day never uses up the month. */
  dailyCapMultiplier: number;
  /** AI replies a conversation already under way may still get after a limit is reached. */
  graceMessages: number;
  /** Owner questions and commands to Orbit per day (Command Orbit). */
  assistantPerDay: number | null;
  staffCalendars: number | null;
  locations: number | null;
  callMinutesPerMonth: number;
  tasksPerMonth: number | null;
  campaignsPerMonth: number | null;
  storageMb: number;
  /** Past a limit: block (pause with an upgrade prompt), or use the Pay As You Go wallet when it has credit. */
  overage: 'block' | 'wallet' | 'charge';
  overagePrices?: Record<string, { INR: number; USD: number }>;
}

/** Which AI quality a plan gets; the providers and models behind each tier are set in admin. */
export type AiTier = 'free' | 'standard' | 'premium';

export interface PlanFeatures {
  agents: AgentKey[];
  /** Power types allowed on this plan; ['*'] = all. */
  powers: string[];
  aiTier: AiTier;
  /** Not bought online: priced per deal (Enterprise). */
  customPricing?: boolean;
  customDomain: boolean;
  orbitBranding: boolean;
  whiteLabel?: boolean;
  dailyBriefing: boolean;
  voiceCommands: boolean;
  rewind: boolean;
  tomorrow: boolean;
  advancedReports: boolean;
  multiBranch: boolean;
  googleBusinessProfile: boolean;
  prioritySupport: boolean;
}

export type PlanCode = 'free' | 'plus' | 'pro' | 'business' | 'enterprise';

export interface PlanConfig {
  code: PlanCode;
  name: string;
  /** Monthly price in whole currency units. */
  prices: { INR: number; USD: number };
  limits: PlanLimits;
  features: PlanFeatures;
  sortOrder: number;
}

const OVERAGE = { aiConversation: { INR: 2, USD: 0.03 }, callMinute: { INR: 6, USD: 0.08 } };
const BASE_POWERS = ['website_chat', 'chat_link', 'whatsapp', 'instagram', 'messenger', 'gmail', 'outlook', 'sms', 'google_calendar', 'razorpay'];
const ALL_FLAGS_OFF = { customDomain: false, orbitBranding: true, dailyBriefing: false, voiceCommands: false, rewind: false, tomorrow: false, advancedReports: false, multiBranch: false, googleBusinessProfile: false, prioritySupport: false };

export const DEFAULT_PLANS: PlanConfig[] = [
  {
    code: 'free',
    name: 'Free',
    prices: { INR: 0, USD: 0 },
    sortOrder: 1,
    limits: {
      aiConversationsPerMonth: null, aiConversationsPerDay: 20, dailyCapMultiplier: 3, graceMessages: 10, assistantPerDay: 30,
      staffCalendars: 1, locations: 1, callMinutesPerMonth: 0, tasksPerMonth: 100, campaignsPerMonth: 0, storageMb: 100, overage: 'block',
    },
    features: { ...ALL_FLAGS_OFF, agents: ['orbit', 'aria'], powers: ['website_chat', 'chat_link'], aiTier: 'free' },
  },
  {
    code: 'plus',
    name: 'Plus',
    prices: { INR: 999, USD: 15 },
    sortOrder: 2,
    limits: {
      aiConversationsPerMonth: 600, aiConversationsPerDay: null, dailyCapMultiplier: 3, graceMessages: 10, assistantPerDay: 100,
      staffCalendars: 3, locations: 1, callMinutesPerMonth: 0, tasksPerMonth: 3000, campaignsPerMonth: 2, storageMb: 1000, overage: 'wallet', overagePrices: OVERAGE,
    },
    features: { ...ALL_FLAGS_OFF, agents: ['orbit', 'aria', 'nudge', 'ledger'], powers: BASE_POWERS, aiTier: 'standard', customDomain: true, orbitBranding: false, dailyBriefing: true, googleBusinessProfile: true },
  },
  {
    code: 'pro',
    name: 'Pro',
    prices: { INR: 2999, USD: 39 },
    sortOrder: 3,
    limits: {
      aiConversationsPerMonth: 2000, aiConversationsPerDay: null, dailyCapMultiplier: 3, graceMessages: 10, assistantPerDay: 300,
      staffCalendars: 10, locations: 1, callMinutesPerMonth: 100, tasksPerMonth: 10000, campaignsPerMonth: 10, storageMb: 5000, overage: 'wallet', overagePrices: OVERAGE,
    },
    features: {
      ...ALL_FLAGS_OFF, agents: ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'], powers: ['*'], aiTier: 'premium',
      customDomain: true, orbitBranding: false, dailyBriefing: true, voiceCommands: true, rewind: true, tomorrow: true, googleBusinessProfile: true,
    },
  },
  {
    code: 'business',
    name: 'Business',
    prices: { INR: 7999, USD: 99 },
    sortOrder: 4,
    limits: {
      aiConversationsPerMonth: 6000, aiConversationsPerDay: null, dailyCapMultiplier: 3, graceMessages: 10, assistantPerDay: 1000,
      staffCalendars: null, locations: null, callMinutesPerMonth: 300, tasksPerMonth: null, campaignsPerMonth: null, storageMb: 20000, overage: 'wallet', overagePrices: OVERAGE,
    },
    features: {
      agents: ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'], powers: ['*'], aiTier: 'premium',
      customDomain: true, orbitBranding: false, dailyBriefing: true, voiceCommands: true, rewind: true, tomorrow: true, advancedReports: true, multiBranch: true, googleBusinessProfile: true, prioritySupport: true,
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    prices: { INR: 0, USD: 0 },
    sortOrder: 5,
    limits: {
      aiConversationsPerMonth: null, aiConversationsPerDay: null, dailyCapMultiplier: 3, graceMessages: 10, assistantPerDay: null,
      staffCalendars: null, locations: null, callMinutesPerMonth: 1000, tasksPerMonth: null, campaignsPerMonth: null, storageMb: 100000, overage: 'wallet', overagePrices: OVERAGE,
    },
    features: {
      agents: ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'], powers: ['*'], aiTier: 'premium', customPricing: true, whiteLabel: true,
      customDomain: true, orbitBranding: false, dailyBriefing: true, voiceCommands: true, rewind: true, tomorrow: true, advancedReports: true, multiBranch: true, googleBusinessProfile: true, prioritySupport: true,
    },
  },
];

/** A paid plan's daily cap for AI conversations; Free's daily allowance. null = no daily limit. */
export function dailyAiCap(l: Partial<PlanLimits>): number | null {
  if (l.aiConversationsPerDay != null) return l.aiConversationsPerDay;
  if (l.aiConversationsPerMonth == null) return null;
  return Math.max(1, Math.ceil((l.aiConversationsPerMonth / 30) * (l.dailyCapMultiplier ?? 3)));
}

export function planAllowsAgent(features: PlanFeatures, agent: AgentKey): boolean {
  return features.agents.includes(agent);
}

export function planAllowsPower(features: PlanFeatures, power: string): boolean {
  return features.powers.includes('*') || features.powers.includes(power);
}
