import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { runtime } from '../config';
import { logger } from '../logger';
import { requestContext } from '../context';

export type JobHandler = (data: any) => Promise<unknown>;

/**
 * Background jobs. Every job carries business_id in its data and handlers run
 * under that business (withTenant), so isolation rules apply to all jobs.
 * Jobs are idempotent (handlers check state) and retried with exponential backoff.
 *
 * bullmq mode: Redis-backed delayed and repeatable jobs.
 * inline mode (tests): jobs are kept in memory and run with runDue().
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private handlers = new Map<string, JobHandler>();
  private queue?: Queue;
  private worker?: Worker;
  readonly pending: { name: string; data: any; runAt: number; jobId?: string }[] = [];

  register(name: string, handler: JobHandler) {
    this.handlers.set(name, handler);
  }

  /** Start processing (called once at boot in the API process). */
  async start(repeatables: { name: string; everyMs: number }[] = []) {
    if (runtime.jobsMode !== 'bullmq' || this.worker) return;
    const connection = { url: runtime.redisUrl, maxRetriesPerRequest: null as null };
    this.queue = new Queue('orbit', { connection });
    this.worker = new Worker('orbit', (job: Job) => this.dispatch(job.name, job.data), { connection, concurrency: 8 });
    this.worker.on('failed', (job, err) => logger.error(`job ${job?.name} failed: ${err.message}`, err.stack, 'Jobs'));
    for (const r of repeatables) {
      await this.queue.upsertJobScheduler(r.name, { every: r.everyMs }, { name: r.name, data: {} });
    }
    logger.log(`Background jobs running (${[...this.handlers.keys()].join(', ')})`, 'Jobs');
  }

  async enqueue(name: string, data: Record<string, unknown>, opts: { delayMs?: number; jobId?: string } = {}) {
    const delay = Math.max(0, opts.delayMs ?? 0);
    if (runtime.jobsMode === 'inline' || !this.queue) {
      if (opts.jobId && this.pending.some((p) => p.jobId === opts.jobId)) return;
      this.pending.push({ name, data, runAt: Date.now() + delay, jobId: opts.jobId });
      return;
    }
    await this.queue.add(name, data, {
      delay,
      jobId: opts.jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  private async dispatch(name: string, data: any) {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`No handler for job ${name}`);
    await requestContext.run({ requestId: `job:${name}`, businessId: data?.businessId }, () => h(data));
  }

  /** Inline mode: run every pending job due at or before `now` (tests drive time with this). */
  async runDue(now = Date.now(), names?: string[]) {
    let ran = 0;
    for (;;) {
      const i = this.pending.findIndex((p) => p.runAt <= now && (!names || names.includes(p.name)));
      if (i < 0) return ran;
      const [job] = this.pending.splice(i, 1);
      await this.dispatch(job.name, job.data);
      ran++;
    }
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
