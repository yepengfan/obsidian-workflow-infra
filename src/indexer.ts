import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';
import { indexedModules, resolveIndexedKey } from './index-modules/index.js';
import { indexAttributes, type IndexedModule, type IndexRow, type IndexValue } from './index-modules/types.js';

export const INDEX_MESSAGE_GROUP = 'index';

export const MAX_SOURCE_BYTES = 256 * 1024;

export interface SourceObject {
  key: string;
  etag: string;
}

export interface SourceReader {
  get(key: string): Promise<{ text: string; etag: string } | undefined | 'too_large'>;
}

export interface SourceCatalog {
  list(prefix: string, cursor?: string): Promise<{ objects: SourceObject[]; next?: string }>;
}

export interface IndexWriter {
  put(module: IndexedModule<IndexRow>, item: Record<string, IndexValue>): Promise<void>;
  remove(module: IndexedModule<IndexRow>, id: string): Promise<void>;
}

export interface IndexCatalog {
  scan(module: IndexedModule<IndexRow>, cursor?: string): Promise<{
    rows: (SourceObject & { id: string })[];
    next?: string;
  }>;
}

export interface IndexQueue {
  send(keys: string[]): Promise<void>;
}

type Log = (record: Record<string, unknown>) => void;

export interface ApplyDependencies {
  prefix: string;
  source: SourceReader;
  rows: IndexWriter;
  now(): Date;
  log: Log;
}

export interface ReconcileDependencies {
  prefix: string;
  sources: SourceCatalog;
  index: IndexCatalog;
  queue: IndexQueue;
  log: Log;
}

export type IndexerDependencies = ApplyDependencies & ReconcileDependencies & { bucket: string };

export type IndexOutcome = 'indexed' | 'removed' | 'invalid_source' | 'ignored';

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
    await deps.rows.remove(module, id);
    deps.log({ event: 'invalid_source', module: module.id, id, reason: current === 'too_large' ? 'too_large' : 'invalid_metadata' });
    return 'invalid_source';
  }
  await deps.rows.put(module, row);
  deps.log({ event: 'indexed', module: module.id, id });
  return 'indexed';
}

async function listModuleSources(catalog: SourceCatalog, module: IndexedModule<IndexRow>, prefix: string) {
  const sources = new Map<string, SourceObject>();
  let cursor: string | undefined;
  do {
    const page = await catalog.list(prefix, cursor);
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix)) continue;
      const id = module.matches(object.key.slice(prefix.length));
      if (id !== undefined) sources.set(id, object);
    }
    cursor = page.next;
  } while (cursor);
  return sources;
}

async function scanModuleRows(catalog: IndexCatalog, module: IndexedModule<IndexRow>) {
  const rows = new Map<string, SourceObject>();
  let cursor: string | undefined;
  do {
    const page = await catalog.scan(module, cursor);
    for (const row of page.rows) rows.set(row.id, row);
    cursor = page.next;
  } while (cursor);
  return rows;
}

export async function reconcile(deps: ReconcileDependencies, rebuild = false) {
  const summary = [];
  for (const module of indexedModules) {
    const sources = await listModuleSources(deps.sources, module, deps.prefix + module.sourcePrefix);
    const rows = await scanModuleRows(deps.index, module);
    const changed = [...sources]
      .filter(([id, source]) => rebuild || rows.get(id)?.etag !== source.etag)
      .map(([, source]) => source.key);
    const orphaned = [...rows].filter(([id]) => !sources.has(id)).map(([, row]) => row.key);
    const keys = [...changed, ...orphaned];
    if (keys.length) await deps.queue.send(keys);
    const result = { module: module.id, sources: sources.size, rows: rows.size, queued: keys.length, orphaned: orphaned.length };
    deps.log({ event: rebuild ? 'rebuild' : 'reconcile', ...result });
    summary.push(result);
  }
  return summary;
}

const s3Event = z.object({ source: z.literal('aws.s3'), detail: z.object({ bucket: z.object({ name: z.string() }), object: z.object({ key: z.string().min(1).max(1024) }) }) });
const queuedKey = z.strictObject({ key: z.string().min(1).max(1024), requested_at: z.string() });
const sqsEvent = z.object({ Records: z.array(z.object({ messageId: z.string(), body: z.string() })).min(1) });
const invocation = z.strictObject({ action: z.enum(['reconcile', 'rebuild']) });

export function messageKey(body: string, bucket: string) {
  const value: unknown = JSON.parse(body);
  const event = s3Event.safeParse(value);
  if (event.success) return event.data.detail.bucket.name === bucket ? event.data.detail.object.key : undefined;
  return queuedKey.parse(value).key;
}

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
