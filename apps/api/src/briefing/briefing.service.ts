import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { localParts } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { BridgeService } from '../bridge/bridge.service';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { BridgeModule } from '../bridge/bridge.module';

/** Morning briefing at 08:00 and evening summary at 19:00, in each business's own timezone. */
export const BRIEFING_HOURS = { morning: 8, evening: 19 } as const;

@Injectable()
export class BriefingService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly jobs: JobsService, private readonly bridge: BridgeService) {}

  onModuleInit() {
    this.jobs.register('briefing.sweep', () => this.sweep());
    this.jobs.register('briefing.generate', (d) => this.generate(d.businessId, d.type, new Date(d.at)).then(() => undefined));
  }

  /** Every 15 minutes: queue briefings that are due for live businesses (idempotent per business, date and type). */
  async sweep(now = new Date()) {
    const businesses = await this.db.q<{ id: string; timezone: string }>(`SELECT id, timezone FROM businesses WHERE status = 'live'`);
    let queued = 0;
    for (const b of businesses) {
      const { hour, date } = localParts(now, b.timezone);
      for (const type of ['morning', 'evening'] as const) {
        if (hour < BRIEFING_HOURS[type] || (type === 'morning' && hour >= 15)) continue;
        await this.jobs.enqueue('briefing.generate', { businessId: b.id, type, at: now.toISOString() }, { jobId: `brief:${b.id}:${date}:${type}` });
        queued++;
      }
    }
    return queued;
  }

  /** Build and store one briefing from live data; post it to the Feed and notify the owner. */
  async generate(businessId: string, type: 'morning' | 'evening', now = new Date()) {
    const home = await this.bridge.home(businessId, now, type);
    return this.db.withTenant(businessId, async (tx) => {
      const date = localParts(now, home.business.timezone).date;
      const content = { lines: home.briefing, pulse: { score: home.pulse.score, sentence: home.pulse.sentence }, numbers: home.pulse.numbers, needsYou: home.needsYou.length };
      const row = await tx.one(
        `INSERT INTO briefings (date, type, content, sent_via) VALUES ($1, $2, $3, ARRAY['app']) ON CONFLICT (business_id, date, type) DO NOTHING RETURNING id`,
        [date, type, JSON.stringify(content)],
      );
      if (!row) return null; // already generated today
      await postFeed(tx, 'orbit', 'briefing_ready', { key: type === 'morning' ? 'feed.orbit.morning_briefing' : 'feed.orbit.evening_summary' }, { entityType: 'briefing', entityId: row.id });
      await tx.q(`INSERT INTO notifications (user_id, type, title, link, channels_sent) VALUES (NULL, 'briefing', $1, '/bridge', ARRAY['app'])`, [
        JSON.stringify({ key: type === 'morning' ? 'notify.morning_briefing' : 'notify.evening_summary' }),
      ]);
      liveToBusiness(tx, { type: 'notification.new' });
      return { id: row.id, ...content };
    });
  }
}

@Module({ imports: [BridgeModule], providers: [BriefingService], exports: [BriefingService] })
export class BriefingModule {}
