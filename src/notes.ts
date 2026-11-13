import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Settings } from './config.js';
import type { NoteStore } from './s3.js';
import { catalogCursorSchema, decodeCursor, encodeCursor, keyFor, NoteError, readCursorSchema, validPath } from './paths.js';

const cursor = z.string().min(1).max(8192).optional();
const folder = z.string().max(1024).describe('One explicit relative folder; empty string means direct children of root.');
const path = z.string().min(1).max(1024).describe('Exact relative Markdown path selected from the catalog.');
export const listInput = z.strictObject({ folder, limit: z.number().int().min(1).max(100).optional(), cursor });
export const searchInput = z.strictObject({
  mode: z.enum(['filename', 'body']), query: z.string().min(1).max(200),
  folder: folder.optional(), paths: z.array(path).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor,
}).superRefine((input, ctx) => {
  if (input.mode === 'body' ? !input.paths || input.folder !== undefined || input.limit !== undefined || input.cursor !== undefined : input.folder === undefined || input.paths !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Filename mode requires one folder; body mode requires explicit selected paths only.' });
  }
});
export const readInput = z.strictObject({ path, cursor });
const context = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export class Notes {
  constructor(private readonly store: NoteStore, private readonly settings: Settings, private readonly owner: string, private readonly signal: AbortSignal) {}
  async list(input: z.infer<typeof listInput>, query?: string) {
    const folder = validPath(input.folder, true);
    const limit = Math.min(input.limit ?? this.settings.limits.pageSize, this.settings.limits.pageSize);
    const prefix = keyFor(this.settings.prefix, folder);
    const binding = context([this.settings.bucket, prefix, this.owner, limit, query ?? null]);
    const decoded = input.cursor ? decodeCursor(input.cursor, catalogCursorSchema) : undefined;
    if (decoded && decoded.context !== binding) throw new NoteError('invalid_cursor');
    const page = await this.store.list(prefix, limit, decoded?.token, this.signal);
    if (page.folders.length + page.notes.length > limit) throw new NoteError('note_unavailable');
    const child = (key: string, isFolder: boolean) => {
      if (!key.startsWith(prefix)) throw new NoteError('note_unavailable');
      const suffix = key.slice(prefix.length);
      if (!suffix || suffix.replace(/\/$/u, '').includes('/')) throw new NoteError('note_unavailable');
      return validPath(key.slice(this.settings.prefix.length), isFolder);
    };
    const folders = page.folders.map(key => ({ path: child(key, true) }));
    const notes = page.notes.filter(note => /\.md$/iu.test(note.key)).map(note => ({ path: child(note.key, false), size: note.size, modified: note.modified }));
    return { folder, folders: query === undefined ? folders : [], notes: query === undefined ? notes : notes.filter(note => note.path.slice(folder.length).toLocaleLowerCase('en').includes(query.toLocaleLowerCase('en'))),
      scope: 'direct_children' as const, complete: !page.next,
      ...(page.next ? { nextCursor: encodeCursor({ v: 1, context: binding, token: page.next }) } : {}) };
  }
  async read(input: z.infer<typeof readInput>) {
    const path = validPath(input.path);
    const key = keyFor(this.settings.prefix, path);
    const binding = context([this.settings.bucket, key, this.owner]);
    const decoded = input.cursor ? decodeCursor(input.cursor, readCursorSchema) : undefined;
    if (decoded && decoded.context !== binding) throw new NoteError('invalid_cursor');
    const offset = decoded?.offset ?? 0;
    const data = await this.store.read(key, offset, this.settings.limits.readChunkBytes, decoded?.etag, this.signal);
    if (decoded && data.etag !== decoded.etag) throw new NoteError('note_unavailable');
    const end = offset + data.bytes.length >= data.total;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.bytes, { stream: !end }); }
    catch { throw new NoteError('invalid_utf8'); }
    const next = offset + Buffer.byteLength(text);
    if (!end && next <= offset) throw new NoteError('note_unavailable');
    return { path, text, offset, totalBytes: data.total, complete: end,
      ...(!end ? { nextCursor: encodeCursor({ v: 1, context: binding, etag: data.etag, offset: next }) } : {}) };
  }
  async search(input: z.infer<typeof searchInput>) {
    if (input.mode === 'filename') return this.list({ ...input, folder: input.folder! }, input.query);
    if (!input.paths || input.paths.length > this.settings.limits.selectedNotes || new Set(input.paths).size !== input.paths.length) throw new NoteError('invalid_path');
    // Validate the entire explicit selection before any S3 request.
    const selected = input.paths.map(path => ({ path: validPath(path), key: keyFor(this.settings.prefix, path) }));
    const results: { path: string; status: 'match' | 'no_match' | 'too_large' | 'unavailable'; snippet?: string }[] = new Array(selected.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(this.settings.limits.parallelReads, selected.length) }, async () => {
      while (index < selected.length) {
        const current = index++; const note = selected[current]!;
        try {
          this.signal.throwIfAborted();
          const data = await this.store.read(note.key, 0, this.settings.limits.searchBytesPerNote, undefined, this.signal);
          if (data.total > data.bytes.length) { results[current] = { path: note.path, status: 'too_large' }; continue; }
          const text = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes);
          const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
          const match = new RegExp(escaped, 'iu').exec(text);
          const snippetStart = Math.max(0, (match?.index ?? 0) - 80);
          results[current] = { path: note.path, status: match ? 'match' : 'no_match', ...(match ? { snippet: text.slice(snippetStart, snippetStart + 320) } : {}) };
        } catch { results[current] = { path: note.path, status: 'unavailable' }; }
      }
    });
    await Promise.all(workers);
    return { scope: 'selected_notes' as const, results, complete: results.every(result => result.status === 'match' || result.status === 'no_match') };
  }
}
