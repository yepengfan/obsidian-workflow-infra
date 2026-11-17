import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Settings } from './config.js';
import { decodeCursor, encodeCursor, keyFor, NoteError, validPath } from './paths.js';

export const METADATA_WORKGROUP = 'obsidian-mcp-metadata';
export const METADATA_CATALOG = 's3tablescatalog/aws-s3';
export const metadataInput = z.strictObject({
  query: z.string().max(200).default('').describe('Case-insensitive literal text in the vault-relative Markdown path. Empty means any path.'),
  folder: z.string().max(1024).default('').describe('Explicit relative folder, including descendants. Empty means the configured vault.'),
  modifiedAfter: z.iso.datetime({ offset: true }).optional(),
  modifiedBefore: z.iso.datetime({ offset: true }).optional(),
  minSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  maxSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(8192).optional(),
}).refine(v => v.minSize === undefined || v.maxSize === undefined || v.minSize <= v.maxSize, 'Invalid size range')
  .refine(v => !v.modifiedAfter || !v.modifiedBefore || Date.parse(v.modifiedAfter) <= Date.parse(v.modifiedBefore), 'Invalid date range');
export type MetadataInput = z.infer<typeof metadataInput>;
export interface MetadataRow { key: string; size: number; modified: string }
export interface MetadataQuery {
  run(sql: string, limit: number, queryId: string | undefined, signal: AbortSignal): Promise<
    { state: 'pending'; queryId: string } | { state: 'complete'; rows: MetadataRow[]; scannedBytes: number }
  >;
}
const searchCursor = z.strictObject({ v: z.literal(1), context: z.string(), after: z.string().max(1024).optional(), queryId: z.string().uuid().optional() });
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const timestamp = (value: string) => `TIMESTAMP ${literal(new Date(value).toISOString().replace('T', ' ').replace('Z', ''))}`;

/** Application paths and cursor ownership stay outside the Athena adapter. */
export class MetadataSearch {
  constructor(private readonly query: MetadataQuery, private readonly settings: Pick<Settings, 'bucket' | 'prefix'>) {}

  async search(raw: MetadataInput, owner: string, signal: AbortSignal) {
    const input = metadataInput.parse(raw);
    const folder = validPath(input.folder, true);
    const prefix = keyFor(this.settings.prefix, folder);
    const { cursor, ...filters } = input;
    const context = createHash('sha256').update(JSON.stringify([this.settings.bucket, this.settings.prefix, owner, { ...filters, folder }])).digest('hex');
    const checkpoint = cursor ? decodeCursor(cursor, searchCursor) : undefined;
    if (checkpoint && (checkpoint.context !== context || (!checkpoint.after && !checkpoint.queryId))) throw new NoteError('invalid_cursor');
    if (checkpoint?.after && (!checkpoint.after.startsWith(prefix) || validPath(checkpoint.after.slice(this.settings.prefix.length)) === '')) throw new NoteError('invalid_cursor');
    // Rank versions BEFORE applying size/date/delete filters: an older matching
    // version must not resurrect a changed or deleted current note.
    const conditions = ["version_rank = 1", 'NOT COALESCE(is_delete_marker, FALSE)', 'size IS NOT NULL', 'last_modified_date IS NOT NULL', "ends_with(lower(key), '.md')",
      `strpos(lower(substr(key, ${Array.from(this.settings.prefix).length + 1})), lower(${literal(input.query)})) > 0`];
    if (input.minSize !== undefined) conditions.push(`size >= ${input.minSize}`);
    if (input.maxSize !== undefined) conditions.push(`size <= ${input.maxSize}`);
    if (input.modifiedAfter) conditions.push(`last_modified_date >= ${timestamp(input.modifiedAfter)}`);
    if (input.modifiedBefore) conditions.push(`last_modified_date <= ${timestamp(input.modifiedBefore)}`);
    if (checkpoint?.after) conditions.push(`key > ${literal(checkpoint.after)}`);
    const database = `b_${this.settings.bucket}`.replaceAll('"', '""');
    const sql = `-- MCP metadata ${context}\nWITH current_objects AS (
  SELECT key, size, last_modified_date, is_delete_marker,
    ROW_NUMBER() OVER (PARTITION BY key ORDER BY sequence_number DESC) AS version_rank
  FROM "${METADATA_CATALOG}"."${database}"."inventory"
  WHERE bucket = ${literal(this.settings.bucket)} AND starts_with(key, ${literal(prefix)})
)
SELECT key, CAST(size AS varchar), to_iso8601(last_modified_date)
FROM current_objects WHERE ${conditions.join(' AND ')}
ORDER BY key ASC LIMIT ${input.limit + 1}`;
    const result = await this.query.run(sql, input.limit + 1, checkpoint?.queryId, signal);
    const common = { folder, scope: 'descendants' as const, source: 's3_metadata_inventory' as const,
      freshness: 'Inventory updates typically appear within one hour; this is not a maximum guarantee. Reads fetch the current S3 object.' };
    if (result.state === 'pending') return { ...common, state: 'pending' as const, notes: [], complete: false,
      nextCursor: encodeCursor({ v: 1, context, after: checkpoint?.after, queryId: result.queryId }) };
    if (result.rows.length > input.limit + 1) throw new NoteError('note_unavailable');
    // Treat adapter output as untrusted. Never return another prefix or an
    // unreadable path, and never silently drop a malformed row from a page.
    let previous = checkpoint?.after;
    for (const row of result.rows) {
      if (!row.key.startsWith(prefix) || (previous !== undefined && Buffer.compare(Buffer.from(row.key), Buffer.from(previous)) <= 0) ||
        !Number.isSafeInteger(row.size) || row.size < 0 || !Number.isFinite(Date.parse(row.modified))) throw new NoteError('note_unavailable');
      validPath(row.key.slice(this.settings.prefix.length));
      previous = row.key;
    }
    const page = result.rows.slice(0, input.limit);
    const more = result.rows.length > input.limit;
    return { ...common, state: 'complete' as const, notes: page.map(row => ({ path: row.key.slice(this.settings.prefix.length), size: row.size, modified: row.modified })),
      complete: !more, scannedBytes: result.scannedBytes,
      ...(more ? { nextCursor: encodeCursor({ v: 1, context, after: page.at(-1)!.key }) } : {}) };
  }
}
