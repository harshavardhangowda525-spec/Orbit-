import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config, pgSsl } from '../config';
import { currentContext } from '../context';

/** A transaction handle. All queries run on the same connection. */
export class Tx {
  /** Callbacks run only after a successful COMMIT (e.g. live updates). */
  readonly after: (() => void)[] = [];
  constructor(private readonly client: PoolClient, readonly businessId?: string) {}
  afterCommit(fn: () => void) {
    this.after.push(fn);
  }
  async q<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }
  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.q<T>(sql, params))[0];
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Database access. Two pools with deliberately different PostgreSQL roles:
 *   app   (orbit_app)   — RLS always applies. Used by every API route and job.
 *   admin (orbit_admin) — BYPASSRLS. Used ONLY by the platform admin panel.
 *
 * Business data is only reachable through `withTenant`, which sets
 * app.business_id for the duration of one transaction (SET LOCAL semantics),
 * so a pooled connection can never leak one business's context to the next request.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly app = new Pool({ connectionString: config.databaseUrl, max: 10, ssl: pgSsl() });
  readonly admin = new Pool({ connectionString: config.databaseAdminUrl, max: 3, ssl: pgSsl() });

  async onModuleDestroy() {
    await Promise.all([this.app.end(), this.admin.end()]);
  }

  /** Query platform tables (users, businesses, memberships, plans...). Tenant tables return nothing here. */
  async q<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.app.query<T>(sql, params)).rows;
  }
  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.q<T>(sql, params))[0];
  }

  /** Run `fn` in a transaction on the app pool without any business context. */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(this.app, fn);
  }

  /** Run `fn` in a transaction scoped to one business. RLS limits every query to that business. */
  async withTenant<T>(businessId: string, fn: (tx: Tx) => Promise<T>, userId?: string): Promise<T> {
    if (!UUID_RE.test(businessId)) throw new Error('withTenant: invalid business id');
    const ctx = currentContext();
    if (ctx) ctx.businessId = businessId;
    return this.run(this.app, async (tx) => {
      await tx.q(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [businessId, userId ?? '']);
      return fn(tx);
    }, businessId);
  }

  /** Platform admin queries across businesses (BYPASSRLS role). Never use for owner-facing routes. */
  async adminTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(this.admin, fn);
  }

  private async run<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, businessId?: string): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new Tx(client, businessId);
      const result = await fn(tx);
      await client.query('COMMIT');
      for (const f of tx.after) {
        try {
          f();
        } catch {
          /* live updates are best-effort */
        }
      }
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
