/**
 * A voice agent on Sarvam's platform using Orbit as its tools: this plays
 * Sarvam's side (HTTP calls with the business's Orbit key).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootApp, onboard } from './helpers';
import { DbService } from '../src/db/db.service';
import { durationSeconds, matchByName, transcriptLines } from '../src/voice/sarvam-agent';

describe('Sarvam voice agent → Orbit', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let a: Awaited<ReturnType<typeof onboard>>;
  let key = '';
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);
  const call = (path: string, body: object, k = key) => request(app.getHttpServer()).post(`/integrations/sarvam/${path}`).set('authorization', `Bearer ${k}`).send(body);
  const CALL = { call_id: 'sv-int-1', caller: '09876511111' };

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    a = await onboard(app, 'salon', 'Glow Salon');
  });
  afterAll(() => app.close());

  it('matches what callers say to service names', () => {
    const rows = [{ name: 'Haircut (women)' }, { name: 'Hair spa' }, { name: 'Facial (classic)' }];
    expect(matchByName(rows, 'hair cut')?.name).toBe('Haircut (women)');
    expect(matchByName(rows, 'facial')?.name).toBe('Facial (classic)');
    expect(matchByName(rows, 'spa for hair')?.name).toBe('Hair spa');
    expect(matchByName(rows, 'pizza')).toBeNull();
    expect([durationSeconds('95'), durationSeconds(95), durationSeconds('95s'), durationSeconds('1:35'), durationSeconds('00:01:35'), durationSeconds('x')]).toEqual([95, 95, 95, 95, 95, 0]);
    expect(transcriptLines('User: hi\nAgent: Hello!\nUser: book a facial')).toEqual([
      { who: 'caller', text: 'hi' }, { who: 'agent', text: 'Hello!' }, { who: 'caller', text: 'book a facial' },
    ]);
  });

  it('only the owner creates the key; calls without a valid key are refused', async () => {
    await call('info', CALL, 'nope').expect(401);
    const r = await a.api.post('/voice/sarvam/key', {}).expect(201);
    key = r.body.key;
    expect(key).toMatch(/^orbit_sv_/);
    expect((await a.api.get('/voice/sarvam').expect(200)).body.connected).toBe(true);
    const stored = await db.one(`SELECT external_id FROM channel_routes WHERE channel = 'sarvam_agent' AND business_id = $1`, [a.businessId]);
    expect(stored!.external_id).not.toBe(key);
  });

  it('a whole call: facts, free times, booking, finding it, moving it, a message, then the transcript', async () => {
    const info = (await call('info', CALL).expect(200)).body;
    expect(info.business).toBe('Glow Salon');
    expect(info.services.length).toBeGreaterThan(0);
    const service = info.services.find((s: any) => s.minutes > 0).name;

    const bad = (await call('availability', { ...CALL, service: 'pizza' }).expect(200)).body;
    expect(bad).toMatchObject({ ok: false });
    expect(bad.services).toContain(service);

    const av = (await call('availability', { ...CALL, service: service.toLowerCase() }).expect(200)).body;
    expect(av.ok).toBe(true);
    expect(av.slots.length).toBeGreaterThan(1);

    const noName = (await call('book', { ...CALL, service, start: av.slots[0].start }).expect(200)).body;
    expect(noName).toMatchObject({ ok: false });
    const booked = (await call('book', { ...CALL, service, start: av.slots[0].start, name: 'Riya Sharma' }).expect(200)).body;
    expect(booked).toMatchObject({ ok: true, service });
    const row = await tenant(a.businessId, (tx) => tx.one(`SELECT bk.source, c.phone, c.name FROM bookings bk JOIN customers c ON c.id = bk.customer_id WHERE bk.id = $1`, [booked.booking_id]));
    expect(row).toEqual({ source: 'vox:phone', phone: '+919876511111', name: 'Riya Sharma' });
    const feed = await tenant(a.businessId, (tx) => tx.one(`SELECT agent_key FROM feed_events WHERE event_type = 'booking_created' AND entity_id = $1`, [booked.booking_id]));
    expect(feed.agent_key).toBe('vox');

    // The same time again is refused (no double booking).
    const again = (await call('book', { call_id: 'sv-int-2', caller: '09876522222', service, start: av.slots[0].start, name: 'Someone' }).expect(200)).body;
    expect(again.ok).toBe(false);

    const mine = (await call('my-bookings', CALL).expect(200)).body;
    expect(mine.bookings.map((b: any) => b.booking_id)).toContain(booked.booking_id);

    // Another caller cannot touch Riya's booking.
    const stranger = (await call('cancel', { call_id: 'sv-int-3', caller: '09876533333', booking_id: booked.booking_id }).expect(200)).body;
    expect(stranger.ok).toBe(false);

    const moved = (await call('reschedule', { ...CALL, booking_id: booked.booking_id, start: av.slots[1].start }).expect(200)).body;
    expect(moved.ok).toBe(true);

    const msg = (await call('message', { ...CALL, name: 'Riya', message: 'Wants a bridal package quote' }).expect(200)).body;
    expect(msg.ok).toBe(true);
    const note = await tenant(a.businessId, (tx) => tx.one(`SELECT title FROM notifications WHERE type = 'vox_message' ORDER BY created_at DESC LIMIT 1`));
    expect(note.title).toMatchObject({ key: 'notify.vox_message', params: { customer: 'Riya' } });

    await call('call-ended', { ...CALL, call_length: '1:35', transcript: 'User: I want a haircut tomorrow\nAgent: Sure, 4 pm is free. Shall I book it?\nUser: yes' }).expect(200);
    await call('call-ended', { ...CALL, duration_sec: 95, transcript: 'User: I want a haircut tomorrow' }).expect(200); // repeat is harmless
    const c = await tenant(a.businessId, (tx) => tx.one(`SELECT cl.status, cl.duration_sec, cl.outcome, cl.minutes_billed, cl.conversation_id FROM calls cl WHERE cl.call_sid = 'sarvam:sv-int-1'`));
    expect(c).toMatchObject({ status: 'completed', duration_sec: 95, outcome: 'message', minutes_billed: 0 });
    const msgs = await tenant(a.businessId, (tx) => tx.q(`SELECT sender FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`, [c.conversation_id]));
    expect(msgs.map((m: any) => m.sender)).toEqual(['customer', 'vox', 'customer']);
    const handled = await tenant(a.businessId, (tx) => tx.q(`SELECT 1 FROM feed_events WHERE event_type = 'call_handled'`));
    expect(handled).toHaveLength(1);
  });

  it('a new key replaces the old one, and revoking stops all calls', async () => {
    const old = key;
    key = (await a.api.post('/voice/sarvam/key', {}).expect(201)).body.key;
    await call('info', CALL, old).expect(401);
    await call('info', CALL).expect(200);
    await a.api.delete('/voice/sarvam/key').expect(200);
    await call('info', CALL).expect(401);
  });
});
