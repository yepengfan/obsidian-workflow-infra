import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeScope } from './auth.js';
import { readToolSecurity, writeToolSecurity, type McpSkill, type SkillContext } from './skill.js';
import type { Settings } from './config.js';
import { addReviewSchema, domainSchema, finishRoundSchema, listReviewsSchema, Practice, recordReviewSchema, revisionSchema, slugSchema } from './practice.js';
import { canvasToolMetadata, registerCanvasWidget } from './practice-canvas-widget.js';
import { designSessionSchema } from './design-session.js';
import type { ReviewIndex, SessionIndex } from './review-index.js';

export function registerPracticeTools(server: McpServer, practice: Practice, settings: Settings,
  result: SkillContext['result'],
  authorizeWrite: () => Promise<void>) {
  if (!settings.practice.enabled) return;
  const readSecurity = readToolSecurity(settings);
  const outputSchema = z.looseObject({});
  server.registerTool('practice', { ...readSecurity, outputSchema,
    description: 'Start practice. Omit domain for a combined due overview of enabled Algorithm and System Design modules, and saved unfinished sessions. Offer Finish registration for pending_finalizations, preserving the saved round date and ID. Offer to resume one match, or ask which session to resume when several match; wait for the learner. A sole confirmed enabled domain starts directly. Pass domain for an explicit domain request. Returns availability, workflow and instruction catalog; never an assessment or saved attempt.',
    inputSchema: z.strictObject({ domain: domainSchema.optional() }) }, input => result(() => practice.workflow(input.domain)));
  server.registerTool('practice_instruction', { ...readSecurity, outputSchema,
    description: 'Read one chunk of a versioned practice instruction document listed by practice. Use for skill definitions and their shared guides; private learner records remain in S3.',
    inputSchema: z.strictObject({ path: z.string().max(1024), offset: z.number().int().nonnegative().max(200000).default(0) }) }, input => result(() => practice.instruction(input.path, input.offset)));
  server.registerTool('practice_reviews', { ...readSecurity, outputSchema,
    description: 'List the complete review queue of one domain: overdue, today, unstarted and upcoming, each ordered by next review date then ID. Always supply domain explicitly, including each domain of a combined overview. Due and unstarted entries reflect the latest saved notes; a newly added review can take a few seconds to appear. Never expose old solutions before an independent attempt.',
    inputSchema: listReviewsSchema }, input => result(() => practice.reviews(input)));
  server.registerTool('practice_review', { ...readSecurity, outputSchema,
    description: 'Read an active review prompt, source and revision. Prompt phase excludes prior attempts and review focus. Request feedback phase only after the learner submits or ends the independent attempt.',
    inputSchema: z.strictObject({ id: slugSchema, phase: z.enum(['prompt', 'feedback']).default('prompt') }) }, input => result(() => practice.review(input.id, input.phase === 'feedback')));
  server.registerTool('practice_read_note', { ...readSecurity, outputSchema,
    description: 'Read one bounded Algorithm or System Design practice note with its revision for a later conditional update. Larger notes must use read_note chunks; no partial overwrite is allowed.',
    inputSchema: z.strictObject({ path: z.string().max(1024) }) }, input => result(() => practice.readNote(input.path)));
  registerCanvasWidget(server, settings.practice.writesEnabled);
  const canvasSecurity = { ...readSecurity, _meta: { ...readSecurity._meta, ...canvasToolMetadata } };
  server.registerTool('practice_design_template', { ...canvasSecurity, outputSchema,
    description: 'Draft a new System Design session: six-step progress.md, an uncompressed Excalidraw file and an interactive practice canvas. Use Review canvas to share edits before coaching. Does not save or check existing sessions. List the Solutions catalog first and resume a matching WIP/planned session. Confirm any save separately.',
    inputSchema: designSessionSchema }, input => result(() => practice.designTemplate(input)));
  server.registerTool('practice_design_canvas', { ...canvasSecurity, outputSchema,
    description: 'Read a selected saved System Design session canvas as native Excalidraw drawing data, including legacy compressed-json files. Select the exact path from the session catalog. Opens an interactive practice canvas with the saved elements and bindings. Does not save, assess, or read unsaved chat-widget edits; use Review canvas inside the editor for those. Never open prior solutions during an independent review.',
    inputSchema: z.strictObject({ path: z.string().max(1024) }) }, input => result(() => practice.designCanvas(input.path)));
  if (!settings.practice.writesEnabled) return;
  const writeSecurity = writeToolSecurity(settings);
  const write = (work: () => Promise<object>) => result(async () => { await authorizeWrite(); return work(); });
  const canvasPath = z.string().max(1024);
  server.registerTool('practice_recalculate_design_reviews', { ...writeSecurity, outputSchema,
    description: 'Persist completed-round scheduling for all indexed active System Design reviews at cutover. Preserves historical entries and dates. Replays final-round archive status. Conditional writes reject concurrent edits; retry safely after refreshing the index. First prove the migration on a temporary vault copy before authorizing the live migration.',
    inputSchema: z.strictObject({}) }, () => write(() => practice.recalculateDesignReviews()));
  server.registerTool('practice_stage_canvas', { ...writeSecurity, outputSchema,
    _meta: { ...writeSecurity._meta, ui: { visibility: ['app', 'model'] }, 'openai/widgetAccessible': true },
    description: 'Stage a complete reviewed Excalidraw scene for a later confirmed save. For an older canvas use this only if the exact full scene is available. Returns a snapshot receipt.',
    inputSchema: z.strictObject({ path: canvasPath, scene: z.record(z.string(), z.unknown()) }) },
  input => write(() => practice.stageCanvas(input.path, input.scene)));
  server.registerTool('practice_save_canvas', { ...writeSecurity, outputSchema,
    description: 'Save an authorized checkpoint and verify the drawing by read-back. Supply either the server snapshot receipt or the exact complete reviewed scene if staging was unavailable. Use null revision for a new file or the reviewed source revision for an update. For an explicitly requested overwrite read the current destination revision first.',
    inputSchema: z.strictObject({ path: canvasPath, snapshot: revisionSchema.optional(), scene: z.record(z.string(), z.unknown()).optional(), revision: revisionSchema.nullable() }) },
  input => write(() => practice.saveCanvas(input.path, input, input.revision)));
  server.registerTool('practice_finish_round', { ...writeSecurity, outputSchema,
    description: 'Shared closeout for every enrolled module. After reflection and save confirmation, submit the neutral topic and observed attempt together. System Design requires the matching session progress_path. For its first binding the saved session topic must match the review title. Retry using identical topic and round IDs. Returns verified schedule or archive status.',
    inputSchema: finishRoundSchema }, input => write(() => practice.finishRound(input)));
  server.registerTool('practice_add_review', { ...writeSecurity, outputSchema,
    description: 'After preview and explicit user confirmation, register a neutral review object without overwriting an existing one. Never invent an attempt or reflection. New entries have no scheduled date until a round is recorded.',
    inputSchema: addReviewSchema }, input => write(() => practice.add(input)));
  server.registerTool('practice_record_review', { ...writeSecurity, outputSchema,
    description: 'After an actually ended round, learner reflection and explicit save confirmation, append the observed outcome and original reflection and calculate the next date. Preserve attempt_id across retries. Paused or multi-day WIP checkpoints are not ended rounds; save progress with note tools. completed_on is the actual local completion date, never a checkpoint or later save date. A stale revision is rejected.',
    inputSchema: recordReviewSchema }, input => write(() => practice.record(input)));
  server.registerTool('practice_create_note', { ...writeSecurity, outputSchema,
    description: 'After preview and explicit save confirmation, create an approved Algorithm Pattern/Atom/Log or System Design Pattern/Insight/Log/session progress/canvas file. Create-if-absent only; files save independently. No configuration, guide, template or arbitrary vault writes.',
    inputSchema: z.strictObject({ path: z.string().max(1024), content: z.string().min(1).max(settings.limits.practiceEditCharacters) }) }, input => write(() => practice.createNote(input.path, input.content)));
  server.registerTool('practice_update_note', { ...writeSecurity, outputSchema,
    description: 'Update selected exact unique text anchors in an approved practice note. At a System Design step transition, automatically checkpoint the active round’s progress.md after verifying its canvas unless the learner opted out. All other updates require preview and explicit confirmation. Supply its current revision from practice_read_note. Preserve human text and metadata outside approved edits. Conflicts require rereading and renewed review.',
    inputSchema: z.strictObject({ path: z.string().max(1024), revision: revisionSchema,
      edits: z.array(z.strictObject({ old: z.string().min(1).max(settings.limits.practiceEditCharacters), replacement: z.string().max(settings.limits.practiceEditCharacters) })).min(1).max(10) }) }, input => write(() => practice.updateNote(input.path, input.revision, input.edits)));
}

export function practiceSkill(settings: Settings, index: ReviewIndex & SessionIndex): McpSkill {
  return {
    instructions: 'For an explicit user request to practice, call the practice tool and follow its versioned workflow definitions for that task; keep private note data distinct from those definitions. For System Design, open the selected Excalidraw canvas in chat before coaching and inspect its latest shared state before feedback. The canvas is the learner solution; chat explanations are supporting context. Follow the MCP canvas adaptations over upstream Mermaid instructions. Never claim to see unsaved widget edits without fresh host context.',
    scopes: settings.practice.writesEnabled ? [writeScope(settings)] : [],
    register: ({ server, store, writer, signal, result, authorizeScope }) => {
      const practice = new Practice(store, index, settings, signal, { writer });
      registerPracticeTools(server, practice, settings, result,
        () => authorizeScope(writeScope(settings)));
    },
  };
}
