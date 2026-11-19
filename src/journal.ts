import { z } from 'zod';
import type { Settings } from './config.js';
import { OperationError } from './errors.js';
import type { NoteStore, NoteWriter } from './note-store.js';
import { keyFor, NoteError, validPath } from './paths.js';

export const JOURNAL_ROOT = 'Journal/';
/** Object patterns relative to the note prefix, shared with IAM synthesis. IAM `*` also spans subfolders. */
export const journalWriteResources = [`${JOURNAL_ROOT}*.md`];
/** Upper bound for a whole Journal note read back for append and for the saved result. */
export const JOURNAL_NOTE_BYTES = 1048576;

export const journalWriteInput = z.strictObject({
  path: z.string().min(1).max(1024).describe('Markdown path inside Journal/, for example Journal/2026-11-19.md. Created if absent.'),
  mode: z.enum(['append', 'overwrite']).describe('append adds content to the end of the note; overwrite replaces the entire note.'),
  content: z.string().min(1).max(50000),
});
export type JournalWriteInput = z.infer<typeof journalWriteInput>;

export function journalPath(path: string): string {
  const valid = validPath(path);
  if (!valid.startsWith(JOURNAL_ROOT)) throw new NoteError('invalid_path');
  return valid;
}

/** Journal write rules. Storage is reached only through the injected ports. */
export class Journal {
  constructor(private readonly store: NoteStore, private readonly writer: NoteWriter, private readonly settings: Pick<Settings, 'prefix'>) {}

  async write(input: JournalWriteInput, signal: AbortSignal) {
    const path = journalPath(input.path);
    const key = keyFor(this.settings.prefix, path);
    if (input.mode === 'overwrite') {
      // The caller reads the note first and sends the complete replacement.
      await this.writer.put(key, input.content, 'any', signal);
      return { path, mode: input.mode, totalBytes: Buffer.byteLength(input.content) };
    }
    let current;
    try { current = await this.store.read(key, 0, JOURNAL_NOTE_BYTES, undefined, signal); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'note_unavailable') throw error;
      // S3 can report a missing key as access denied because the runtime's
      // listing grant is condition-scoped, so create-if-absent decides instead.
      try { await this.writer.put(key, input.content, 'absent', signal); }
      catch (created) { throw created instanceof NoteError && created.code === 'revision_conflict' ? error : created; }
      return { path, mode: input.mode, created: true, totalBytes: Buffer.byteLength(input.content) };
    }
    if (current.total > current.bytes.length) throw new OperationError('journal_note_too_large');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(current.bytes); }
    catch { throw new NoteError('invalid_utf8'); }
    const next = text + (text === '' || text.endsWith('\n') ? '' : '\n') + input.content;
    if (Buffer.byteLength(next) > JOURNAL_NOTE_BYTES) throw new OperationError('journal_note_too_large');
    // Pin the write to the revision just read so a concurrent sync is never overwritten by an append.
    await this.writer.put(key, next, { revision: current.etag }, signal);
    return { path, mode: input.mode, created: false, totalBytes: Buffer.byteLength(next) };
  }
}
