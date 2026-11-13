/**
 * Vox on the phone: Exotel's Voicebot stream is simulated with a WebSocket
 * client, speech is the scripted FakeSpeech, the model is the fake provider.
 */
process.env.SPEECH_PROVIDER = 'fake';
import type { NestExpressApplication } from '@nestjs/platform-express';
import WebSocket from 'ws';
import { bootApp, onboard, upgrade } from './helpers';
import { DbService } from '../src/db/db.service';
import { AiService } from '../src/ai/ai.service';
import { text } from '../src/ai/fake.provider';
import { attachWebSockets } from '../src/realtime/ws.gateway';
import { VoiceService } from '../src/voice/voice.service';
import type { FakeSpeech } from '../src/voice/speech';

const tone = (ms: number, amp = 6000) => {
  const pcm = Buffer.alloc((ms / 1000) * 8000 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * amp), i * 2);
  return pcm;
};
const silence = (ms: number) => Buffer.alloc((ms / 1000) * 8000 * 2);
const until = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

/** A fake Exotel media stream: sends start/media/stop, records what Orbit sends back. */
class Line {
  ws: WebSocket;
  got: any[] = [];
  closed: { code: number } | null = null;
  opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (m) => this.got.push(JSON.parse(m.toString())));
    this.ws.on('close', (code) => (this.closed = { code }));
    this.opened = new Promise((res, rej) => {
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
    });
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
  start(callSid: string, from: string) {
    this.send({ event: 'connected' });
    this.send({ event: 'start', stream_sid: `st-${callSid}`, start: { stream_sid: `st-${callSid}`, call_sid: callSid, from, to: '08047180000', media_format: { encoding: 'raw/slin', sample_rate: '8000' } } });
  }
  /** Caller says something: speech, then a pause long enough to end the sentence. */
  speak(ms = 600) {
    const pcm = Buffer.concat([tone(ms), silence(900)]);
    for (let i = 0; i < pcm.length; i += 320) this.send({ event: 'media', media: { payload: pcm.subarray(i, i + 320).toString('base64') } });
  }
  media() {
    return this.got.filter((e) => e.event === 'media');
  }
  stop() {
    this.send({ event: 'stop', stop: { reason: 'callended' } });
  }
}

describe('Vox phone calls', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let voice: VoiceService;
  let speech: FakeSpeech;
  let port: number;
  let a: Awaited<ReturnType<typeof onboard>>;
  let streamPath = '';
  const realFetch = global.fetch;
  const exotel: { url: string; body: string }[] = [];
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);

  beforeAll(async () => {
    global.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      if (!u.includes('exotel.com')) return realFetch(url as any, init);
      exotel.push({ url: u, body: String(init?.body ?? '') });
      if (u.includes('/Calls/connect')) return new Response(JSON.stringify({ Call: { Sid: 'out-sid-1', Status: 'in-progress' } }), { status: 200 });
      if (u.includes('/Accounts/bad-account')) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ Account: { Sid: 'ok' } }), { status: 200 });
    }) as any;
    app = await bootApp();
    await app.listen(0);
    attachWebSockets(app, app.getHttpServer());
    port = (app.getHttpServer().address() as any).port;
    db = app.get(DbService);
    voice = app.get(VoiceService);
    speech = voice.speech as FakeSpeech;
    a = await onboard(app, 'salon', 'Voice Salon');
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await app.close();
  });

  afterEach(() => {
    app.get(AiService).fake!.reset();
    speech.heard = [];
    speech.spoken = [];
  });

  const line = async (path = streamPath) => {
    const l = new Line(`ws://127.0.0.1:${port}${path}`);
    await l.opened;
    return l;
  };

  it('needs the Business plan; checks the Exotel keys and returns the Voicebot URL', async () => {
    const free = await a.api.post('/voice/exotel/connect', { accountSid: 'voicesalon1', apiKey: 'key-1234567890', apiToken: 'token-1234567890', exophone: '080 4718 0000' }).expect(400);
    expect(free.body.code ?? free.body.error?.code).toBeDefined();
    await upgrade(app, a.businessId);
    await a.api.post('/voice/exotel/connect', { accountSid: 'bad-account', apiKey: 'key-1234567890', apiToken: 'token-1234567890', exophone: '080 4718 0000' }).expect(400);
    const r = await a.api.post('/voice/exotel/connect', { accountSid: 'voicesalon1', apiKey: 'key-1234567890', apiToken: 'token-1234567890', exophone: '080 4718 0000', appId: '123456' }).expect(201);
    expect(r.body.streamPath).toMatch(/^\/voice\/exotel\/[\w-]{20,}$/);
    streamPath = r.body.streamPath;
    const s = (await a.api.get('/voice').expect(200)).body;
    expect(s).toMatchObject({ speechReady: true, onPlan: true, vox: { enabled: true }, exotel: { exophone: '+918047180000', outbound: true, streamPath } });
    const secret = await tenant(a.businessId, (tx) => tx.one(`SELECT encrypted_tokens::text AS t FROM power_connections WHERE power_type = 'phone' AND status = 'connected'`));
    expect(secret.t).not.toContain('token-1234567890');
  });

  it('answers a call: greets, hears the caller, replies with the agent loop, and stops talking when interrupted', async () => {
    const fake = app.get(AiService).fake!;
    fake.script = (req) => {
      expect(req.system).toContain('ON A PHONE CALL');
      return [text('Yes, we have a haircut at 5 in the evening tomorrow. Shall I book it?')];
    };
    speech.heard.push('Do you have a haircut slot tomorrow?');
    const l = await line();
    l.start('in-sid-1', '09876500001');
    await until(() => l.media().length > 0);
    expect(speech.spoken[0].text).toContain('Voice Salon');
    l.speak();
    await until(() => speech.spoken.length >= 2);
    expect(speech.spoken[1].text).toContain('haircut at 5');
    // Caller talks over Vox: the stream is told to clear queued audio.
    l.speak(300);
    await until(() => l.got.some((e) => e.event === 'clear'));
    l.stop();
    await until(() => !!l.closed);
    await until(async () => !!(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM calls WHERE call_sid = 'in-sid-1' AND ended_at IS NOT NULL`))));
    const call = await tenant(a.businessId, (tx) => tx.one(`SELECT cl.*, c.phone FROM calls cl JOIN customers c ON c.id = cl.customer_id WHERE cl.call_sid = 'in-sid-1'`));
    expect(call).toMatchObject({ direction: 'in', purpose: 'inbound', status: 'completed', minutes_billed: 1, phone: '+919876500001', handled_by: 'vox' });
    expect(call.transcript).toContain('Caller: Do you have a haircut slot tomorrow?');
    const msgs = await tenant(a.businessId, (tx) => tx.q(`SELECT sender, direction FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`, [call.conversation_id]));
    expect(msgs.slice(0, 3)).toEqual([{ sender: 'vox', direction: 'out' }, { sender: 'customer', direction: 'in' }, { sender: 'vox', direction: 'out' }]);
    const conv = await tenant(a.businessId, (tx) => tx.one(`SELECT channel, status FROM conversations WHERE id = $1`, [call.conversation_id]));
    expect(conv).toEqual({ channel: 'phone', status: 'closed' });
    const feed = await tenant(a.businessId, (tx) => tx.one(`SELECT agent_key FROM feed_events WHERE event_type = 'call_handled'`));
    expect(feed?.agent_key).toBe('vox');
  });

  it('passes the caller to the team when they ask for a person (the stream ends so Exotel connects them)', async () => {
    speech.heard.push('I want to talk to a person please');
    const l = await line();
    l.start('in-sid-2', '09876500002');
    await until(() => l.media().length > 0);
    l.speak();
    await until(() => !!l.closed, 8000);
    expect(speech.spoken.at(-1)!.text).toContain('connecting you');
    await until(async () => !!(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM calls WHERE call_sid = 'in-sid-2' AND ended_at IS NOT NULL`))));
    const conv = await tenant(a.businessId, (tx) => tx.one(`SELECT cv.handled_by, cl.outcome FROM calls cl JOIN conversations cv ON cv.id = cl.conversation_id WHERE cl.call_sid = 'in-sid-2'`));
    expect(conv).toMatchObject({ handled_by: 'human', outcome: 'transferred' });
  });

  it('does not take the call when Vox is off, and refuses unknown lines', async () => {
    await tenant(a.businessId, (tx) => tx.q(`UPDATE agents SET enabled = false WHERE agent_key = 'vox'`));
    try {
      const l = await line();
      l.start('in-sid-3', '09876500003');
      await until(() => !!l.closed);
      expect(l.media()).toHaveLength(0);
      expect(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM calls WHERE call_sid = 'in-sid-3'`))).toBeFalsy();
    } finally {
      await tenant(a.businessId, (tx) => tx.q(`UPDATE agents SET enabled = true WHERE agent_key = 'vox'`));
    }
    const unknown = await line('/voice/exotel/not-a-real-key-123');
    await until(() => !!unknown.closed);
    expect(unknown.closed!.code).toBe(4404);
  });

  it('calls the owner on request and matches the answered call to it (test calls are not billed)', async () => {
    const r = await a.api.post('/voice/test-call', { phone: '98765 00009' }).expect(201);
    const placed = exotel.find((x) => x.url.includes('/Calls/connect.json'))!;
    expect(placed.url).toContain('api.in.exotel.com/v1/Accounts/voicesalon1/');
    const form = new URLSearchParams(placed.body);
    expect(form.get('From')).toBe('+919876500009');
    expect(form.get('Url')).toBe('http://my.exotel.com/voicesalon1/exoml/start_voice/123456');
    const l = await line();
    l.start('out-sid-1', '08047180000');
    await until(() => l.media().length > 0);
    l.stop();
    await until(async () => !!(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM calls WHERE id = $1 AND ended_at IS NOT NULL`, [r.body.callId]))));
    const call = await tenant(a.businessId, (tx) => tx.one(`SELECT * FROM calls WHERE id = $1`, [r.body.callId]));
    expect(call).toMatchObject({ direction: 'out', purpose: 'test', minutes_billed: 0, call_sid: 'out-sid-1' });
    expect(call.conversation_id).toBeTruthy();
  });

  it('owners can talk to Vox from the browser; others cannot', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/voice/web?token=nope&business=${a.businessId}`);
    const code = await new Promise<number>((res) => bad.on('close', (c) => res(c)));
    expect(code).toBe(4401);
    const got: (Buffer | any)[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/web?token=${a.owner.token}&business=${a.businessId}`);
    ws.on('message', (m, binary) => got.push(binary ? m : JSON.parse(m.toString())));
    await new Promise((res) => ws.on('open', res));
    await until(() => got.some((m) => Buffer.isBuffer(m)));
    expect(got.find((m) => !Buffer.isBuffer(m) && m.type === 'said')?.text).toContain('Voice Salon');
    ws.close();
    await until(async () => !!(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM calls WHERE purpose = 'test' AND from_number = 'browser' AND ended_at IS NOT NULL`))));
  });

  it('the live-update socket still works next to the voice sockets', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${a.owner.token}&business=${a.businessId}`);
    const first = await new Promise<any>((res) => ws.on('message', (m) => res(JSON.parse(m.toString()))));
    expect(first.type).toBe('hello');
    ws.close();
  });
});
