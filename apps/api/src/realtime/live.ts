import type { LiveEvent, RealtimeService } from './realtime.service';
import type { Tx } from '../db/db.service';

/** Module-level handle so plain helpers (postFeed etc.) can publish without DI. */
let bus: RealtimeService | null = null;
export function setLiveBus(r: RealtimeService) {
  bus = r;
}

/** Publish to the business's screens after the transaction commits. */
export function liveToBusiness(tx: Tx, event: LiveEvent) {
  const id = tx.businessId;
  if (!id) return;
  tx.afterCommit(() => bus?.toBusiness(id, event));
}

export function liveToConversation(tx: Tx, conversationId: string, event: LiveEvent) {
  tx.afterCommit(() => bus?.toConversation(conversationId, event));
}
