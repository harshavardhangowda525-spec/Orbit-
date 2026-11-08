import { Client } from 'pg';
import { DEFAULT_PLANS, TEMPLATES, localParts, type BusinessType } from '@orbit/shared';
import { config } from '../config';
import { Tx } from '../db/db.service';
import { applyTemplate } from '../onboarding/onboarding.service';
import { migrate } from './migrate';

/**
 * Sample data: two businesses of different types with a realistic day, so
 * The Bridge, Pulse and the isolation tests have something to show.
 *   Admin:            +91 98000 00000
 *   Glow Studio owner (Meera): +91 98000 00001  (Base plan)
 *   IronCore Gym:     +91 98000 00002  (Business plan)
 * Re-running the seed replaces these two businesses.
 */

const TZ = 'Asia/Kolkata';

/** A local IST time `dayOffset` days from today, as a Date. */
function at(dayOffset: number, hh: number, mm = 0): Date {
  const today = localParts(new Date(), TZ).date;
  const d = new Date(`${today}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d;
}
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

interface SampleBusiness {
  slug: string;
  name: string;
  type: BusinessType;
  plan: 'free' | 'base' | 'business';
  ownerPhone: string;
  ownerName: string;
  city: string;
  address: string;
  phone: string;
  description: string;
  staff: string[];
  customers: [string, string][];
}

const SALON: SampleBusiness = {
  slug: 'glow-studio',
  name: 'Glow Studio',
  type: 'salon',
  plan: 'base',
  ownerPhone: '+919800000001',
  ownerName: 'Meera',
  city: 'Bengaluru',
  address: '12, 4th Cross, Indiranagar, Bengaluru 560038',
  phone: '+918041234567',
  description: 'A friendly neighbourhood salon for hair, skin and grooming.',
  staff: ['Ravi', 'Anjali'],
  customers: [
    ['Anil Kumar', '+919811100001'], ['Priya Nair', '+919811100002'], ['Rahul Verma', '+919811100003'],
    ['Sneha Rao', '+919811100004'], ['Kiran Gowda', '+919811100005'], ['Divya Shetty', '+919811100006'],
    ['Arjun Reddy', '+919811100007'], ['Lakshmi Iyer', '+919811100008'], ['Farhan Ali', '+919811100009'],
    ['Pooja Hegde', '+919811100010'], ['Vikram Singh', '+919811100011'], ['Ananya Bhat', '+919811100012'],
  ],
};

const GYM: SampleBusiness = {
  slug: 'ironcore-gym',
  name: 'IronCore Gym',
  type: 'gym',
  plan: 'business',
  ownerPhone: '+919800000002',
  ownerName: 'Suresh',
  city: 'Mysuru',
  address: '88, Kalidasa Road, VV Mohalla, Mysuru 570002',
  phone: '+918212345678',
  description: 'Strength, cardio and personal training. Open from 5:30 am.',
  staff: ['Coach Manoj', 'Coach Fatima'],
  customers: [
    ['Rohit Sharma', '+919822200001'], ['Neha Joshi', '+919822200002'], ['Imran Khan', '+919822200003'],
    ['Kavya Murthy', '+919822200004'], ['Deepak Patil', '+919822200005'], ['Swathi Prasad', '+919822200006'],
    ['Aditya Kulkarni', '+919822200007'], ['Meghana Gowda', '+919822200008'], ['Naveen Raj', '+919822200009'],
    ['Shruti Menon', '+919822200010'],
  ],
};

async function upsertUser(tx: Tx, phone: string, name: string, admin = false) {
  return tx.one<{ id: string }>(
    `INSERT INTO users (phone, name, is_platform_admin, auth_providers) VALUES ($1, $2, $3, '[{"provider":"phone"}]')
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, is_platform_admin = users.is_platform_admin OR EXCLUDED.is_platform_admin
     RETURNING id`,
    [phone, name, admin],
  ) as Promise<{ id: string }>;
}

async function createSample(tx: Tx, s: SampleBusiness): Promise<string> {
  const owner = await upsertUser(tx, s.ownerPhone, s.ownerName);
  const plan = await tx.one(`SELECT id, features FROM plans WHERE code = $1`, [s.plan]);
  // Also remove the sample's earlier name (Glow Salon -> Glow Studio) so re-seeding leaves one copy.
  await tx.q(`DELETE FROM businesses WHERE slug = ANY($1)`, [[s.slug, ...(s.slug === 'glow-studio' ? ['glow-salon'] : [])]]);
  const biz = await tx.one<{ id: string }>(
    `INSERT INTO businesses (name, slug, type, timezone, default_language, supported_languages, plan_id, status, onboarding_step, launched_at, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'en', ARRAY['en','hi','kn'], $5, 'live', 7, now() - interval '40 days', $6, now() - interval '40 days') RETURNING id`,
    [s.name, s.slug, s.type, TZ, plan.id, owner.id],
  );
  const id = biz!.id;
  await tx.q(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'owner')`, [owner.id, id]);
  await tx.q(`SELECT set_config('app.business_id', $1, true)`, [id]);
  await applyTemplate(tx, TEMPLATES[s.type], plan.features, owner.id);
  await tx.q(`UPDATE business_profiles SET address = $1, city = $2, phone = $3, whatsapp = $3, description = $4`, [s.address, s.city, s.phone, s.description]);

  const staff: string[] = [];
  for (const n of s.staff) staff.push((await tx.one(`INSERT INTO staff (name) VALUES ($1) RETURNING id`, [n]))!.id);
  const services = await tx.q<{ id: string; name: string; duration_min: number; price: string | null }>(
    `SELECT id, name, duration_min, price FROM services WHERE duration_min > 0 ORDER BY sort_order`,
  );
  const customers: { id: string; name: string }[] = [];
  for (const [i, [name, phone]] of s.customers.entries()) {
    customers.push(
      (await tx.one(
        `INSERT INTO customers (name, phone, language, source, consent, visit_count, lifetime_spend, last_visit_at)
         VALUES ($1, $2, $3, $4, '{"whatsapp":true,"sms":true,"email":false,"calls":true,"marketing":true}', $5, $6, now() - make_interval(days => $7)) RETURNING id, name`,
        [name, phone, i % 4 === 0 ? 'kn' : i % 3 === 0 ? 'hi' : 'en', i % 2 ? 'whatsapp' : 'website_chat', 2 + (i % 5), 1200 + i * 350, i * 3],
      ))!,
    );
  }

  // Bookings: the same weekday over the past 4 weeks (Pulse "usual" baseline) and today.
  let n = 0;
  const book = async (start: Date, status: string, source: string, ci: number) => {
    const svc = services[n % services.length];
    const dur = svc.duration_min || 60;
    const end = new Date(start.getTime() + dur * 60_000);
    const row = await tx.one(
      `INSERT INTO bookings (customer_id, service_id, staff_id, start_at, end_at, status, source, price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [customers[ci % customers.length].id, svc.id, staff[n % staff.length], start, end, status, source, svc.price],
    );
    n++;
    return { id: row!.id as string, svc, price: Number(svc.price ?? 0) };
  };
  const usual = s.type === 'salon' ? 6 : 5;
  for (const week of [1, 2, 3, 4]) {
    for (let k = 0; k < usual; k++) {
      const b = await book(at(-7 * week, 10 + k * 2), 'completed', 'aria:whatsapp', k + week);
      if (b.price) await tx.q(`INSERT INTO payments (amount, method, status, paid_at, provider) VALUES ($1, 'upi', 'paid', $2, 'cash_counter')`, [b.price, at(-7 * week, 11 + k * 2)]);
    }
  }
  // Yesterday's money for the morning briefing.
  for (let k = 0; k < 4; k++) {
    const b = await book(at(-1, 10 + k * 2), 'completed', 'owner', k + 3);
    if (b.price) await tx.q(`INSERT INTO payments (amount, method, status, paid_at) VALUES ($1, 'upi', 'paid', $2)`, [b.price, at(-1, 11 + k * 2)]);
  }
  // Today: a busier day than usual.
  const todayCount = usual + 3;
  const todays = [];
  for (let k = 0; k < todayCount; k++) {
    const start = at(0, 9 + Math.floor(k * 1.3), (k % 2) * 30);
    const done = start.getTime() + 60 * 60_000 < Date.now();
    todays.push(await book(start, done ? 'completed' : 'confirmed', k % 3 === 0 ? 'aria:website_chat' : 'aria:whatsapp', k));
  }
  for (const b of todays.filter((_, k) => k < 3)) {
    if (b.price) await tx.q(`INSERT INTO payments (amount, method, status, paid_at) VALUES ($1, 'upi', 'paid', $2)`, [b.price, minsAgo(30)]);
  }

  // Conversations: two people waiting for a human.
  for (const ci of [1, 4]) {
    const cv = await tx.one(
      `INSERT INTO conversations (customer_id, channel, status, handled_by, last_message_at) VALUES ($1, 'whatsapp', 'waiting_staff', 'aria', $2) RETURNING id`,
      [customers[ci].id, minsAgo(12 + ci)],
    );
    await tx.q(`INSERT INTO messages (conversation_id, direction, sender, body) VALUES ($1, 'in', 'customer', $2), ($1, 'out', 'aria', $3)`, [
      cv!.id,
      ci === 1 ? 'Can I get a discount if I book for my sister too?' : 'Do you have parking near your place?',
      ci === 1 ? 'Let me check with the team and get back to you shortly.' : 'Let me check with the team and get back to you shortly.',
    ]);
  }
  await tx.q(`INSERT INTO leads (customer_id, interest, source_channel, status, created_at) VALUES ($1, $2, 'instagram', 'new', $3), ($4, $2, 'whatsapp', 'contacted', $5)`, [
    customers[6].id, s.type === 'gym' ? 'Personal training' : 'Hair colour', minsAgo(90), customers[7].id, at(-1, 18),
  ]);

  const feed = (agent: string, type: string, key: string, params: Record<string, unknown>, m: number, value = 0, minutes = 0, channel: string | null = null) =>
    tx.q(`INSERT INTO feed_events (agent_key, event_type, sentence, value_amount, minutes_saved, at, channel) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      agent, type, JSON.stringify({ key, params }), value, minutes, minsAgo(m), channel,
    ]);
  // Live Crew activity (drives the agent pings and the ticker on The Bridge).
  const activity = (agent: string, key: string, params: Record<string, unknown>) =>
    tx.q(`INSERT INTO tasks (agent_key, created_by_kind, goal, status, activity, started_at) VALUES ($1, 'system', $2, 'running', $3, now())`, [agent, key, JSON.stringify({ key, params })]);
  const card = (agent: string, type: string, key: string, params: Record<string, unknown>, options: unknown[], context: unknown, m: number, def = 'no') =>
    tx.q(`INSERT INTO approval_cards (agent_key, type, title, options, context, default_option, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 day')`, [
      agent, type, JSON.stringify({ key, params }), JSON.stringify(options), JSON.stringify(context), def, minsAgo(m),
    ]);

  if (s.type === 'salon') {
    await feed('aria', 'booking_created', 'feed.aria.booked', { customer: 'Anil', service: 'a haircut', time: `~t:${at(0, 16).toISOString()}`, channel: '@channel.whatsapp' }, 8, 300, 6, 'whatsapp');
    await feed('aria', 'booking_created', 'feed.aria.booked', { customer: 'Sneha', service: 'a facial', time: `~t:${at(0, 17).toISOString()}`, channel: '@channel.website_chat' }, 20, 1200, 6, 'website_chat');
    await feed('aria', 'booking_created', 'feed.aria.booked', { customer: 'Kiran', service: 'a beard trim', time: `~t:${at(0, 18).toISOString()}`, channel: '@channel.whatsapp' }, 26, 150, 6, 'whatsapp');
    await feed('aria', 'handover', 'feed.aria.handover', { customer: 'Priya' }, 30, 0, 0, 'whatsapp');
    await feed('nudge', 'reminder_sent', 'feed.nudge.reminders', { count: 7 }, 75, 0, 21, 'whatsapp');
    await feed('ledger', 'payment_received', 'feed.ledger.collected', { amount: '~m:INR:2400', count: 3 }, 120, 2400, 15, 'whatsapp');
    await feed('aria', 'question_answered', 'feed.aria.answered', { customer: 'Divya', topic: 'prices' }, 150, 0, 4, 'instagram');
    await feed('nudge', 'review_request_sent', 'feed.nudge.review_request', { customer: 'Lakshmi' }, 200, 0, 3, 'whatsapp');
    await activity('aria', 'activity.aria.replying', { customer: 'Pooja', channel: '@channel.whatsapp' });
    await activity('nudge', 'activity.nudge.sending', {});
    await tx.q(`INSERT INTO reviews (platform, author, rating, text, posted_at) VALUES ('google', 'Rahul', 2, 'Had to wait 30 minutes even with a booking.', now() - interval '3 hours'), ('google', 'Divya', 5, 'Anjali is the best! Lovely haircut.', now() - interval '6 days'), ('google', 'Arjun', 5, 'Clean, quick and friendly.', now() - interval '12 days')`);
    await card('aria', 'discount', 'card.discount', { customer: 'Priya', percent: 10 },
      [{ key: 'yes', label: 'card.option.yes', style: 'primary', outcome: 'approved' }, { key: 'no', label: 'card.option.no', style: 'secondary', outcome: 'rejected' }, { key: 'reply_myself', label: 'card.option.reply_myself', style: 'ghost', outcome: 'edited' }],
      { channel: 'whatsapp', conversation: 'Priya: "Can I get a discount if I book for my sister too?"' }, 13);
    await card('nudge', 'review_reply', 'card.bad_review', { customer: 'Rahul' },
      [{ key: 'post', label: 'card.option.post', style: 'primary', outcome: 'approved' }, { key: 'edit', label: 'card.option.edit', style: 'secondary', outcome: 'edited' }],
      { channel: 'google_business_profile', review: 'Had to wait 30 minutes even with a booking.', suggestedReply: 'Sorry about the wait, Rahul. That is not the experience we want for you. Your next visit has a 15-minute guarantee, and we would love to make it up to you.' }, 170);
  } else {
    await feed('vox', 'calls_done', 'feed.vox.called_batch', { count: 6, renewed: 4 }, 40, 6000, 45, 'phone');
    await activity('vox', 'activity.vox.calling', { count: 3 });
    await feed('ledger', 'payment_received', 'feed.ledger.collected', { amount: '~m:INR:2400', count: 3 }, 65, 2400, 15);
    await feed('aria', 'booking_created', 'feed.aria.booked', { customer: 'Neha', service: 'a free trial session', time: `~t:${at(0, 18).toISOString()}`, channel: '@channel.instagram' }, 90, 0, 6);
    await feed('aria', 'lead_captured', 'feed.aria.lead', { customer: 'Aditya', interest: 'Personal training' }, 90, 0, 5);
    await feed('nudge', 'reminder_sent', 'feed.nudge.renewals', { count: 9 }, 180, 0, 25);
    await feed('spark', 'draft_ready', 'feed.spark.drafted', { count: 214, occasion: 'Diwali' }, 240, 0, 60);
    await card('spark', 'campaign', 'card.campaign', { count: 214, occasion: 'Diwali' },
      [{ key: 'send', label: 'card.option.send', style: 'primary', outcome: 'approved' }, { key: 'edit', label: 'card.option.edit', style: 'secondary', outcome: 'edited' }],
      { sample: 'Happy Diwali from IronCore Gym! Renew this week and get 20% off your next 3 months.', channels: ['whatsapp', 'instagram'], audience: '214 customers · visited last year' }, 240);
  }
  await tx.q(`INSERT INTO usage_counters (period, ai_messages, tasks) VALUES (to_char(now(), 'YYYY-MM'), $1, $2)`, [s.type === 'gym' ? 420 : 610, 85]);
  return id;
}

export async function seed(url = config.databaseMigrationUrl) {
  await migrate(url, true);
  const client = new Client({ connectionString: url });
  await client.connect();
  const tx = new Tx(client as any);
  try {
    await client.query('BEGIN');
    if (!(await tx.one(`SELECT 1 FROM plans WHERE code = $1`, [DEFAULT_PLANS[0].code]))) throw new Error('plans missing');
    for (const phone of config.platformAdminPhones) await upsertUser(tx, phone, 'Orbit Admin', true);
    const salon = await createSample(tx, SALON);
    await tx.q(`SELECT set_config('app.business_id', '', true)`);
    const gym = await createSample(tx, GYM);
    await client.query('COMMIT');
    return { salon, gym };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seed()
    .then((r) => console.log(`Seeded Glow Studio (${r.salon}) and IronCore Gym (${r.gym}).\nSign in with +91 98000 00001 (salon), +91 98000 00002 (gym) or +91 98000 00000 (admin).`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
