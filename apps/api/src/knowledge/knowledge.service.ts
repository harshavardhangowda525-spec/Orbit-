import { Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Tx } from '../db/db.service';
import { DbService } from '../db/db.service';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { notFound } from '../common/errors';

export interface KnowledgeHit {
  id: string;
  type: string;
  title: string;
  content: string;
}

/** What the business knows (FAQs, policies, notes, price lists). Aria answers only from this and the service list. */
@Injectable()
export class KnowledgeService {
  async search(tx: Tx, query: string, limit = 5): Promise<KnowledgeHit[]> {
    const words = [...new Set((query.toLowerCase().slice(0, 300).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w)))].slice(0, 12);
    if (!words.length) return [];
    // Any word may match (prefix match, so "price" finds "prices"); more and repeated matches rank higher.
    const tsq = words.map((w) => `${w.replace(/[^\p{L}\p{N}]/gu, '')}:*`).join(' | ');
    return tx.q<KnowledgeHit>(
      `SELECT id, type, title, content FROM knowledge_items, to_tsquery('simple', $1) q
       WHERE active AND deleted_at IS NULL AND search @@ q
       ORDER BY ts_rank_cd(search, q) DESC, length(content) ASC LIMIT $2`,
      [tsq, limit],
    );
  }
}

/** Common words that should not decide which answer matches (English + Hinglish). */
const STOPWORDS = new Set(
  'the and are you your for with what when where how can does have has there this that from near any about please want need tell know will would could should which who our ours is was were hai kya kab kaha kitna aap mujhe'.split(' '),
);

const Item = z.object({
  type: z.enum(['faq', 'policy', 'document', 'price_list', 'note']),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  language: z.string().max(8).default('en'),
  active: z.boolean().default(true),
});

@UseGuards(TenantGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(`SELECT id, type, title, content, language, active, source, updated_at AS "updatedAt" FROM knowledge_items WHERE deleted_at IS NULL ORDER BY type, created_at`),
    );
  }

  @Roles('owner', 'manager')
  @Post()
  create(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Item)) b: z.infer<typeof Item>) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.one(`INSERT INTO knowledge_items (type, title, content, language, active, source, created_by) VALUES ($1,$2,$3,$4,$5,'owner',$6) RETURNING id`, [b.type, b.title, b.content, b.language, b.active, t.userId]),
    );
  }

  @Roles('owner', 'manager')
  @Patch(':id')
  async update(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Item.partial())) b: Partial<z.infer<typeof Item>>) {
    const r = await this.db.withTenant(t.businessId, (tx) =>
      tx.one(
        `UPDATE knowledge_items SET type = COALESCE($2, type), title = COALESCE($3, title), content = COALESCE($4, content), active = COALESCE($5, active)
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, b.type ?? null, b.title ?? null, b.content ?? null, b.active ?? null],
      ),
    );
    if (!r) throw notFound();
    return r;
  }

  @Roles('owner', 'manager')
  @Delete(':id')
  async remove(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenant(t.businessId, (tx) => tx.one(`UPDATE knowledge_items SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]));
    if (!r) throw notFound();
    return { ok: true };
  }
}

@Module({ controllers: [KnowledgeController], providers: [KnowledgeService], exports: [KnowledgeService] })
export class KnowledgeModule {}
