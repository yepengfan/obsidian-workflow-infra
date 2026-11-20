import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';
import { indexedModules, resolveIndexedKey } from './index-modules/index.js';
import { indexAttributes, type IndexedModule, type IndexRow, type IndexValue } from './index-modules/types.js';

/** Every queued change shares one FIFO group, so a single consumer applies them in order. */
export const INDEX_MESSAGE_GROUP = 'index';

/** Largest note the indexer parses. Larger notes are reported as invalid. */
export const MAX_SOURCE_BYTES = 262144;

export interface SourceObject { key: string; etag: string }
/** Reads one current note: undefined when it no longer exists, or 'too_large'. */
export interface SourceReader { get(key: string): Promise<{ text: string; etag: string } | undefined | 'too_large'> }
export interface SourceCatalog { list(prefix: string, cursor?: string): Promise<{ objects: SourceObject[]; next?: string }> }
export interface IndexWriter {
  put(module: IndexedModule<IndexRow>, item: Record<string, IndexValue>): Promise<void>;
  remove(module: IndexedModule<IndexRow>, id: string): Promise<void>;
}
/** Each row's item ID with the source key and ETag it was built from. */
export interface IndexCatalog { scan(module: IndexedModule<IndexRow>, cursor?: string): Promise<{ rows: { id: string; key: string; etag: string }[]; next?: string }> }
export interface IndexQueue { send(keys: string[]): Promise<void> }
type Log = (record: Record<string, unknown>) => void;
export interface ApplyDependencies { bucket: string; prefix: string; source: SourceReader; rows: IndexWriter; now(): Date; log: Log }
export interface ReconcileDependencies { prefix: string; sources: SourceCatalog; index: IndexCatalog; queue: IndexQueue; log: Log }
export type IndexerDependencies = ApplyDependencies & ReconcileDependencies;

export type IndexOutcome = 'indexed' | 'removed' | 'invalid_source' | 'ignored';

/** Builds a row from one note, or undefined when its frontmatter is not a valid item. */
export function buildRow(module: IndexedModule<IndexRow>, id: string, key: string, etag: string, text: string, indexedAt: string) {
  const parsed = parseFrontmatter(text);
  const metadata = parsed ? module.metadata.safeParse(parsed.metadata) : undefined;
  if (!metadata?.success || module.key(metadata.data) !== id) return undefined;
  const row: Record<string, IndexValue> = { ...metadata.data };
  for (const [name, keys] of Object.entries(module.indexes)) {
    const attributes = indexAttributes(name);
    row[attributes.partition] = keys.partition(metadata.data);
    row[attributes.sort] = keys.sort(metadata.data);
  }
  return { ...row, item_id: id, source_key: key, source_etag: etag, indexed_at: indexedAt };
}

/**
 * Re-reads the current note and replaces its row. Events only say which key to
 * look at, so duplicate, late or reordered events converge on the same state.
 */
export async function indexKey(deps: ApplyDependencies, key: string): Promise<IndexOutcome> {
  if (!key.startsWith(deps.prefix)) return 'ignored';
  const resolved = resolveIndexedKey(key.slice(deps.prefix.length));
  if (!resolved) return 'ignored';
  const { module, id } = resolved;
  const current = await deps.source.get(key);
  if (current === undefined) {
    await deps.rows.remove(module, id);
    deps.log({ event: 'removed', module: module.id, id });
    return 'removed';
  }
  const row = current === 'too_large' ? undefined : buildRow(module, id, key, current.etag, current.text, deps.now().toISOString());
  if (!row) {
    // An invalid note must not leave its previous row behind as if it were current.
    await deps.rows.remove(module, id);
    deps.log({ event: 'invalid_source', module: module.id, id, reason: current === 'too_large' ? 'too_large' : 'invalid_metadata' });
    return 'invalid_source';
  }
  await deps.rows.put(module, row);
  deps.log({ event: 'indexed', module: module.id, id });
  return 'indexed';
}

/**
 * Compares every source ETag with its row and queues each difference, including
 * rows whose note is gone. A rebuild queues every key. Reconcile never writes
 * rows itself: the FIFO consumer stays the only writer.
 */
export async function reconcile(deps: ReconcileDependencies, rebuild = false) {
  const summary = [];
  for (const module of indexedModules) {
    const prefix = deps.prefix + module.sourcePrefix;
    const sources = new Map<string, SourceObject>();
    let cursor: string | undefined;
    do {
      const page = await deps.sources.list(prefix, cursor);
      for (const object of page.objects) {
        const id = module.matches(object.key.slice(prefix.length));
        if (object.key.startsWith(prefix) && id !== undefined) sources.set(id, object);
      }
      cursor = page.next;
    } while (cursor);
    const rows = new Map<string, { key: string; etag: string }>();
    cursor = undefined;
    do {
      const page = await deps.index.scan(module, cursor);
      for (const row of page.rows) rows.set(row.id, row);
      cursor = page.next;
    } while (cursor);
    const changed = [...sources].filter(([id, object]) => rebuild || rows.get(id)?.etag !== object.etag).map(([, object]) => object.key);
    const orphaned = [...rows].filter(([id]) => !sources.has(id)).map(([, row]) => row.key);
    for (let index = 0; index < changed.length + orphaned.length; index += 10) {
      await deps.queue.send([...changed, ...orphaned].slice(index, index + 10));
    }
    const result = { module: module.id, sources: sources.size, rows: rows.size, queued: changed.length + orphaned.length, orphaned: orphaned.length };
    deps.log({ event: rebuild ? 'rebuild' : 'reconcile', ...result });
    summary.push(result);
  }
  return summary;
}

const s3Event = z.object({ source: z.literal('aws.s3'), detail: z.object({ bucket: z.object({ name: z.string() }), object: z.object({ key: z.string().min(1).max(1024) }) }) });
const queuedKey = z.strictObject({ key: z.string().min(1).max(1024), requested_at: z.string() });
const sqsEvent = z.object({ Records: z.array(z.object({ messageId: z.string(), body: z.string() })).min(1) });
/** The daily schedule sends `reconcile`; an operator invokes `rebuild` to requeue every note. */
const invocation = z.strictObject({ action: z.enum(['reconcile', 'rebuild']) });

/** The key a queued message asks about, or undefined for another bucket. */
export function messageKey(body: string, bucket: string) {
  const value: unknown = JSON.parse(body);
  const event = s3Event.safeParse(value);
  if (event.success) return event.data.detail.bucket.name === bucket ? event.data.detail.object.key : undefined;
  return queuedKey.parse(value).key;
}

/** Entry point for both the FIFO consumer and scheduled or manual reconcile. */
export async function handleIndexerEvent(deps: IndexerDependencies, event: unknown) {
  const batch = sqsEvent.safeParse(event);
  if (!batch.success) {
    const request = invocation.parse(event);
    return { reconciled: await reconcile(deps, request.action === 'rebuild') };
  }
  const records = batch.data.Records;
  for (const [index, record] of records.entries()) {
    try {
      const key = messageKey(record.body, deps.bucket);
      if (key !== undefined) await indexKey(deps, key);
    } catch (error) {
      deps.log({ event: 'index_failed', message_id: record.messageId, error: error instanceof Error ? error.name : 'unknown' });
      // FIFO order: retry this message and everything after it in the batch.
      return { batchItemFailures: records.slice(index).map(failed => ({ itemIdentifier: failed.messageId })) };
    }
  }
  return { batchItemFailures: [] };
}
