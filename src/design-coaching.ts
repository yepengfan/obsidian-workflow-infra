import { z } from 'zod';
import { PracticeError } from './errors.js';
import type { NoteStore } from './note-store.js';
import { keyFor, NoteError } from './paths.js';
import { DESIGN_COACHING_LOG } from './practice-domains.js';
import type { PracticeNotes } from './practice-note.js';

export const coachingMode = z.enum(['guided', 'mock_interview']);
export const roundId = z.uuid();
const heading = '# System Design coaching rounds\n\n';
const initialRounds = 2;

export class DesignCoaching {
  constructor(
    private readonly catalog: Pick<NoteStore, 'list'>,
    private readonly notes: PracticeNotes,
    private readonly prefix: string,
    private readonly signal: AbortSignal,
    private readonly requireDomain: () => Promise<unknown>,
  ) {}

  private async progress(): Promise<{ ids: string[]; revision?: string }> {
    const key = keyFor(this.prefix, DESIGN_COACHING_LOG);
    const page = await this.catalog.list(key, 1, undefined, this.signal);
    if (page.notes[0]?.key !== key) return { ids: [] };

    const note = await this.notes.read(DESIGN_COACHING_LOG);
    const lines = note.text.slice(heading.length).trimEnd().split('\n');
    const ids = lines.map(line => line.slice(2).toLowerCase());
    if (!note.text.startsWith(heading) || lines.some(line => !line.startsWith('- ')) ||
      ids.some(id => !roundId.safeParse(id).success) || ids.length > initialRounds || new Set(ids).size !== ids.length) {
      throw new PracticeError('invalid_design_coaching_log');
    }
    return { ids, revision: note.revision };
  }

  async mode(override?: z.infer<typeof coachingMode>) {
    await this.requireDomain();
    const { ids } = await this.progress();
    const defaultMode = ids.length < initialRounds ? 'guided' : 'mock_interview';
    return { default_mode: defaultMode, mode: override ?? defaultMode, guided_rounds_remaining: initialRounds - ids.length };
  }

  async complete(id: string) {
    await this.requireDomain();
    const normalized = roundId.parse(id).toLowerCase();
    for (let attempt = 0; attempt <= initialRounds; attempt++) {
      this.signal.throwIfAborted();
      const { ids, revision } = await this.progress();
      if (ids.includes(normalized) || ids.length === initialRounds) return { added: false, guided_rounds_remaining: initialRounds - ids.length };
      try {
        const updated = heading + [...ids, normalized].map(value => `- ${value}\n`).join('');
        await this.notes.put(DESIGN_COACHING_LOG, updated, revision);
        return { added: true, guided_rounds_remaining: initialRounds - ids.length - 1 };
      } catch (error) {
        if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      }
    }
    throw new PracticeError('revision_conflict');
  }
}
