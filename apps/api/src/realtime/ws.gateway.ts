import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { RealtimeService } from './realtime.service';
import type { JwtPayload } from '../auth/types';
import { logger } from '../logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * WebSocket endpoint at /ws.
 *   Owners/staff:  /ws?token=<jwt>&business=<id>   -> live updates for that business
 *   Customers:     /ws?visitor=<token>&conversation=<id> -> their own chat only
 * Access is checked exactly like the REST API (membership / visitor token).
 */
export function attachWebSockets(app: INestApplication, server: Server) {
  const jwt = app.get(JwtService);
  const db = app.get(DbService);
  const realtime = app.get(RealtimeService);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', async (socket: WebSocket & { alive?: boolean }, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const q = url.searchParams;
    let channel: string | null = null;
    try {
      if (q.get('token') && UUID_RE.test(q.get('business') ?? '')) {
        const p = jwt.verify<JwtPayload>(q.get('token')!);
        const businessId = q.get('business')!;
        const ok = p.imp
          ? p.imp.businessId === businessId
          : !!(await db.one(
              `SELECT 1 FROM memberships m JOIN businesses b ON b.id = m.business_id
               WHERE m.user_id = $1 AND m.business_id = $2 AND m.status = 'active' AND b.status <> 'suspended'`,
              [p.sub, businessId],
            ));
        if (ok) channel = `biz:${businessId}`;
      } else if (q.get('visitor') && UUID_RE.test(q.get('conversation') ?? '') && /^[a-z0-9-]{1,64}$/.test(q.get('slug') ?? '')) {
        const biz = await db.one<{ id: string }>(`SELECT id FROM businesses WHERE slug = $1`, [q.get('slug')]);
        if (biz) {
          const conv = await db.withTenant(biz.id, (tx) =>
            tx.one(`SELECT id FROM conversations WHERE id = $1 AND visitor_token_hash = $2`, [q.get('conversation'), hashToken(q.get('visitor')!)]),
          );
          if (conv) channel = `conv:${conv.id}`;
        }
      }
    } catch {
      channel = null;
    }
    if (!channel) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const off = realtime.subscribe(channel, (e) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(e)));
    socket.alive = true;
    socket.on('pong', () => (socket.alive = true));
    socket.on('message', () => undefined); // clients only listen
    socket.on('close', off);
    socket.send(JSON.stringify({ type: 'hello' }));
  });

  const beat = setInterval(() => {
    for (const s of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (s.alive === false) {
        s.terminate();
        continue;
      }
      s.alive = false;
      s.ping();
    }
  }, 30_000);
  beat.unref();
  wss.on('close', () => clearInterval(beat));
  server.on('close', () => wss.close());
  logger.log('WebSocket endpoint ready at /ws', 'Realtime');
  return wss;
}
