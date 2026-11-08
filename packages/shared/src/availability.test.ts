import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSlots, zonedTimeToUtc, spreadSlots, respectQuietHours, inQuietHours, addDays, weekdayOf } from './availability';
import { TEMPLATES } from './templates';

const TZ = 'Asia/Kolkata';
const hours = TEMPLATES.clinic.hours; // Mon–Sat 09:00–13:00 and 17:00–21:00, Sunday closed

test('zonedTimeToUtc converts local wall time, including across DST', () => {
  assert.equal(zonedTimeToUtc('2026-11-10', '16:30', TZ).toISOString(), '2026-11-10T11:00:00.000Z');
  // New York: EDT (-4) in July, EST (-5) in December.
  assert.equal(zonedTimeToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedTimeToUtc('2026-12-01', '09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
  // Day DST starts (2026-03-08): 09:00 is already EDT.
  assert.equal(zonedTimeToUtc('2026-03-08', '09:00', 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(weekdayOf('2026-11-10'), 'tue');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('slots respect opening hours, breaks, duration, lead time and Sunday closure', () => {
  const now = new Date('2026-11-10T03:00:00Z'); // 08:30 IST Tuesday
  const slots = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'dr', hours: null, busy: [] }], durationMin: 30, fromDate: '2026-11-10', days: 1, now, stepMin: 30 });
  const local = slots.map((s) => s.start.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }));
  assert.equal(local[0], '09:00');
  assert.ok(local.includes('12:30'));
  assert.ok(!local.includes('13:00'), 'lunch break');
  assert.ok(local.includes('17:00'));
  assert.equal(local[local.length - 1], '20:30');
  const sunday = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'dr', hours: null, busy: [] }], durationMin: 30, fromDate: '2026-11-15', days: 1, now, stepMin: 30 });
  assert.equal(sunday.length, 0);
});

test('busy times and buffers block slots; another staff member fills the gap', () => {
  const now = new Date('2026-11-10T03:00:00Z');
  const busy = [{ start: zonedTimeToUtc('2026-11-10', '09:00', TZ), end: zonedTimeToUtc('2026-11-10', '10:00', TZ) }];
  const one = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: null, busy }], durationMin: 30, bufferAfterMin: 15, fromDate: '2026-11-10', days: 1, now, stepMin: 15 });
  assert.equal(one[0].start.toISOString(), zonedTimeToUtc('2026-11-10', '10:00', TZ).toISOString());
  // With a buffer BEFORE of 15 minutes, 10:00 is too close to the 10:00 busy end.
  const withBefore = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: null, busy }], durationMin: 30, bufferBeforeMin: 15, fromDate: '2026-11-10', days: 1, now, stepMin: 15 });
  assert.equal(withBefore[0].start.toISOString(), zonedTimeToUtc('2026-11-10', '10:15', TZ).toISOString());
  const two = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: null, busy }, { id: 'b', hours: null, busy: [] }], durationMin: 30, fromDate: '2026-11-10', days: 1, now, stepMin: 30 });
  assert.deepEqual([two[0].staffId, two[0].start.toISOString()], ['b', zonedTimeToUtc('2026-11-10', '09:00', TZ).toISOString()]);
});

test('staff hours, leave, holidays and lead time', () => {
  const now = new Date('2026-11-10T05:00:00Z'); // 10:30 IST
  const staffHours = { ...hours, tue: { open: true, ranges: [{ from: '17:00', to: '19:00' }] } };
  const s = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: staffHours, busy: [] }], durationMin: 60, fromDate: '2026-11-10', days: 1, now, stepMin: 60 });
  assert.deepEqual(s.map((x) => x.start.toISOString()), [zonedTimeToUtc('2026-11-10', '17:00', TZ).toISOString(), zonedTimeToUtc('2026-11-10', '18:00', TZ).toISOString()]);
  const lead = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: null, busy: [] }], durationMin: 30, fromDate: '2026-11-10', days: 1, now, minLeadMin: 60, stepMin: 30 });
  assert.equal(lead[0].start.toISOString(), zonedTimeToUtc('2026-11-10', '11:30', TZ).toISOString());
  assert.equal(findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: null, leave: [{ from: '2026-11-10', to: '2026-11-10' }], busy: [] }], durationMin: 30, fromDate: '2026-11-10', days: 1, now }).length, 0);
  assert.equal(findSlots({ timeZone: TZ, businessHours: hours, holidays: ['2026-11-10'], staff: [{ id: 'a', hours: null, busy: [] }], durationMin: 30, fromDate: '2026-11-10', days: 1, now }).length, 0);
});

test('spreadSlots offers nearest slots spaced apart', () => {
  const now = new Date('2026-11-10T03:00:00Z');
  const all = findSlots({ timeZone: TZ, businessHours: hours, staff: [{ id: 'a', hours: null, busy: [] }], durationMin: 30, fromDate: '2026-11-10', days: 1, now, stepMin: 15 });
  const three = spreadSlots(all, 3, 60);
  assert.equal(three.length, 3);
  assert.equal(three[1].start.getTime() - three[0].start.getTime(), 60 * 60_000);
});

test('quiet hours: reminders move into allowed time without passing the appointment', () => {
  const quiet = { from: '21:00', to: '09:00' };
  const at = zonedTimeToUtc('2026-11-10', '07:30', TZ);
  assert.ok(inQuietHours(at, quiet, TZ));
  assert.equal(respectQuietHours(at, quiet, TZ)!.toISOString(), zonedTimeToUtc('2026-11-10', '09:00', TZ).toISOString());
  // Appointment at 09:30: 09:00 is still before it.
  assert.equal(respectQuietHours(at, quiet, TZ, zonedTimeToUtc('2026-11-10', '09:30', TZ))!.toISOString(), zonedTimeToUtc('2026-11-10', '09:00', TZ).toISOString());
  // Appointment at 08:45: send the evening before at 20:59 instead.
  assert.equal(respectQuietHours(at, quiet, TZ, zonedTimeToUtc('2026-11-10', '08:45', TZ))!.toISOString(), zonedTimeToUtc('2026-11-09', '20:59', TZ).toISOString());
  const noon = zonedTimeToUtc('2026-11-10', '12:00', TZ);
  assert.equal(respectQuietHours(noon, quiet, TZ), noon);
});
