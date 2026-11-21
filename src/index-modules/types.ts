import type { z } from 'zod';

/** Scalar attributes a module may project into its DynamoDB index. */
export type IndexValue = string | number | boolean | null;
export type IndexRow = Record<string, IndexValue>;

/** One queryable secondary index: rows sharing a partition are ordered by sort. */
export interface IndexKeys<Row extends IndexRow> {
  partition(row: Row): string;
  sort(row: Row): string;
}

/**
 * Declares how one module's Markdown notes become rows in its own table.
 * The note stays the source of truth.
 */
export interface IndexedModule<Row extends IndexRow> {
  /** Stable module ID. It names the table, so it must not change once deployed. */
  readonly id: string;
  /** Folder relative to the configured note prefix, ending in `/`. */
  readonly sourcePrefix: string;
  /** Returns the item ID for an indexed note path under sourcePrefix, else undefined. */
  matches(relativeKey: string): string | undefined;
  /** Validates frontmatter and projects it to the stored row attributes. */
  readonly metadata: z.ZodType<Row>;
  /** The table partition key value. It must equal the ID matches() derived from the path. */
  key?(row: Row): string;
  readonly childNote?: string;
  detail?(body: string): IndexRow;
  /** GSI definitions by name. Attribute names are `<name>_pk` and `<name>_sk`. */
  readonly indexes: Readonly<Record<string, IndexKeys<Row>>>;
}

/** Bookkeeping attributes the indexer adds to every row. */
export const SOURCE_ATTRIBUTES = ['item_id', 'source_key', 'source_etag', 'indexed_at'] as const;

export const indexTableName = (moduleId: string) => `obsidian-mcp-index-${moduleId}`;
export const indexAttributes = (name: string) => ({ partition: `${name}_pk`, sort: `${name}_sk` });
