import { Injectable } from '@nestjs/common';
import { computePulse, bridgeMode, localParts, type Sentence, type Weekday } from '@orbit/shared';
import { DbService, Tx } from '../db/db.service';
import { badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { groupFeed, type FeedItem } from './feed-group';

const num = (v: unknown) => Number(v ?? 0);

@Injectable()
export class BridgeService {
  constructor(private readonly db: DbService) {}

  /** Everything The Bridge home screen needs, in one round trip (fast on 4G). */
  async home(businessId: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one(`SELECT id, name, slug, timezone, currency, status, plan_id FROM businesses WHERE id = $1`, [businessId]);
      if (!biz) throw notFound();
      const tz: string = biz.timezone;
      const mode = bridgeMode(now, tz);
      const weekday = localParts(now, tz).weekday as Weekday;

      await this.expireCards(tx);
      const agents = await tx.q<{ agent_key: string; display_name: string; enabled: boolean }>(`SELECT agent_key, display_name, enabled FROM agents`);
      const names = Object.fromEntries(agents.map((a) => [a.agent_key, a.display_name]));

      const s = await tx.one(
        `WITH b AS (SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS start)
         SELECT
           (SELECT count(*) FROM bookings, b WHERE start_at >= b.start AND start_at < b.start + interval '1 day' AND status <> 'cancelled' AND deleted_at IS NULL) AS bookings_today,
           (SELECT count(*) FROM bookings, b WHERE start_at < b.start AND deleted_at IS NULL) AS bookings_before,
           (SELECT count(*) / 4.0 FROM bookings, b, generate_series(1, 4) k
              WHERE start_at >= b.start - make_interval(days => 7 * k) AND start_at < b.start - make_interval(days => 7 * k) + interval '1 day'
                AND status <> 'cancelled' AND deleted_at IS NULL) AS usual_bookings,
           (SELECT COALESCE(sum(amount), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.start AND paid_at < b.start + interval '1 day') AS money_today,
           (SELECT COALESCE(sum(amount), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.start - interval '1 day' AND paid_at < b.start) AS money_yesterday,
           (SELECT COALESCE(sum(amount), 0) / 4.0 FROM payments, b, generate_series(1, 4) k
              WHERE status = 'paid' AND paid_at >= b.start - make_interval(days => 7 * k) AND paid_at < b.start - make_interval(days => 7 * k) + interval '1 day') AS usual_money,
           (SELECT count(*) FROM conversations WHERE status = 'waiting_staff') AS people_waiting,
           (SELECT count(*) FROM approval_cards WHERE status = 'pending') AS pending_cards,
           (SELECT count(*) FROM reviews WHERE rating <= 2 AND replied_at IS NULL) AS bad_reviews,
           (SELECT count(*) FROM tasks WHERE status = 'failed' AND updated_at > $1::timestamptz - interval '1 day') AS failed_tasks,
           (SELECT count(*) FROM leads, b WHERE created_at >= b.start AND created_at < b.start + interval '1 day') AS leads_today,
           (SELECT count(*) FROM leads, b WHERE created_at >= b.start - interval '1 day' AND created_at < b.start) AS leads_yesterday,
           (SELECT count(*) FROM bookings, b WHERE start_at >= b.start AND start_at < b.start + interval '1 day' AND status = 'completed') AS completed_today,
           (SELECT count(*) FROM bookings, b WHERE start_at >= b.start AND start_at < b.start + interval '1 day' AND status = 'no_show') AS no_shows_today,
           (SELECT count(*) FROM invoices WHERE status IN ('sent', 'overdue')) AS unpaid_invoices,
           (SELECT COALESCE(sum(total), 0) FROM invoices WHERE status IN ('sent', 'overdue')) AS unpaid_amount,
           (SELECT min(start_at) FROM bookings, b WHERE start_at >= GREATEST(b.start, $1::timestamptz) AND start_at < b.start + interval '1 day' AND status IN ('pending', 'confirmed') AND deleted_at IS NULL) AS next_booking_at`,
        [now.toISOString(), tz],
      );

      const hasHistory = num(s.bookings_before) > 0;
      const pulse = computePulse({
        weekday,
        bookingsToday: num(s.bookings_today),
        usualBookings: hasHistory ? num(s.usual_bookings) : null,
        moneyToday: num(s.money_today),
        usualMoney: hasHistory ? num(s.usual_money) : null,
        peopleWaiting: num(s.people_waiting),
        pendingCards: num(s.pending_cards),
        badReviewsOpen: num(s.bad_reviews),
        failedTasks: num(s.failed_tasks),
      });
      await this.snapshotPulse(tx, pulse.score, pulse.sentence, s);

      const cards = await this.cards(tx, names);
      const feedRows = await tx.q(
        `SELECT id, agent_key, event_type, sentence, at, entity_type, entity_id, value_amount FROM feed_events ORDER BY at DESC LIMIT 40`,
      );
      const feedItems: FeedItem[] = feedRows.map((r) => ({
        id: r.id,
        agent: r.agent_key,
        type: r.event_type,
        sentence: withAgent(r.sentence, names[r.agent_key]),
        at: new Date(r.at).toISOString(),
        entityType: r.entity_type,
        entityId: r.entity_id,
        valueAmount: num(r.value_amount),
      }));

      const earningsRows = await tx.q(
        `SELECT agent_key, COALESCE(sum(value_amount), 0) AS value, COALESCE(sum(minutes_saved), 0) AS minutes
         FROM feed_events
         WHERE at >= (date_trunc('month', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2)
         GROUP BY agent_key`,
        [now.toISOString(), tz],
      );
      const byAgent = earningsRows
        .map((r) => ({ agent: r.agent_key, name: names[r.agent_key] ?? r.agent_key, value: num(r.value), minutes: num(r.minutes) }))
        .filter((r) => r.value > 0 || r.minutes > 0)
        .sort((a, b) => b.value - a.value);

      const cur = biz.currency;
      const money = (n: number) => `~m:${cur}:${n}`;
      const briefing: Sentence[] =
        mode === 'morning'
          ? [
              { key: 'brief.bookings_today', params: { count: num(s.bookings_today) } },
              ...(s.next_booking_at ? [{ key: 'brief.next_booking', params: { time: `~t:${new Date(s.next_booking_at).toISOString()}` } }] : []),
              { key: 'brief.money_yesterday', params: { amount: money(num(s.money_yesterday)) } },
              { key: 'brief.leads_yesterday', params: { count: num(s.leads_yesterday) } },
              ...(num(s.unpaid_invoices) > 0 ? [{ key: 'brief.unpaid', params: { count: num(s.unpaid_invoices), amount: money(num(s.unpaid_amount)) } }] : []),
            ]
          : [
              { key: 'brief.completed_today', params: { count: num(s.completed_today) } },
              { key: 'brief.money_today', params: { amount: money(num(s.money_today)) } },
              { key: 'brief.leads_today', params: { count: num(s.leads_today) } },
              ...(num(s.no_shows_today) > 0 ? [{ key: 'brief.no_shows', params: { count: num(s.no_shows_today) } }] : []),
            ];

      return {
        business: { id: biz.id, name: biz.name, slug: biz.slug, timezone: tz, currency: cur, status: biz.status },
        mode,
        pulse: { ...pulse, numbers: { moneyToday: num(s.money_today), bookingsToday: num(s.bookings_today), peopleWaiting: num(s.people_waiting) } },
        briefing,
        needsYou: cards,
        feed: groupFeed(feedItems, names),
        earnings: {
          total: byAgent.reduce((a, r) => a + r.value, 0),
          minutesSaved: byAgent.reduce((a, r) => a + r.minutes, 0),
          byAgent,
        },
        crew: agents.map((a) => ({ agent: a.agent_key, name: a.display_name, enabled: a.enabled })),
        suggestions:
          mode === 'morning'
            ? ['suggest.today_look', 'suggest.who_unpaid', 'suggest.new_customers_month']
            : ['suggest.how_today', 'suggest.tomorrow_bookings', 'suggest.who_unpaid'],
      };
    });
  }

  /** Needs You cards that expired get their safe default (usually "don't send"). */
  private async expireCards(tx: Tx) {
    const expired = await tx.q(
      `UPDATE approval_cards SET status = 'expired', decision = default_option, decided_at = now()
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now() RETURNING id, agent_key, task_id`,
    );
    for (const c of expired) {
      if (c.task_id) await tx.q(`UPDATE tasks SET status = 'cancelled', result = '{"reason":"card_expired"}' WHERE id = $1 AND status = 'waiting_approval'`, [c.task_id]);
      await postFeed(tx, 'orbit', 'card_expired', { key: 'feed.orbit.card_expired' }, { entityType: 'approval_card', entityId: c.id });
    }
  }

  private async cards(tx: Tx, names: Record<string, string>) {
    const rows = await tx.q(
      `SELECT id, agent_key, type, title, context, suggested_action, options, expires_at, created_at
       FROM approval_cards WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20`,
    );
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent_key,
      agentName: names[r.agent_key] ?? r.agent_key,
      type: r.type,
      title: withAgent(r.title, names[r.agent_key]),
      context: r.context,
      suggestedAction: r.suggested_action,
      options: r.options,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  }

  private async snapshotPulse(tx: Tx, score: number, explanation: Sentence, inputs: unknown) {
    const recent = await tx.one(`SELECT 1 FROM pulse_snapshots WHERE at > now() - interval '15 minutes'`);
    if (!recent) await tx.q(`INSERT INTO pulse_snapshots (score, explanation, inputs) VALUES ($1, $2, $3)`, [score, JSON.stringify(explanation), JSON.stringify(inputs)]);
  }

  async decideCard(businessId: string, userId: string, cardId: string, optionKey: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const card = await tx.one(`SELECT * FROM approval_cards WHERE id = $1 FOR UPDATE`, [cardId]);
      if (!card) throw notFound('That card is no longer here.');
      if (card.status !== 'pending') throw badRequest('already_decided', 'This was already decided.');
      const option = (card.options as { key: string; outcome: 'approved' | 'rejected' | 'edited' }[]).find((o) => o.key === optionKey);
      if (!option) throw badRequest('invalid_option', 'That choice is not available for this card.');
      await tx.q(`UPDATE approval_cards SET status = $2, decision = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [cardId, option.outcome, optionKey, userId]);
      if (card.task_id) {
        const next = option.outcome === 'approved' ? 'queued' : 'cancelled';
        await tx.q(`UPDATE tasks SET status = $2, result = CASE WHEN $2 = 'cancelled' THEN jsonb_build_object('reason', $3::text) ELSE result END WHERE id = $1 AND status = 'waiting_approval'`, [card.task_id, next, `owner_${option.outcome}`]);
      }
      const agent = await tx.one(`SELECT display_name FROM agents WHERE agent_key = $1`, [card.agent_key]);
      await postFeed(tx, 'orbit', `card_${option.outcome}`, { key: `feed.orbit.card_${option.outcome}`, params: { agent: agent?.display_name ?? card.agent_key } }, { entityType: 'approval_card', entityId: cardId });
      return { ok: true, status: option.outcome };
    }, userId);
  }

  /**
   * Command Bar. Phase 1 records the owner's request as an Orbit task; understanding
   * and planning (section 16) arrive with the AI layer in Phase 2.
   * Only the signed-in owner/staff can reach this route — never customer content.
   */
  async command(businessId: string, userId: string, text: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const task = await tx.one(
        `INSERT INTO tasks (agent_key, created_by_kind, goal, inputs, status, created_by) VALUES ('orbit', 'owner', $1, $2, 'queued', $3) RETURNING id`,
        [text, JSON.stringify({ text, via: 'command_bar' }), userId],
      );
      await postFeed(tx, 'orbit', 'command_received', { key: 'feed.orbit.command_received' }, { entityType: 'task', entityId: task.id });
      return { taskId: task.id, reply: { key: 'command.received' } as Sentence };
    }, userId);
  }
}

/** Inject the agent's (possibly renamed) display name so sentences say "Aria" or the owner's chosen name. */
function withAgent(s: Sentence, name?: string): Sentence {
  return name ? { ...s, params: { agent: name, ...(s.params ?? {}) } } : s;
}
