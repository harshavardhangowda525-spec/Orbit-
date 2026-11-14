import type { Sentence } from './types';
import { dictionaryFor, formatParam, translate, type FormatOptions } from './i18n';
import en from './locales/en.json';

/**
 * "Why did you do that?" — every agent action stores a decision trace when it
 * happens: what started it, the rule applied, the facts used and who approved.
 * The explanation is phrased from the trace only, so it can never invent a reason.
 */
export type TriggerKind = 'owner_command' | 'sequence_rule' | 'inbound_message' | 'inbound_call' | 'schedule' | 'agent_request' | 'owner_decision' | 'external_event';
export type TraceRefType = 'customer' | 'conversation' | 'booking' | 'invoice' | 'lead';

export interface TraceFact {
  code: string;
  text: Sentence;
  ref?: { type: TraceRefType; id: string };
}

export interface DecisionTrace {
  id?: string;
  agent: string;
  action: Sentence;
  trigger: { kind: TriggerKind; text?: string; agent?: string; ref?: { type: TraceRefType; id: string } };
  rule?: { code: string; label: Sentence; setting?: string } | null;
  facts: TraceFact[];
  alternatives?: { option: Sentence; whyNot: Sentence }[];
  approver: { kind: 'owner' | 'auto_rule' | 'not_needed'; name?: string };
  customer?: { id: string; name: string } | null;
  createdAt?: string;
}

/** Rule codes the owner can switch off for one customer ("Don't do this again for Rohan"). */
export const EXCEPTABLE_RULES = ['nudge.reminder', 'nudge.follow_up', 'nudge.renewal', 'nudge.review_request', 'nudge.win_back', 'ledger.invoice_reminder'] as const;

function triggerSentence(t: DecisionTrace['trigger']): Sentence | null {
  switch (t.kind) {
    case 'owner_command':
      return t.text ? { key: 'why.trigger.owner_command', params: { text: t.text.length > 90 ? `${t.text.slice(0, 87)}…` : t.text } } : { key: 'why.trigger.owner_command_short' };
    case 'owner_decision':
      return { key: 'why.trigger.owner_decision' };
    case 'inbound_message':
      return { key: 'why.trigger.inbound' };
    case 'inbound_call':
      return { key: 'why.trigger.inbound_call' };
    case 'agent_request':
      return { key: 'why.trigger.agent_request', params: { agent: t.agent ?? '' } };
    default:
      return null;
  }
}

/** The sentences a trace is made of (what the explanation may use). */
export function traceSentences(trace: DecisionTrace): Sentence[] {
  const t = triggerSentence(trace.trigger);
  return [trace.action, ...(t ? [t] : []), ...(trace.rule ? [trace.rule.label] : []), ...trace.facts.map((f) => f.text)];
}

/** One plain sentence in the owner's language, built only from the stored trace. */
export function explainTrace(lang: string, trace: DecisionTrace, opts: FormatOptions = {}): string {
  const r = (s: Sentence) => translate(lang, s.key, s.params ?? {}, opts);
  const t = triggerSentence(trace.trigger);
  const reasons = [...(t ? [r(t)] : []), ...trace.facts.slice(0, 4).map((f) => r(f.text))].filter(Boolean);
  const action = r(trace.action);
  const rule = trace.rule ? r(trace.rule.label) : '';
  let text: string;
  if (!reasons.length) text = translate(lang, rule ? 'why.sentence.rule_only' : 'why.sentence.action_only', { action, rule });
  else {
    const and = translate(lang, 'why.and');
    const joined = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(', ')}${and}${reasons[reasons.length - 1]}`;
    text = translate(lang, rule ? 'why.sentence.rule' : 'why.sentence', { reasons: joined, action, rule });
  }
  // Capitalise the first letter (Latin scripts) after joining lower-case fragments.
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const STRIP = /\{\{\w+\}\}/g;
const NUMBER = /\d+(?:[.,:]\d+)*/g;
const NAME = /\p{Lu}[\p{Ll}\p{M}]+/gu;
const tokens = (s: string) => [...(s.match(NUMBER) ?? []), ...(s.match(/[\p{L}\p{M}]+/gu) ?? [])].map((w) => w.toLowerCase());

/**
 * Automated check: every number, date and name in an explanation must come from
 * the trace. Returns the words that do not (empty = grounded). Words from the
 * fixed sentence templates themselves are not facts and are allowed.
 */
export function ungroundedWords(lang: string, text: string, trace: DecisionTrace, opts: FormatOptions = {}): string[] {
  const dict = dictionaryFor(lang);
  const tmpl = (k: string) => dict[k] ?? (en as Record<string, string>)[k] ?? '';
  // Only the sentence frames and the templates this trace actually uses.
  const statics: string[] = ['why.and', 'why.sentence', 'why.sentence.rule', 'why.sentence.rule_only', 'why.sentence.action_only'].map((k) => tmpl(k).replace(STRIP, ' '));
  const values: string[] = [];
  const visit = (s: Sentence) => {
    statics.push(tmpl(s.key).replace(STRIP, ' '), tmpl(`${s.key}.one`).replace(STRIP, ' '));
    for (const v of Object.values(s.params ?? {})) {
      if (typeof v === 'string' && v.startsWith('@')) visit({ key: v.slice(1) });
      else values.push(formatParam(lang, v, opts));
    }
  };
  for (const s of traceSentences(trace)) visit(s);
  const allowed = new Set(tokens(`${values.join(' ')} ${statics.join(' ')}`));
  const words = [...(text.match(NUMBER) ?? []), ...(text.match(NAME) ?? [])];
  return [...new Set(words)].filter((w) => !allowed.has(w.toLowerCase()));
}
