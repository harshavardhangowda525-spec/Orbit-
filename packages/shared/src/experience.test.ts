import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXPERIENCE, experienceOf, festivalOn, inkOn, planFor } from './experience';
import { DEFAULT_PLANS } from './plans';

test('experienceOf merges admin overrides with plan defaults', () => {
  const pro = experienceOf('pro');
  assert.equal(pro.badge, 'shine');
  assert.ok(pro.perks.includes('heroTrails'));
  assert.ok(pro.perks.includes('morningStory'));
  assert.ok(pro.themes.includes('festive'));

  const custom = experienceOf('plus', { badge: 'shine', perks: ['winsCard', 'heroTrails'] });
  assert.equal(custom.label, 'Orbit Plus');
  assert.equal(custom.badge, 'shine');
  assert.deepEqual(custom.perks, ['winsCard', 'heroTrails']);
  assert.deepEqual(custom.themes, DEFAULT_EXPERIENCE.plus.themes);
});

test('planFor finds the cheapest non-enterprise plan unlocking a theme or perk', () => {
  const plans = DEFAULT_PLANS.map((p) => ({ code: p.code, name: p.name, sortOrder: p.sortOrder, experience: experienceOf(p.code, p.features.experience) }));
  assert.deepEqual(planFor(plans, 'midnight'), { code: 'plus', name: 'Plus' });
  assert.deepEqual(planFor(plans, 'sunrise'), { code: 'pro', name: 'Pro' });
  assert.deepEqual(planFor(plans, 'brand'), { code: 'business', name: 'Business' });
  assert.deepEqual(planFor(plans, 'morningStory'), { code: 'pro', name: 'Pro' });
  assert.deepEqual(planFor(plans, 'constellation'), { code: 'business', name: 'Business' });
});

test('festivalOn activates 3 days before through 2 days after each chosen festival', () => {
  assert.equal(festivalOn('2026-11-05', ['diwali']), 'diwali');
  assert.equal(festivalOn('2026-11-08', ['diwali']), 'diwali');
  assert.equal(festivalOn('2026-11-10', ['diwali']), 'diwali');
  assert.equal(festivalOn('2026-11-11', ['diwali']), null);
  assert.equal(festivalOn('2026-11-08', ['christmas']), null);
  assert.equal(festivalOn('2026-12-25', ['diwali', 'christmas']), 'christmas');
});

test('inkOn picks readable contrast for light and dark brand colours', () => {
  assert.equal(inkOn('#FFC857'), '#14122e');
  assert.equal(inkOn('#5B4CE0'), '#ffffff');
  assert.equal(inkOn('invalid'), '#ffffff');
});
