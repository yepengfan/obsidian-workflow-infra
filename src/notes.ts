import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeConfig } from './config.js';
import { hasControlChars, notePath, validatePath } from './paths.js';

export const MAX_NOTE_BYTES = 64 * 1024;
export const MAX_SCAN_BYTES = 512 * 1024;
export const MAX_SCAN_KEYS = 20;
export const MAX_LIST_KEYS = 50;

export interface NoteObject { key: string; size: number; modified?: string }
export interface ObjectPage { objects: NoteObject[]; nextCursor?: string }
export interface NotesStore {
  list(prefix: string, cursor: string | undefined, count: number, signal: AbortSignal, after?: string): Promise<ObjectPage>;
  read(key: string, signal: AbortSignal): Promise<string>;
}

// This is also applied to actual streamed bytes, not just S3's ContentLength.
export async function boundedBody(body: AsyncIterable<Uint8Array> & { destroy?: () => void }, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = () => body.destroy?.();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of body) {
      signal.throwIfAborted();
      length += chunk.byteLength;
      if (length > MAX_NOTE_BYTES) throw new Error('Note exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', abort);
    body.destroy?.();
  }
}

export class S3NotesStore implements NotesStore {
  constructor(private readonly bucket: string, private readonly client: S3Client) {}

  async list(prefix: string, cursor: string | undefined, count: number, signal: AbortSignal, after?: string): Promise<ObjectPage> {
    const page = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket, Prefix: prefix, MaxKeys: count, ContinuationToken: cursor, StartAfter: after,
    }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    if (page.IsTruncated && !page.NextContinuationToken) throw new Error('S3 pagination failed');
    return {
      objects: (page.Contents ?? []).map((o) => ({ key: o.Key ?? '', size: o.Size ?? MAX_NOTE_BYTES + 1, modified: o.LastModified?.toISOString() })),
      nextCursor: page.IsTruncated ? page.NextContinuationToken : undefined,
    };
  }

  async read(key: string, signal: AbortSignal): Promise<string> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      // A hard transfer bound also protects against a changed object after listing.
      Range: `bytes=0-${MAX_NOTE_BYTES}`,
    }), { abortSignal: requestSignal }).catch(async (error: unknown) => {
      // S3 returns 416 for a range on a zero-byte object. HEAD uses s3:GetObject too.
      if (error instanceof Error && error.name === 'InvalidRange') {
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: requestSignal });
        if (head.ContentLength === 0) return { Body: undefined, ContentLength: 0 };
      }
      throw error;
    });
    if (!result.Body && result.ContentLength === 0) return '';
    if (!result.Body) throw new Error('Empty S3 response');
    const body = result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    if (result.ContentLength !== undefined && result.ContentLength > MAX_NOTE_BYTES) {
      body.destroy?.();
      throw new Error('Note exceeds size limit');
    }
    return boundedBody(body, requestSignal);
  }
}

export class Notes {
  constructor(private readonly config: Pick<RuntimeConfig, 'prefix'>, private readonly store: NotesStore) {}

  private relative(key: string): string | undefined {
    if (!key.startsWith(this.config.prefix)) return undefined;
    try { return notePath(key.slice(this.config.prefix.length)); } catch { return undefined; }
  }

  private cursor(cursor: string | undefined): string | undefined {
    if (cursor !== undefined && (!cursor || Buffer.byteLength(cursor) > 4096 || hasControlChars(cursor))) {
      throw new Error('Invalid cursor');
    }
    return cursor;
  }

  async list(input: { directory?: string; page_size: number; cursor?: string }, signal: AbortSignal) {
    const directory = input.directory ? `${validatePath(input.directory.replace(/\/$/u, ''))}/` : '';
    const page = await this.store.list(this.config.prefix + directory, this.cursor(input.cursor), Math.min(input.page_size, MAX_LIST_KEYS), signal);
    return {
      notes: page.objects.flatMap((o) => {
        const path = this.relative(o.key);
        return path ? [{ path, size_bytes: o.size, modified: o.modified, readable: o.size <= MAX_NOTE_BYTES }] : [];
      }),
      next_cursor: page.nextCursor ?? null,
      scanned_objects: page.objects.length,
    };
  }

  async read(path: string, signal: AbortSignal) {
    return { path: notePath(path), body: await this.store.read(this.config.prefix + notePath(path), signal) };
  }

  async search(input: { query: string; cursor?: string }, signal: AbortSignal) {
    const deadline = Date.now() + 14_000;
    const query = input.query.trim().toLocaleLowerCase('en-US');
    if (!query || Buffer.byteLength(query) > 256) throw new Error('Invalid query');
    // A checkpoint is a position, not an authorization credential. The fixed
    // configured prefix remains authoritative even for a client-edited cursor.
    const binding = createHash('sha256').update(JSON.stringify([this.config.prefix, query])).digest('hex');
    let after: string | undefined;
    if (input.cursor !== undefined) {
      const cursor = this.cursor(input.cursor)!;
      if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('Invalid search cursor');
      const decoded = z.object({ v: z.literal(1), afterBase64: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u), binding: z.string() }).strict()
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      after = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(decoded.afterBase64, 'base64url'));
      if (decoded.binding !== binding || !after.startsWith(this.config.prefix) || Buffer.byteLength(after) > 1024) {
        throw new Error('Search cursor does not match this query or vault');
      }
    }
    const page = await this.store.list(this.config.prefix, undefined, MAX_SCAN_KEYS, signal, after);
    const matches: { path: string; matched_on: string; snippet?: string }[] = [];
    let bytes = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;
    let checkpoint = after;
    let deferred = false;
    for (const object of page.objects) {
      signal.throwIfAborted();
      const path = this.relative(object.key);
      if (!path) { checkpoint = object.key; processed++; continue; }
      if (path.toLocaleLowerCase('en-US').includes(query)) {
        matches.push({ path, matched_on: 'filename' });
        checkpoint = object.key; processed++;
        continue;
      }
      if (object.size > MAX_NOTE_BYTES) {
        skipped++;
        checkpoint = object.key; processed++;
        continue;
      }
      if (bytes + MAX_NOTE_BYTES > MAX_SCAN_BYTES || Date.now() + 4000 > deadline) {
        deferred = true;
        break;
      }
      // Reserve the maximum read size, even if the listing underestimates the object.
      bytes += MAX_NOTE_BYTES;
      let body: string;
      try { body = await this.store.read(object.key, signal); }
      catch {
        signal.throwIfAborted();
        failed++;
        checkpoint = object.key; processed++;
        continue;
      }
      checkpoint = object.key; processed++;
      const folded = body.toLocaleLowerCase('en-US');
      const index = folded.indexOf(query);
      if (index !== -1) {
        // Unicode folding may change offsets slightly; snippets are approximate.
        matches.push({ path, matched_on: 'body', snippet: body.slice(Math.max(0, index - 80), index + query.length + 160) });
      }
    }
    const more = deferred || Boolean(page.nextCursor);
    if (more && (!checkpoint || checkpoint === after)) throw new Error('Search could not advance');
    return {
      matches, next_cursor: more ? Buffer.from(JSON.stringify({ v: 1, afterBase64: Buffer.from(checkpoint!).toString('base64url'), binding })).toString('base64url') : null,
      listed_objects: page.objects.length, scanned_objects: processed, body_read_budget_used_bytes: bytes,
      skipped_body_scans: skipped, failed_body_scans: failed, incomplete: skipped > 0 || failed > 0 || more,
      coverage: 'Per-call coverage only. Continue with next_cursor for the same query. Budget-limited objects are deferred, not skipped. Oversized or failed bodies remain uncovered; aggregate these counts across all calls. Listing is not a snapshot of concurrent edits.',
    };
  }
}
