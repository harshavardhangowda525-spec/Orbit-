import { Global, Injectable, Module } from '@nestjs/common';
import { TEMPLATES, type BusinessTemplate, type BusinessType, BUSINESS_TYPES } from '@orbit/shared';
import { DbService } from '../db/db.service';

/** Business-type templates, read from the admin-editable `business_templates` table. */
@Injectable()
export class TemplatesService {
  constructor(private readonly db: DbService) {}

  async get(type: BusinessType): Promise<BusinessTemplate> {
    const row = await this.db.one<{ content: BusinessTemplate }>(`SELECT content FROM business_templates WHERE type = $1`, [type]);
    return row?.content ?? TEMPLATES[type];
  }

  async list() {
    const rows = await this.db.q<{ type: string; content: BusinessTemplate }>(`SELECT type, content FROM business_templates`);
    const byType = new Map(rows.map((r) => [r.type, r.content]));
    return BUSINESS_TYPES.map((t) => {
      const c = byType.get(t) ?? TEMPLATES[t];
      return { type: t, icon: c.icon, defaultName: c.defaultName, services: c.services.slice(0, 3).map((s) => s.name) };
    });
  }
}

@Global()
@Module({ providers: [TemplatesService], exports: [TemplatesService] })
export class TemplatesModule {}
