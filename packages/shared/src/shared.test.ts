import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePulse, type PulseInputs } from './pulse';
import { toE164 } from './phone';
import { slugify } from './slug';
import { bridgeMode, isOpenAt, isValidWeeklyHours, localParts } from './time';
import { TEMPLATES } from './templates';
import { BUSINESS_TYPES, AGENT_KEYS } from './types';
import { DEFAULT_PLANS, planAllowsPower } from './plans';
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

test('plans: three plans, business plan allows everything', () => {
  assert.deepEqual(DEFAULT_PLANS.map((p) => p.code), ['free', 'base', 'business']);
  const business = DEFAULT_PLANS[2];
  assert.ok(planAllowsPower(business.features, 'shopify'));
  assert.ok(!planAllowsPower(DEFAULT_PLANS[0].features, 'whatsapp'));
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
