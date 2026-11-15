import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePulse, type PulseInputs } from './pulse';
import { toE164 } from './phone';
import { slugify } from './slug';
import { bridgeMode, isOpenAt, isValidWeeklyHours, localParts } from './time';
import { TEMPLATES } from './templates';
import { BUSINESS_TYPES, AGENT_KEYS } from './types';
import { DEFAULT_PLANS, dailyAiCap, planAllowsPower } from './plans';
import { DEFAULT_AI_ROUTING, resolveRouting } from './ai-tiers';
import { AGENTS, agentMayUseTool } from './agents';
import { LANGUAGES, translate, pickLanguage } from './i18n';
import en from './locales/en.json';

const base: PulseInputs = {
  weekday: 'tue',
  bookingsToday: 8,
  usualBookings: 8,
  moneyToday: 5000,
  usualMoney: 5000,
  peopleWaiting: 0,
  pendingCards: 0,
  badReviewsOpen: 0,
  failedTasks: 0,
};

test('pulse: steady day stays around 70 with a steady sentence', () => {
  const r = computePulse(base);
  assert.equal(r.score, 70);
  assert.equal(r.mood, 'good');
  assert.equal(r.sentence.key, 'pulse.steady');
});

test('pulse: more bookings than usual is a strong day', () => {
  const r = computePulse({ ...base, bookingsToday: 11 });
  assert.ok(r.score > 70);
  assert.deepEqual(r.sentence, { key: 'pulse.strong_more', params: { diff: 3, weekday: '@weekday.tue' } });
});

test('pulse: bad reviews and waiting people lower the score and lead the sentence', () => {
  const r = computePulse({ ...base, badReviewsOpen: 1, peopleWaiting: 4 });
  assert.ok(r.score < 60);
  assert.equal(r.sentence.key, 'pulse.bad_review');
});

test('pulse: score is clamped to 0..100', () => {
  const low = computePulse({ ...base, bookingsToday: 0, moneyToday: 0, peopleWaiting: 50, badReviewsOpen: 9, pendingCards: 50, failedTasks: 9 });
  const high = computePulse({ ...base, bookingsToday: 100, moneyToday: 999999 });
  assert.equal(low.score, 0);
  assert.equal(low.mood, 'low');
  assert.ok(high.score <= 100);
});

test('pulse: no history gives a friendly first-days sentence', () => {
  assert.equal(computePulse({ ...base, usualBookings: null, usualMoney: null }).sentence.key, 'pulse.no_history');
});

test('phone: Indian numbers normalise to E.164', () => {
  assert.equal(toE164('98450 12345'), '+919845012345');
  assert.equal(toE164('+91 98450-12345'), '+919845012345');
  assert.equal(toE164('12345'), null);
  assert.equal(toE164('+1 415 555 2671', 'US'), '+14155552671');
});

test('slug: produces url-safe slugs', () => {
  assert.equal(slugify('Glow Salon & Spa'), 'glow-salon-and-spa');
  assert.equal(slugify('  Café  Délice!! '), 'cafe-delice');
  assert.equal(slugify('ಕನ್ನಡ'), 'business');
});

test('time: local parts, open hours and bridge mode respect the business timezone', () => {
  const at = new Date('2026-11-10T04:30:00Z'); // 10:00 IST, Tuesday
  assert.deepEqual(
    { ...localParts(at, 'Asia/Kolkata') },
    { date: '2026-11-10', hour: 10, minute: 0, weekday: 'tue', hhmm: '10:00' },
  );
  assert.equal(bridgeMode(at, 'Asia/Kolkata'), 'morning');
  assert.equal(bridgeMode(new Date('2026-11-10T13:30:00Z'), 'Asia/Kolkata'), 'evening');
  const hours = TEMPLATES.clinic.hours;
  assert.equal(isOpenAt(hours, at, 'Asia/Kolkata'), true);
  assert.equal(isOpenAt(hours, new Date('2026-11-10T09:00:00Z'), 'Asia/Kolkata'), false); // 14:30 lunch break
});

test('templates: every business type has a valid template', () => {
  for (const type of BUSINESS_TYPES) {
    const t = TEMPLATES[type];
    assert.ok(t, `missing template for ${type}`);
    assert.equal(t.type, type);
    assert.ok(t.services.length > 0, `${type} has services`);
    assert.ok(isValidWeeklyHours(t.hours), `${type} hours valid`);
    assert.ok(t.faqs.length > 0, `${type} has FAQs`);
    assert.ok(t.qualifyingQuestions.length > 0 && t.qualifyingQuestions.length <= 3, `${type} qualifying questions`);
    for (const s of t.sequences) assert.ok(AGENT_KEYS.includes(s.ownerAgent));
  }
});

test('plans: five plans, Pro and up allow every Power; daily caps', () => {
  assert.deepEqual(DEFAULT_PLANS.map((p) => p.code), ['free', 'plus', 'pro', 'business', 'enterprise']);
  const business = DEFAULT_PLANS[2];
  assert.ok(planAllowsPower(business.features, 'shopify'));
  assert.ok(!planAllowsPower(DEFAULT_PLANS[0].features, 'whatsapp'));
  // Free: a fixed daily allowance. Paid: 3x the daily share of the month.
  assert.equal(dailyAiCap(DEFAULT_PLANS[0].limits), 20);
  assert.equal(dailyAiCap(DEFAULT_PLANS[1].limits), 60);
  assert.equal(dailyAiCap(DEFAULT_PLANS[4].limits), null);
  assert.deepEqual(DEFAULT_PLANS.map((p) => p.features.aiTier), ['free', 'standard', 'premium', 'premium', 'premium']);
  // Stored routing with gaps is filled from the defaults.
  const r = resolveRouting({ premium: { routes: { command: { provider: 'claude', model: 'claude-opus-5-5' } } } });
  assert.equal(r.premium.routes.command.provider, 'claude');
  assert.equal(r.premium.routes.conversation.model, DEFAULT_AI_ROUTING.premium.routes.conversation.model);
});

test('agents: least privilege tool lists', () => {
  assert.ok(agentMayUseTool('aria', 'create_booking'));
  assert.ok(!agentMayUseTool('aria', 'place_call'));
  assert.ok(!agentMayUseTool('spark', 'send_payment_link'));
  assert.deepEqual(Object.keys(AGENTS).sort(), [...AGENT_KEYS].sort());
});

test('i18n: every language has every English key', () => {
  const keys = Object.keys(en);
  assert.ok(keys.length > 50);
  for (const l of LANGUAGES) {
    const missing = keys.filter((k) => !(k in l.dict));
    assert.deepEqual(missing, [], `${l.code} is missing keys`);
  }
});

test('i18n: interpolation, nested keys and fallback', () => {
  assert.equal(translate('en', 'pulse.strong_more', { diff: 3, weekday: '@weekday.tue' }), 'Strong day. 3 more bookings than a usual Tuesday.');
  assert.equal(translate('xx', 'weekday.mon'), 'Monday');
  assert.equal(pickLanguage(['kn-IN', 'en']), 'kn');
  assert.equal(pickLanguage(['fr-FR']), 'en');
});

test('i18n: formats times and money in the viewer language', () => {
  assert.equal(translate('en', 'feed.ledger.collected', { agent: 'Ledger', amount: '~m:INR:2400', count: 3 }), 'Ledger collected ₹2,400 from 3 pending invoices.');
  const t = translate('en', 'brief.next_booking', { time: '~t:2026-11-10T10:30:00Z' }, { timeZone: 'Asia/Kolkata' });
  assert.match(t, /4:00\s?pm/i);
});

// ---- "Why?" explanations (trust.ts) ----
import { explainTrace, ungroundedWords, type DecisionTrace } from './trust';

const reminder: DecisionTrace = {
  agent: 'nudge',
  action: { key: 'why.action.nudge.reminder', params: { agent: 'Nudge', customer: 'Rohan' } },
  trigger: { kind: 'sequence_rule' },
  rule: { code: 'nudge.reminder', label: { key: 'why.rule.nudge.reminder' } },
  facts: [{ code: 'booking_at', text: { key: 'why.fact.booking_at', params: { customer: 'Rohan', service: 'Haircut', date: '~d:2026-11-15T05:30:00Z', time: '~t:2026-11-15T05:30:00Z' } } }],
  approver: { kind: 'auto_rule' },
};

test('Why? is one sentence built only from the trace, in every language', () => {
  for (const l of LANGUAGES) {
    const text = explainTrace(l.code, reminder, { timeZone: 'Asia/Kolkata' });
    assert.ok(text.includes('Rohan'), text);
    assert.ok(!text.includes('{{'), text);
    assert.deepEqual(ungroundedWords(l.code, text, reminder, { timeZone: 'Asia/Kolkata' }), [], `${l.code}: ${text}`);
  }
  assert.equal(explainTrace('en', reminder, { timeZone: 'Asia/Kolkata' }), 'Rohan’s Haircut is on 15 Nov at 11:00 am, so Nudge sent Rohan a reminder (your “Appointment reminders” rule).');
});

test('the fact check catches names, numbers and dates that are not in the trace', () => {
  const bad = 'Rohan has 3 visits, so Nudge sent Priya a reminder on 14 Nov.';
  assert.deepEqual(ungroundedWords('en', bad, reminder, { timeZone: 'Asia/Kolkata' }).sort(), ['14', '3', 'Priya'].sort());
});

test('every Why? template is grounded: no fixed numbers or names outside the trace', () => {
  // Fill each template's params with marker values; the rendered text may only contain those.
  for (const key of Object.keys(en).filter((k) => /^why\.(action|fact|trigger)\./.test(k) && !k.endsWith('.one'))) {
    const params = Object.fromEntries([...(en as Record<string, string>)[key].matchAll(/\{\{(\w+)\}\}/g)].map((m) => [m[1], m[1] === 'count' ? 2 : `Zed${m[1]}`]));
    const tr: DecisionTrace = { agent: 'orbit', action: { key, params }, trigger: { kind: 'schedule' }, facts: [], approver: { kind: 'not_needed' } };
    for (const l of LANGUAGES) {
      const text = explainTrace(l.code, tr);
      assert.deepEqual(ungroundedWords(l.code, text, tr), [], `${l.code} ${key}: ${text}`);
    }
  }
});

test('no trace details: the sheet says so instead of guessing', () => {
  for (const l of LANGUAGES) assert.ok(translate(l.code, 'why.no_details').length > 5);
});

// ---- Indian price formats (Snap and Khata) ----
import { parseIndianPrice } from './price-parse';

test('prices are read the way Indian boards and bills write them', () => {
  const p = (s: string) => parseIndianPrice(s);
  assert.deepEqual(p('₹350'), { price: 350, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('350/-'), { price: 350, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('Rs. 1,200/-'), { price: 1200, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('1,20,000'), { price: 120000, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('₹1.5 lakh'), { price: 150000, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('2L'), { price: 200000, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('350 - 500'), { price: 350, priceMax: 500, type: 'range' });
  assert.deepEqual(p('from ₹500'), { price: 500, priceMax: null, type: 'from' });
  assert.deepEqual(p('500 onwards'), { price: 500, priceMax: null, type: 'from' });
  assert.deepEqual(p('500+'), { price: 500, priceMax: null, type: 'from' });
  assert.deepEqual(p('₹800/hr'), { price: 800, priceMax: null, type: 'per_hour' });
  assert.deepEqual(p('रु. ३५०'), { price: 350, priceMax: null, type: 'fixed' });
  assert.deepEqual(p('ರೂ ೪೫೦'), { price: 450, priceMax: null, type: 'fixed' });
  assert.equal(p('Price on request'), null);
  assert.equal(p(''), null);
});
