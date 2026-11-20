import type { NoteReader, NoteWriter } from './note-store.js';
import { keyFor, NoteError, validPath } from './paths.js';
import { parseFrontmatter } from './frontmatter.js';
import { PracticeError } from './errors.js';

export function parsePracticeNote(value: string) {
  const parsed = parseFrontmatter(value);
  if (!parsed) throw new PracticeError('invalid_practice_note');
  return parsed;
}

const PRACTICE_NOTE_BYTES = 64 * 1024;

export class PracticeNotes {
  constructor(
    private readonly reader: NoteReader,
    private readonly prefix: string,
    private readonly signal: AbortSignal,
    private readonly writer?: NoteWriter,
  ) {}

  async read(path: string) {
    const value = await this.reader.read(keyFor(this.prefix, validPath(path)), 0, PRACTICE_NOTE_BYTES, undefined, this.signal);
    if (value.total > value.bytes.length) throw new PracticeError('practice_note_too_large');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes); }
    catch { throw new NoteError('invalid_utf8'); }
    return { text, revision: value.etag };
  }

  async put(path: string, value: string, revision?: string) {
    if (!this.writer) throw new PracticeError('practice_writes_disabled');
    if (Buffer.byteLength(value) > PRACTICE_NOTE_BYTES) throw new PracticeError('practice_note_too_large');
    return this.writer.put(keyFor(this.prefix, validPath(path)), value, revision ? { revision } : 'absent', this.signal);
  }
}
