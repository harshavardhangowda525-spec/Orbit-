import { Controller, Get, Global, Injectable, Module, Param, ParseUUIDPipe, Post, Query, Res, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DbService, type Tx } from '../db/db.service';
import { CurrentTenant, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { badRequest, notFound } from '../common/errors';
import { logger } from '../logger';

export const FILE_PURPOSES = ['price_list', 'card', 'hours', 'bill', 'settlement'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const BUCKET = 'orbit-private';

/** Supabase Storage, when the server has the service key; otherwise files live in the database. */
function supabase(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return url && key ? { url, key } : null;
}

/**
 * Photos and PDFs owners upload (price lists, bills, settlement screenshots).
 * Each file belongs to one business (row-level security); in Supabase Storage it
 * sits under that business's folder in a private bucket.
 */
@Injectable()
export class FilesService {
  private bucketReady = false;
  constructor(private readonly db: DbService) {}

  private async ensureBucket(s: { url: string; key: string }) {
    if (this.bucketReady) return;
    const r = await fetch(`${s.url}/storage/v1/bucket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, apikey: s.key, 'content-type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_BYTES }),
    }).catch(() => null);
    // 200 created, 400/409 already exists.
    if (r && (r.ok || r.status === 400 || r.status === 409)) this.bucketReady = true;
  }

  async save(tx: Tx, f: { purpose: FilePurpose; mime: string; data: Buffer; userId?: string | null }): Promise<string> {
    if (!ALLOWED.test(f.mime)) throw badRequest('file_type', 'Please upload a photo (JPG or PNG) or a PDF.');
    if (f.data.length > MAX_BYTES) throw badRequest('file_too_big', 'That file is over 10 MB. Please use a smaller photo.');
    const s = supabase();
    if (s) {
      await this.ensureBucket(s);
      const row = await tx.one(`INSERT INTO files (purpose, mime, size_bytes, storage, created_by) VALUES ($1, $2, $3, 'supabase', $4) RETURNING id, business_id`, [f.purpose, f.mime, f.data.length, f.userId ?? null]);
      const path = `${row.business_id}/${f.purpose}/${row.id}`;
      const up = await fetch(`${s.url}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.key}`, apikey: s.key, 'content-type': f.mime, 'x-upsert': 'true' },
        body: new Uint8Array(f.data),
      }).catch((e) => ({ ok: false, status: 0, text: async () => (e as Error).message }) as any);
      if (up.ok) {
        await tx.q(`UPDATE files SET path = $2 WHERE id = $1`, [row.id, path]);
        return row.id;
      }
      // Storage unavailable: keep the file anyway, in the database.
      logger.warn(`Supabase Storage upload failed (${up.status}); keeping the file in the database`, 'Files');
      await tx.q(`UPDATE files SET storage = 'db', data = $2 WHERE id = $1`, [row.id, f.data]);
      return row.id;
    }
    const row = await tx.one(`INSERT INTO files (purpose, mime, size_bytes, storage, data, created_by) VALUES ($1, $2, $3, 'db', $4, $5) RETURNING id`, [f.purpose, f.mime, f.data.length, f.data, f.userId ?? null]);
    return row.id;
  }

  /** The file's bytes (only this business's files are visible). */
  async read(tx: Tx, id: string): Promise<{ mime: string; data: Buffer } | null> {
    const f = await tx.one(`SELECT mime, storage, path, data FROM files WHERE id = $1`, [id]);
    if (!f) return null;
    if (f.storage === 'db') return { mime: f.mime, data: f.data };
    const s = supabase();
    if (!s || !f.path) return null;
    const r = await fetch(`${s.url}/storage/v1/object/${BUCKET}/${f.path}`, { headers: { authorization: `Bearer ${s.key}`, apikey: s.key } }).catch(() => null);
    if (!r?.ok) return null;
    return { mime: f.mime, data: Buffer.from(await r.arrayBuffer()) };
  }

  /** Several files as base64 for the vision model. */
  async forVision(tx: Tx, ids: string[]) {
    const out: { mime: string; data: string }[] = [];
    for (const id of ids) {
      const f = await this.read(tx, id);
      if (!f) throw notFound('That photo is no longer here. Please upload it again.');
      out.push({ mime: f.mime, data: f.data.toString('base64') });
    }
    return out;
  }
}

@UseGuards(TenantGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly db: DbService, private readonly files: FilesService) {}

  /** Upload up to 5 photos or PDFs (10 MB each; the app shrinks photos before sending). */
  @Post()
  @UseInterceptors(FilesInterceptor('files', MAX_FILES, { limits: { fileSize: MAX_BYTES, files: MAX_FILES } }))
  async upload(@CurrentTenant() t: Tenant, @UploadedFiles() uploads: any[], @Query('purpose') purpose: string) {
    if (!(FILE_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('purpose', 'Unknown upload type.');
    if (!uploads?.length) throw badRequest('no_file', 'Please choose a photo or PDF.');
    return this.db.withTenant(t.businessId, async (tx) => ({
      ids: await Promise.all(uploads.map((u) => this.files.save(tx, { purpose: purpose as FilePurpose, mime: u.mimetype, data: u.buffer, userId: t.userId }))),
    }), t.userId);
  }

  /** View a stored photo or PDF (e.g. the bill behind an expense). */
  @Get(':id')
  async get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.db.withTenant(t.businessId, (tx) => this.files.read(tx, id));
    if (!f) throw notFound();
    res.setHeader('content-type', f.mime);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(f.data);
  }
}

@Global()
@Module({ controllers: [FilesController], providers: [FilesService], exports: [FilesService] })
export class FilesModule {}
