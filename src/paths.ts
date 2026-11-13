import { z } from 'zod';

export class NoteError extends Error {
  constructor(readonly code: 'invalid_path' | 'invalid_cursor' | 'note_unavailable' | 'invalid_utf8' | 'result_too_large' | 'timeout') { super(code); }
}
export function validPath(path: string, folder = false): string {
  if (folder && path === '') return path;
  const bare = folder && path.endsWith('/') ? path.slice(0, -1) : path;
  if (!bare || path.startsWith('/') || (path.includes('\\') || [...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) ||
    bare.split('/').some(part => !part || part === '.' || part === '..') ||
    (!folder && (!/\.md$/iu.test(path) || path.endsWith('/'))) || Buffer.byteLength(path) > 1024) throw new NoteError('invalid_path');
  return folder ? bare + '/' : path;
}
export function keyFor(prefix: string, path: string): string {
  const key = prefix + path;
  if (Buffer.byteLength(key) > 1024) throw new NoteError('invalid_path');
  return key;
}
// Cursors are untrusted pagination input, not credentials or access grants.
export const catalogCursorSchema = z.strictObject({ v: z.literal(1), context: z.string(), token: z.string().min(1).max(4096) });
export const readCursorSchema = z.strictObject({ v: z.literal(1), context: z.string(), etag: z.string().min(1).max(256), offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw Error();
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch { throw new NoteError('invalid_cursor'); }
}
