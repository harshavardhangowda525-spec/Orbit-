/** Core domain types shared by the API and the web app. */

export const BUSINESS_TYPES = [
  'clinic',
  'dental_clinic',
  'salon',
  'spa',
  'gym',
  'yoga_studio',
  'coaching_centre',
  'tuition',
  'restaurant',
  'retail',
  'repair',
  'real_estate',
  'other',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const AGENT_KEYS = ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const ROLES = ['owner', 'manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_customer',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CARD_STATUSES = ['pending', 'approved', 'rejected', 'edited', 'expired'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** "HH:MM" 24h local time. */
export type TimeOfDay = string;

export interface DayHours {
  open: boolean;
  /** Opening ranges, e.g. [{from:"10:00",to:"13:00"},{from:"14:00",to:"20:00"}] (gap = break). */
  ranges: { from: TimeOfDay; to: TimeOfDay }[];
}
export type WeeklyHours = Record<Weekday, DayHours>;

export interface ServiceDef {
  name: string;
  description?: string;
  durationMin: number;
  /** Price in the smallest sensible unit of the currency: whole rupees for INR. */
  price: number | null;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  category?: string;
  renewalIntervalDays?: number | null;
  depositRequired?: boolean;
}

export interface FaqDef {
  question: string;
  answer: string;
}

export interface SequenceStep {
  channel: 'whatsapp' | 'sms' | 'email' | 'call';
  /** Delay relative to the trigger, in minutes (negative = before, e.g. reminders). */
  delayMin: number;
  template: string;
  condition?: string;
}

export interface SequenceDef {
  name: string;
  trigger:
    | 'lead_created'
    | 'booking_created'
    | 'booking_completed'
    | 'renewal_due'
    | 'inactive_days'
    | 'birthday'
    | 'festival'
    | 'manual';
  ownerAgent: AgentKey;
  steps: SequenceStep[];
}

/** Plain-language sentence stored as a translation key + params, rendered per language. */
export interface Sentence {
  key: string;
  params?: Record<string, string | number>;
}
