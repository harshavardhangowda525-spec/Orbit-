/**
 * Phase 4 acceptance: Snap to set up (price list, business card, hours board).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AiService } from '../src/ai/ai.service';
import { DbService } from '../src/db/db.service';
import { bootApp, onboard } from './helpers';

type Biz = Awaited<ReturnType<typeof onboard>>;
const PHOTO = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), name: 'board.jpg', type: 'image/jpeg' };

/** A clear printed salon price list of 15 items, as a vision model would read it. */
const BOARD = [
  ['Haircut (Men)', '₹350'], ['Haircut (Women)', '₹600/-'], ['Beard trim', '150/-'], ['Shave', 'Rs. 120'], ['Head massage', '₹250'],
  ['Hair spa', '800 onwards'], ['Hair colour', '₹1,500 - 2,500'], ['Keratin', '₹4,500'], ['Facial', '1,200'], ['Clean-up', '₹600'],
  ['Manicure', '₹450'], ['Pedicure', '₹550'], ['Waxing (full arms)', '₹350'], ['Threading', '₹50'], ['Bridal makeup', '₹15,000'],
];

describe('Snap to set up', () => {
  let app: NestExpressApplication;
  let S: Biz;
  const fake = () => app.get(AiService).fake!;
  const upload = async (purpose = 'price_list') => (await S.api.upload(`/files?purpose=${purpose}`, [PHOTO]).expect(201)).body.ids as string[];
  const services = () => app.get(DbService).withTenant(S.businessId, (tx) => tx.q(`SELECT name, name_en, price::float AS price, price_type, price_max::float AS price_max, duration_min, source_file_ids FROM services WHERE deleted_at IS NULL ORDER BY sort_order`));

  beforeAll(async () => {
    app = await bootApp();
    S = await onboard(app, 'other', 'Snap Salon'); // its template has no salon services, so duplicates come only from this test
  });
  beforeEach(() => fake().reset());
  afterAll(() => app.close());

  it('a 15-item price list: names and prices read correctly, nothing saved until Add, then all added with the photo kept', async () => {
    fake().seeScript = () => JSON.stringify({ is_price_list: true, readable: true, services: BOARD.map(([name, price_text]) => ({ name, price_text, category: 'Salon', confidence: 0.95, language: 'en' })) });
    const before = (await services()).length;
    const ids = await upload();
    const r = (await S.api.post('/snap', { kind: 'price_list', fileIds: ids }).expect(201)).body;
    expect(r.problem).toBeNull();
    // The vision model got the photo and the strict extraction instruction.
    expect(fake().seen[0].images).toHaveLength(1);
    expect(fake().seen[0].prompt).toMatch(/KIND: price_list/);
    const drafts = r.result.services;
    expect(drafts).toHaveLength(15);
    const byName = Object.fromEntries(drafts.map((d: any) => [d.name, d]));
    expect(byName['Haircut (Women)']).toMatchObject({ price: 600, priceType: 'fixed' });
    expect(byName['Shave'].price).toBe(120);
    expect(byName['Hair spa']).toMatchObject({ price: 800, priceType: 'from' });
    expect(byName['Hair colour']).toMatchObject({ price: 1500, priceMax: 2500, priceType: 'range' });
    expect(byName['Bridal makeup'].price).toBe(15000);
    // Durations not on the board are suggested from the business template, and say so.
    expect(drafts.every((d: any) => d.durationSuggested && d.durationMin >= 5)).toBe(true);
    expect(drafts.filter((d: any) => d.duplicate)).toEqual([]);

    // Nothing saved yet.
    expect((await services()).length).toBe(before);

    const items = drafts.map((d: any) => ({ name: d.name, nameEn: d.nameEn, category: d.category, price: d.price, priceType: d.priceType, priceMax: d.priceMax, durationMin: d.durationMin, action: 'add' }));
    const a = (await S.api.post(`/snap/${r.id}/services`, { items }).expect(201)).body;
    expect(a).toEqual({ added: 15, updated: 0 });
    const after = await services();
    expect(after.length).toBe(before + 15);
    const colour = after.find((s: any) => s.name === 'Hair colour');
    expect(colour).toMatchObject({ price: 1500, price_type: 'range', price_max: 2500, source_file_ids: ids });
    // Applying twice does nothing.
    expect((await S.api.post(`/snap/${r.id}/services`, { items })).body.error.code).toBe('already_added');
    // Aria knows the new prices straight away.
    const pub = (await S.api.get('/onboarding/state').expect(200)).body.services.map((s: any) => s.name);
    expect(pub).toContain('Bridal makeup');
  });

  it('duplicates offer update / keep both / skip', async () => {
    const existing = (await services()).find((s: any) => s.name === 'Beard trim')!;
    fake().seeScript = () => JSON.stringify({ is_price_list: true, readable: true, services: [{ name: 'Beard Trim', price_text: '₹200', confidence: 0.9 }, { name: 'Threading', price_text: '₹60', confidence: 0.9 }, { name: 'Nail art', price_text: '₹400', confidence: 0.9 }] });
    const r = (await S.api.post('/snap', { kind: 'price_list', fileIds: await upload() }).expect(201)).body;
    const [beard, thread, nail] = r.result.services;
    expect(beard.duplicate).toMatchObject({ name: 'Beard trim', price: existing.price });
    expect(thread.duplicate).toMatchObject({ name: 'Threading' });
    expect(nail.duplicate).toBeNull();
    const item = (d: any, action: string) => ({ name: d.name, price: d.price, priceType: d.priceType, durationMin: d.durationMin, action, ...(action === 'update' ? { updateId: d.duplicate.id } : {}) });
    expect((await S.api.post(`/snap/${r.id}/services`, { items: [item(beard, 'update'), item(thread, 'skip'), item(nail, 'add')] }).expect(201)).body).toEqual({ added: 1, updated: 1 });
    const now = await services();
    expect(now.filter((s: any) => s.name.toLowerCase() === 'beard trim')).toEqual([expect.objectContaining({ price: 200 })]);
    expect(now.find((s: any) => s.name === 'Threading').price).toBe(50);
    expect(now.find((s: any) => s.name === 'Nail art').price).toBe(400);
  });

  it('Hindi and Kannada boards keep the original script, with an English name alongside', async () => {
    fake().seeScript = () => JSON.stringify({ is_price_list: true, readable: true, services: [
      { name: 'बाल कटाई', name_en: 'Haircut', price_text: 'रु. ३००', language: 'hi', confidence: 0.9 },
      { name: 'ಮುಖ ಸ್ವಚ್ಛತೆ', name_en: 'Facial clean-up', price_text: 'ರೂ ೪೫೦', language: 'kn', confidence: 0.7 },
    ] });
    const r = (await S.api.post('/snap', { kind: 'price_list', fileIds: await upload() }).expect(201)).body;
    expect(r.result.services[0]).toMatchObject({ name: 'बाल कटाई', nameEn: 'Haircut', price: 300 });
    // Low confidence: shown in amber, "Please check".
    expect(r.result.services[1]).toMatchObject({ name: 'ಮುಖ ಸ್ವಚ್ಛತೆ', nameEn: 'Facial clean-up', price: 450, check: ['name', 'price'] });
  });

  it('blurry photos and photos that are not price lists say so instead of guessing', async () => {
    fake().seeScript = () => JSON.stringify({ is_price_list: true, readable: false, services: [] });
    expect((await S.api.post('/snap', { kind: 'price_list', fileIds: await upload() }).expect(201)).body).toMatchObject({ problem: 'unreadable' });
    fake().seeScript = () => JSON.stringify({ is_price_list: false, readable: true, services: [] });
    expect((await S.api.post('/snap', { kind: 'price_list', fileIds: await upload() }).expect(201)).body).toMatchObject({ problem: 'not_a_price_list' });
    fake().seeScript = () => 'Sorry, I cannot help with that.';
    expect((await S.api.post('/snap', { kind: 'price_list', fileIds: await upload() }).expect(201)).body).toMatchObject({ problem: 'unreadable' });
  });

  it('a business card and an hours board fill the details the owner keeps', async () => {
    fake().seeScript = () => JSON.stringify({ readable: true, name: 'Snap Salon & Spa', phone: '+91 98450 11111', address: '5, MG Road, Bengaluru', hours: null, confidence: { name: 0.9 } });
    const c = (await S.api.post('/snap', { kind: 'card', fileIds: await upload('card') }).expect(201)).body;
    expect(c.result).toMatchObject({ name: 'Snap Salon & Spa', phone: '+91 98450 11111' });
    await S.api.post(`/snap/${c.id}/details`, { phone: c.result.phone, address: c.result.address }).expect(201);

    fake().seeScript = () => JSON.stringify({ readable: true, hours: { mon: [['9:30', '20:00']], tue: [['09:30', '20:00']], wed: [], thu: [['09:30', '20:00']], fri: [['09:30', '20:00']], sat: [['09:00', '21:00']], sun: [['10:00', '14:00']] } });
    const h = (await S.api.post('/snap', { kind: 'hours', fileIds: await upload('hours') }).expect(201)).body;
    expect(h.result.hours.mon).toEqual({ open: true, ranges: [{ from: '09:30', to: '20:00' }] });
    expect(h.result.hours.wed).toEqual({ open: false, ranges: [] });
    await S.api.post(`/snap/${h.id}/details`, { hours: h.result.hours }).expect(201);
    const p = await app.get(DbService).withTenant(S.businessId, (tx) => tx.one(`SELECT phone, address, hours FROM business_profiles`));
    expect(p).toMatchObject({ phone: '+91 98450 11111', address: '5, MG Road, Bengaluru' });
    expect(p.hours.sun).toEqual({ open: true, ranges: [{ from: '10:00', to: '14:00' }] });
  });

  it('uploads: photos and PDFs only, and another business cannot read them', async () => {
    const bad = await S.api.upload('/files?purpose=price_list', [{ data: Buffer.from('hi'), name: 'x.txt', type: 'text/plain' }]);
    expect(bad.body.error.code).toBe('file_type');
    const [id] = await upload();
    const own = await S.api.get(`/files/${id}`).expect(200);
    expect(own.headers['content-type']).toMatch(/image\/jpeg/);
    const other = await onboard(app, 'gym', 'Other Gym');
    expect((await other.api.get(`/files/${id}`)).status).toBe(404);
    expect((await other.api.post('/snap', { kind: 'price_list', fileIds: [id] })).body.error.code).toBe('photos');
  });
});
