import { z } from 'zod';
import { writeScope } from './auth.js';
import type { Settings } from './config.js';
import { OperationError } from './errors.js';
import { Journal, journalWriteInput } from './journal.js';
import { writeToolSecurity, type McpSkill } from './skill.js';

const output = z.object({ path: z.string(), mode: z.enum(['append', 'overwrite']), totalBytes: z.number(), created: z.boolean().optional() });

export function journalSkill(settings: Settings): McpSkill {
  const scope = writeScope(settings);
  return {
    instructions: 'Use journal_write only when the user asks to save to their Obsidian Journal folder. Prefer append. Before overwrite, read the whole current note with read_note, following every cursor, then send the complete new content, keeping text the user did not ask to change.',
    scopes: [scope],
    register: ({ server, store, writer, signal, result, authorizeScope }) => {
      const journal = writer && new Journal(store, writer, settings);
      server.registerTool('journal_write', {
        description: 'Write one Markdown note inside Journal/ (subfolders allowed), creating it if absent. append adds content to the end of the note. overwrite replaces the entire note: read it first with read_note and send the complete content. No other vault paths.',
        ...writeToolSecurity(settings),
        inputSchema: journalWriteInput, outputSchema: output,
      }, input => result(async () => {
        await authorizeScope(scope);
        if (!journal) throw new OperationError('journal_writes_disabled');
        return journal.write(input, signal);
      }));
    },
  };
}
