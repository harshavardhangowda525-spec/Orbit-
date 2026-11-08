import { Global, Injectable, Module } from '@nestjs/common';
import { DbService, Tx } from '../db/db.service';

export interface AuditEntry {
  businessId?: string | null;
  actorId?: string | null;
  actorKind?: 'user' | 'admin' | 'agent' | 'system';
  action: string;
  entity?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Append-only audit log of sensitive actions. The app role cannot UPDATE or DELETE it. */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async write(e: AuditEntry, tx?: Tx) {
    const sql = `INSERT INTO audit_log (business_id, actor_id, actor_kind, action, entity, entity_id, before, after, ip)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    const params = [
      e.businessId ?? null,
      e.actorId ?? null,
      e.actorKind ?? 'user',
      e.action,
      e.entity ?? null,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      normaliseIp(e.ip),
    ];
    if (tx) await tx.q(sql, params);
    else await this.db.q(sql, params);
  }
}

function normaliseIp(ip?: string | null): string | null {
  if (!ip) return null;
  const v = ip.replace(/^::ffff:/, '');
  return /^[0-9a-f.:]+$/i.test(v) ? v : null;
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
