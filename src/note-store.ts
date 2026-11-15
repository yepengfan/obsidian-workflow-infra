export interface CatalogPage { folders: string[]; notes: { key: string; size: number; modified?: string }[]; next?: string }
export interface NoteChunk { bytes: Uint8Array; total: number; etag: string }
export interface NoteStore {
  list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal): Promise<CatalogPage>;
  read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal): Promise<NoteChunk>;
}

export interface NoteWriter {
  put(key: string, text: string, revision: string | undefined, signal: AbortSignal): Promise<string>;
}
