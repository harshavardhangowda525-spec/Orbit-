import type { Sentence, Weekday } from './types';

/**
 * Teach Orbit by talking: one instruction from the owner ("closed Tuesdays from
 * next week", "haircut is now 350", "Priya is on leave 12–14 Dec") becomes a list of
 * typed changes. The owner sees each change (before → after, with exact dates)
 * and the bookings it touches before anything is saved.
 */
export type TeachChange =
  | { type: 'update_hours'; days: Weekday[]; ranges: { from: string; to: string }[]; from: string | null }
  | { type: 'add_closure'; from: string; to: string; reason?: string | null }
  | { type: 'update_service'; service: string; serviceId?: string; price?: number | null; durationMin?: number | null; active?: boolean | null }
  | { type: 'add_service'; name: string; price: number | null; durationMin: number }
  | { type: 'remove_service'; service: string; serviceId?: string }
  | { type: 'staff_leave'; staff: string; staffId?: string; from: string; to: string }
  | { type: 'add_faq'; question: string; answer: string }
  | { type: 'update_policy'; title: string; content: string }
  | { type: 'update_profile'; field: TeachProfileField; value: string }
  | { type: 'set_rule'; maxDiscountPct: number };

export const TEACH_PROFILE_FIELDS = ['phone', 'whatsapp', 'website', 'address', 'description', 'instagram', 'facebook'] as const;
export type TeachProfileField = (typeof TEACH_PROFILE_FIELDS)[number];
export const TEACH_CHANGE_TYPES = ['update_hours', 'add_closure', 'update_service', 'add_service', 'remove_service', 'staff_leave', 'add_faq', 'update_policy', 'update_profile', 'set_rule'] as const;

/** Changes that touch prices or rules: when a staff member teaches them, the owner approves. */
export const OWNER_ONLY_TEACH: TeachChange['type'][] = ['update_service', 'add_service', 'remove_service', 'update_policy', 'set_rule'];

/** One line of the preview: what it was, what it becomes, and from when (local dates). */
export interface TeachPreviewLine {
  type: TeachChange['type'];
  before: Sentence | null;
  after: Sentence;
  from: string | null;
  to: string | null;
}

/** A booking the change would affect (e.g. on a day that becomes closed). */
export interface TeachAffected {
  bookingId: string;
  start: string;
  customer: string;
  service: string;
  staff: string | null;
  reason: 'closed' | 'leave' | 'hours' | 'service_removed';
}

export interface TeachPreview {
  id: string;
  status: 'preview' | 'question' | 'needs_owner' | 'applied' | 'cancelled' | 'not_teach';
  question: string | null;
  changes: TeachChange[];
  lines: TeachPreviewLine[];
  affected: TeachAffected[];
  conflicts: Sentence[];
  needsOwner: boolean;
}

/** keep = nothing changes for that booking; message = tell the customer and ask them to pick a new time. */
export type TeachAffectedChoice = 'keep' | 'message';
