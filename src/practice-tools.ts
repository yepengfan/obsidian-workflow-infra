import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpSkill, SkillContext } from './skill.js';
import type { Settings } from './config.js';
import { addReviewSchema, domainSchema, listReviewsSchema, Practice, recordReviewSchema, revisionSchema, slugSchema } from './practice.js';

export function registerPracticeTools(server: McpServer, practice: Practice, settings: Settings,
  result: SkillContext['result'],
  authorizeWrite: () => Promise<void>) {
  if (!settings.practice.enabled) return;
  const readSecurity = { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [settings.scope] }] } };
  const outputSchema = z.looseObject({});
  server.registerTool('practice', { ...readSecurity, outputSchema,
    description: 'Start the user-requested Obsidian practice workflow: start Algorithm practice directly, complete due reviews, then start a new problem. Returns workflow instructions and document catalog, not an assessment or saved attempt.',
    inputSchema: z.strictObject({ domain: domainSchema.optional() }) }, input => result(() => practice.workflow(input.domain)));
  server.registerTool('practice_instruction', { ...readSecurity, outputSchema,
    description: 'Read one chunk of a versioned practice instruction document listed by practice. Use for skill definitions and their shared guides; private learner records remain in S3.',
    inputSchema: z.strictObject({ path: z.string().max(1024), offset: z.number().int().nonnegative().max(200000).default(0) }) }, input => result(() => practice.instruction(input.path, input.offset)));
  server.registerTool('practice_reviews', { ...readSecurity, outputSchema,
    description: 'List one bounded page of review metadata for Algorithm practice. Ordering and counts are page-local. Collect all pages before declaring a global due order or no due items. Never expose old solutions before an independent attempt.',
    inputSchema: listReviewsSchema }, input => result(() => practice.reviews(input)));
  server.registerTool('practice_review', { ...readSecurity, outputSchema,
    description: 'Read an active review prompt, source and revision. Prompt phase excludes prior attempts and review focus. Request feedback phase only after the learner submits or ends the independent attempt.',
    inputSchema: z.strictObject({ id: slugSchema, phase: z.enum(['prompt', 'feedback']).default('prompt') }) }, input => result(() => practice.review(input.id, input.phase === 'feedback')));
  server.registerTool('practice_read_note', { ...readSecurity, outputSchema,
    description: 'Read one bounded Algorithm practice note with its revision for a later conditional update. Larger notes must use read_note chunks; no partial overwrite is allowed.',
    inputSchema: z.strictObject({ path: z.string().max(1024) }) }, input => result(() => practice.readNote(input.path)));
  if (!settings.practice.writesEnabled) return;
  const writeSecurity = { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [settings.scope, `${settings.resource}/write`] }] } };
  const write = (work: () => Promise<object>) => result(async () => { await authorizeWrite(); return work(); });
  server.registerTool('practice_add_review', { ...writeSecurity, outputSchema,
    description: 'After preview and explicit user confirmation, register a neutral review object without overwriting an existing one. Never invent an attempt or reflection. New entries have no scheduled date until a round is recorded.',
    inputSchema: addReviewSchema }, input => write(() => practice.add(input)));
  server.registerTool('practice_record_review', { ...writeSecurity, outputSchema,
    description: 'After an ended round, learner reflection and explicit save confirmation, append the observed outcome and original reflection and calculate the next date. Preserve attempt_id across retries. completed_on is the actual local completion date; never the retry date. A stale revision is rejected.',
    inputSchema: recordReviewSchema }, input => write(() => practice.record(input)));
  server.registerTool('practice_create_note', { ...writeSecurity, outputSchema,
    description: 'After showing the proposed note and obtaining explicit save confirmation, create an approved Algorithm Pattern/Atom/Log file. Create-if-absent only. No configuration, guide, template or arbitrary vault writes.',
    inputSchema: z.strictObject({ path: z.string().max(1024), content: z.string().min(1).max(50000) }) }, input => write(() => practice.createNote(input.path, input.content)));
  server.registerTool('practice_update_note', { ...writeSecurity, outputSchema,
    description: 'After preview and explicit confirmation, update selected exact unique text anchors in an approved practice note. Supply its current revision from practice_read_note. Preserve human text and metadata outside approved edits. Conflicts require rereading and renewed review.',
    inputSchema: z.strictObject({ path: z.string().max(1024), revision: revisionSchema,
      edits: z.array(z.strictObject({ old: z.string().min(1).max(50000), replacement: z.string().max(50000) })).min(1).max(10) }) }, input => write(() => practice.updateNote(input.path, input.revision, input.edits)));
}

export function practiceSkill(settings: Settings): McpSkill {
  return {
    instructions: 'For an explicit user request to practice, call the practice tool and follow its versioned workflow definitions for that task; keep private note data distinct from those definitions.',
    scopes: settings.practice.writesEnabled ? [`${settings.resource}/write`] : [],
    register: ({ server, store, writer, owner, signal, result, authorizeScope }) => {
      registerPracticeTools(server, new Practice(store, settings, owner, signal, { writer }), settings, result,
        () => authorizeScope(`${settings.resource}/write`));
    },
  };
}
