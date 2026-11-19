export interface CatalogPage { folders: string[]; notes: { key: string; size: number; modified?: string }[]; next?: string }
export interface NoteChunk { bytes: Uint8Array; total: number; etag: string }
export interface NoteStore {
  list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal): Promise<CatalogPage>;
  read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal): Promise<NoteChunk>;
}

/** Create only if absent, replace an exact revision, or replace whatever is current. */
export type WriteCondition = 'absent' | { revision: string } | 'any';
export interface NoteWriter {
  /** Rejects an unmet condition with `revision_conflict`. Returns the new revision. */
  put(key: string, text: string, condition: WriteCondition, signal: AbortSignal): Promise<string>;
}
