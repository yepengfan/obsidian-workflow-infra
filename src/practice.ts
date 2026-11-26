import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'yaml';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';
import { PracticeWorkflow } from './practice-workflow.js';
import { calendarDay, designHistory, designRound, nextSchedule } from './review-schedule.js';
import type { Settings } from './config.js';
import { NoteError } from './paths.js';
import type { NoteStore, NoteWriter } from './note-store.js';
import { PracticeError } from './errors.js';
import { CANVAS_REVIEW_PREFIX, DESIGN_PROFILE, type PracticeDomain, domainSchema, practiceDomains, practiceNoteDomain, validatePracticeWritePath } from './practice-domains.js';
import { designSessionTemplate, designSessionSchema } from './design-session.js';
import { conceptIdSchema, conceptObservationSchema, designOutline, parseObservations, renderProfile, upsertObservations, type StoredObservation } from './design-profile.js';
import { readDesignCanvas, parseScene, writeDesignCanvas } from './design-canvas.js';
import { dateSchema, REVIEW_ITEMS_PREFIX, reviewSummarySchema as summarySchema, slugSchema, type ReviewSummary } from './practice-schema.js';
import { parsePracticeNote, PracticeNotes } from './practice-note.js';
import type { IndexedReview, ReviewIndex, SessionIndex } from './review-index.js';

export { calendarDay, nextSchedule } from './review-schedule.js';
export { PracticeError } from './errors.js';
export { domainSchema, validatePracticeWritePath } from './practice-domains.js';
export { dateSchema, slugSchema } from './practice-schema.js';
export const revisionSchema = z.string().min(1).max(256);
const text = z.string().max(12000);
const requiredText = text.refine(value => value.trim().length > 0);
export const addReviewSchema = z.strictObject({ id: slugSchema, domain: domainSchema, title: requiredText.max(200), prompt: requiredText,
  source: text.optional(), review_focus: text.optional(), concept_ids: z.array(conceptIdSchema).max(50).optional() });
export const recordReviewSchema = z.strictObject({ id: slugSchema, revision: revisionSchema,
  attempt_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u).max(128),
  outcome: z.enum(['independent', 'assisted', 'incomplete']).optional(), reflection: requiredText,
  completed_on: dateSchema, submission: text.optional(), observations: text.optional(),
  concept_observations: z.array(conceptObservationSchema).max(20).optional() });
export const finishRoundSchema = z.strictObject({
  topic: addReviewSchema, attempt: recordReviewSchema.omit({ id: true, revision: true }),
  progress_path: z.string().max(1024).optional(),
});
export const listReviewsSchema = z.strictObject({ domain: domainSchema });
const itemSchema = summarySchema.extend({ prompt: requiredText, source: text.optional(), concept_ids: z.array(conceptIdSchema).max(50).default([]), attempt_ids: z.array(z.string()).max(5000).default([]) });
function serialize(metadata: Record<string, unknown>, body: string) { return `---\n${stringify(metadata)}---\n${body}`; }
function reviewQueue(rows: readonly ReviewSummary[], day: string) {
  const queue: Record<'overdue' | 'today' | 'unstarted' | 'upcoming', ReviewSummary[]> = { overdue: [], today: [], unstarted: [], upcoming: [] };
  const ordered = [...rows].sort((a, b) => (a.next_review ?? '').localeCompare(b.next_review ?? '') || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const entry = { ...row, ...(row.domain === 'system-design' ? designRound(row.completed_design_rounds ?? 0) : {}) };
    if (row.next_review === null) queue.unstarted.push(entry);
    else if (row.next_review < day) queue.overdue.push(entry);
    else if (row.next_review === day) queue.today.push(entry);
    else queue.upcoming.push(entry);
  }
  return queue;
}

type ScheduleConfig = Pick<Awaited<ReturnType<PracticeWorkflow['config']>>, 'interval_days' | 'retry_days' | 'archive_after_final'>;

export class Practice {
  private readonly notes: PracticeNotes;
  private readonly workflows: PracticeWorkflow;

  constructor(private readonly store: NoteStore, private readonly index: ReviewIndex & SessionIndex, private readonly settings: Pick<Settings, 'prefix' | 'practice' | 'limits'>,
    private readonly signal: AbortSignal, private readonly dependencies: { writer?: NoteWriter; now?: () => Date } = {}) {
    this.notes = new PracticeNotes(store, settings.prefix, signal, settings.limits.practiceNoteBytes, settings.practice.writesEnabled ? dependencies.writer : undefined);
    this.workflows = new PracticeWorkflow(settings.practice, path => this.read(path), dependencies.now ?? (() => new Date()), signal);
  }
  private today() { return calendarDay(this.settings.practice.timeZone, this.dependencies.now?.() ?? new Date()); }
  read(path: string) {
    return this.notes.read(path);
  }

  async workflow(domain?: PracticeDomain) {
    const workflow = await this.workflows.workflow(domain);
    if (!workflow.available_domains.some(item => item.domain === 'system-design')) return workflow;
    try {
      const [unfinished_sessions, pending_finalizations] = await Promise.all([this.index.unfinishedSessions(this.signal), this.index.pendingFinalizations(this.signal)]);
      return { ...workflow, unfinished_sessions, pending_finalizations };
    } catch {
      this.signal.throwIfAborted();
      return { ...workflow, unfinished_sessions: null, pending_finalizations: null };
    }
  }

  instruction(path: string, offset: number) {
    return this.workflows.instruction(path, offset);
  }

  private async item(id: string, forQueue = false, config?: ScheduleConfig) {
    const path = REVIEW_ITEMS_PREFIX + slugSchema.parse(id) + '.md';
    const note = await this.read(path);
    const parsed = parsePracticeNote(note.text);
    const item = itemSchema.parse(parsed.metadata);
    if (item.id !== id) throw new PracticeError('review_id_mismatch');
    if (!forQueue && !domainSchema.safeParse(item.domain).success) throw new PracticeError('unsupported_practice_domain');
    if (item.domain === 'system-design') {
      const schedule = config ?? await this.workflows.config('system-design');
      Object.assign(item, designHistory(item, parsed.body, schedule.interval_days, schedule.retry_days, schedule.archive_after_final));
    }
    return { ...note, ...parsed, item, path };
  }
  async reviews(input: z.infer<typeof listReviewsSchema>) {
    domainSchema.parse(input.domain);
    const config = await this.workflows.config(input.domain);
    const day = this.today();
    const rows = await this.currentReviews(await this.indexedReviews(input.domain), day, config);
    const queue = reviewQueue(rows.filter(row => row.domain === input.domain && row.status === 'active'), day);
    return { date: day, time_zone: this.settings.practice.timeZone, domain: input.domain, ...queue, complete: true };
  }
  private async indexedReviews(domain: PracticeDomain) {
    try { return await this.index.activeReviews(domain, this.signal); }
    catch {
      this.signal.throwIfAborted();
      throw new PracticeError('review_index_unavailable');
    }
  }
  private async currentReviews(indexed: IndexedReview[], day: string, config: ScheduleConfig) {
    const summary = (row: ReviewSummary): ReviewSummary => summarySchema.parse(row);
    const needsNote = (row: IndexedReview) => row.domain === 'system-design' || row.next_review === null || row.next_review <= day;
    const rows = indexed.filter(row => !needsNote(row)).map(summary);
    const unconfirmed = indexed.filter(needsNote);
    for (let index = 0; index < unconfirmed.length; index += 4) {
      rows.push(...await Promise.all(unconfirmed.slice(index, index + 4).map(async row => {
        const note = await this.item(row.id, true, config);
        return summary(note.item);
      })));
    }
    return rows;
  }
  async recalculateDesignReviews() {
    const config = await this.workflows.config('system-design');
    let updated = 0;
    for (const row of await this.indexedReviews('system-design')) {
      const note = await this.item(row.id, true, config);
      const normalized = designHistory(itemSchema.parse(note.metadata), note.body,
        config.interval_days, config.retry_days, config.archive_after_final);
      if (Object.entries(normalized).every(([key, value]) => isDeepStrictEqual(note.metadata[key], value))) continue;
      await this.notes.put(note.path, serialize({ ...note.metadata, ...normalized }, note.body), note.revision);
      updated++;
    }
    return { updated };
  }
  async review(id: string, includeHistory = false) {
    const note = await this.item(id);
    await this.workflows.config(domainSchema.parse(note.item.domain));
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    return { ...summarySchema.parse(note.item), ...(note.item.domain === 'system-design' ? designRound(note.item.completed_design_rounds!) : {}), prompt: note.item.prompt, concept_ids: note.item.concept_ids, source: note.item.source ?? null,
      revision: note.revision, ...(includeHistory ? { history: note.body } : {}) };
  }
  async add(input: z.infer<typeof addReviewSchema>) {
    domainSchema.parse(input.domain);
    await this.workflows.config(input.domain);
    const metadata = { id: input.id, domain: input.domain, title: input.title.trim(), status: 'active', prompt: input.prompt,
      concept_ids: input.concept_ids ?? [], review_count: 0, stage: 0, ...(input.domain === 'system-design' ? { completed_design_rounds: 0 } : {}), last_review: null, next_review: null, attempt_ids: [], ...(input.source ? { source: input.source } : {}) };
    const body = `# ${metadata.title.replace(/[\r\n]/gu, ' ')}\n\n${input.review_focus ? '## Review focus\n\n' + input.review_focus + '\n\n' : ''}## Practice history\n`;
    try { await this.notes.put(REVIEW_ITEMS_PREFIX + input.id + '.md', serialize(metadata, body)); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      const existing = await this.item(input.id);
      if (existing.item.domain !== input.domain || existing.item.title !== metadata.title) throw new PracticeError('review_id_conflict');
      return { ...summarySchema.parse(existing.item), concept_ids: existing.item.concept_ids, created: false, revision: existing.revision };
    }
    return { ...summarySchema.parse(metadata), concept_ids: metadata.concept_ids, created: true };
  }
  async record(input: z.infer<typeof recordReviewSchema>) {
    if (input.concept_observations?.length) throw new PracticeError('use_practice_finish_round_for_evidence');
    const note = await this.item(input.id);
    const config = await this.workflows.config(domainSchema.parse(note.item.domain));
    if (note.item.attempt_ids.includes(input.attempt_id)) return { ...summarySchema.parse(note.item), recorded: false };
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    if (input.completed_on > this.today()) throw new PracticeError('review_date_is_in_future');
    if (input.revision !== note.revision) throw new PracticeError('revision_conflict');
    const outcome = input.outcome ?? (note.item.domain === 'system-design' ? 'completed' : undefined);
    if (!outcome) throw new PracticeError('invalid_review_outcome');
    const schedule = nextSchedule(note.item, outcome, input.completed_on, config.interval_days, config.retry_days, config.archive_after_final);
    const metadata = { ...note.metadata, ...schedule, last_outcome: outcome, attempt_ids: [...note.item.attempt_ids, input.attempt_id] };
    let entry = `\n\n### ${input.completed_on} · Round ${schedule.review_count}\n\n**${outcome}** · ${schedule.status === 'archived' ? 'Archived' : `Next review ${schedule.next_review}`}\n\n#### My reflection\n\n${input.reflection}\n`;
    if (input.submission) entry += `\n#### Submission\n\n${input.submission}\n`;
    if (input.observations) entry += `\n#### Feedback\n\n${input.observations}\n`;
    await this.notes.put(note.path, serialize(metadata, note.body + entry), note.revision);
    return { ...summarySchema.parse(metadata), recorded: true };
  }
  async finishRound({ topic, attempt, progress_path }: z.infer<typeof finishRoundSchema>) {
    if (topic.domain !== 'system-design' && attempt.concept_observations?.length) throw new PracticeError('unsupported_practice_domain');
    if (attempt.completed_on > this.today()) throw new PracticeError('review_date_is_in_future');
    if (topic.domain === 'system-design' && !progress_path) throw new PracticeError('session_progress_required');
    if (progress_path) {
      if (topic.domain !== 'system-design' || validatePracticeWritePath(progress_path) !== topic.domain ||
        !progress_path.startsWith(practiceDomains['system-design'].root + 'Solutions/') || !progress_path.endsWith('/progress.md')) throw new NoteError('invalid_path');
      const note = await this.read(progress_path);
      const { metadata, body } = parsePracticeNote(note.text);
      const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
      if (metadata.review_item_id == null &&
        (typeof metadata.topic !== 'string' || metadata.topic.trim().toLowerCase() !== topic.title.trim().toLowerCase())) {
        throw new PracticeError('session_topic_mismatch');
      }
      const bound = metadata.round_id === attempt.attempt_id && metadata.review_item_id === topic.id;
      if ((!tags.includes('system-design/wip') && !(bound && tags.includes('system-design/done'))) ||
        (metadata.round_id && metadata.round_id !== attempt.attempt_id) ||
        (metadata.review_item_id != null && metadata.review_item_id !== topic.id) ||
        (metadata.round_completed_on && metadata.round_completed_on !== attempt.completed_on)) throw new PracticeError('session_round_mismatch');
      if (metadata.confirmed_registration && !isDeepStrictEqual(metadata.confirmed_registration, { topic, attempt })) throw new PracticeError('confirmed_registration_mismatch');
      await this.assessmentObservations({ progressPath: progress_path, completedOn: attempt.completed_on });
      if (tags.includes('system-design/wip') && !metadata.confirmed_registration) {
        await this.notes.put(progress_path, serialize({ ...metadata, round_id: attempt.attempt_id, review_item_id: topic.id,
          round_completed_on: attempt.completed_on, confirmed_registration: { topic, attempt } }, body), note.revision);
      }
    }
    await this.add(topic);
    let current = await this.item(topic.id);
    if (topic.domain === 'system-design' && !current.item.concept_ids.length && topic.concept_ids?.length) {
      await this.notes.put(current.path, serialize({ ...current.metadata, concept_ids: topic.concept_ids }, current.body), current.revision);
      current = await this.item(topic.id);
    }
    if (!current.item.attempt_ids.includes(attempt.attempt_id)) {
      const registration = { ...attempt };
      delete registration.concept_observations;
      await this.record({ ...registration, id: topic.id, revision: current.revision });
    }
    const verified = await this.item(topic.id);
    if (!verified.item.attempt_ids.includes(attempt.attempt_id) ||
      (verified.item.status === 'active' && !verified.item.next_review)) throw new PracticeError('registration_verification_failed');
    if (topic.domain === 'system-design' && progress_path) {
      await this.persistDesignProfile(progress_path, attempt.attempt_id, attempt.completed_on, attempt.concept_observations ?? []);
    }
    if (progress_path) {
      const note = await this.read(progress_path);
      const { metadata, body } = parsePracticeNote(note.text);
      if (metadata.round_id !== attempt.attempt_id || metadata.review_item_id !== topic.id ||
        metadata.round_completed_on !== attempt.completed_on) throw new PracticeError('session_round_mismatch');
      const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
      if (tags.includes('system-design/wip')) {
        delete metadata.confirmed_registration;
        await this.notes.put(progress_path, serialize({ ...metadata,
          tags: tags.map(tag => tag === 'system-design/wip' ? 'system-design/done' : tag) }, body), note.revision);
      } else if (!tags.includes('system-design/done')) throw new PracticeError('session_round_mismatch');
    }
    return { ...summarySchema.parse(verified.item), attempt_id: attempt.attempt_id, verified: true };
  }

  private async persistDesignProfile(progressPath: string, attemptId: string, date: string, observations: z.infer<typeof conceptObservationSchema>[]) {
    const note = await this.read(progressPath);
    const { metadata, body: assessment } = parsePracticeNote(note.text);
    const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
    if (tags.includes('system-design/done')) return;
    const prior = new Map(parseObservations(assessment, date).map(item => [item.observation_id, item]));
    const stored: StoredObservation[] = observations.map(item => {
      const observation = conceptObservationSchema.parse(item);
      const existing = prior.get(observation.observation_id);
      return { ...existing, ...observation, attempt_id: attemptId, date: observation.date ?? existing?.date ?? date };
    });
    const body = upsertObservations(assessment, stored, date);
    await this.notes.put(progressPath, serialize(metadata, body), note.revision);
    await this.rebuildDesignProfile();
  }

  private async assessmentObservations(session?: { progressPath: string; completedOn: string }) {
    const root = this.settings.prefix + practiceDomains['system-design'].root + 'Solutions/';
    const observations: StoredObservation[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(root, 100, cursor, this.signal);
      for (const folder of [...page.folders].sort()) {
        if (!folder.startsWith(root) || !/^[^/]+\/$/u.test(folder.slice(root.length))) throw new NoteError('invalid_path');
        let next: string | undefined;
        do {
          const children = await this.store.list(folder, 100, next, this.signal);
          if (children.notes.some(note => note.key === folder + 'progress.md')) {
            const progressPath = (folder + 'progress.md').slice(this.settings.prefix.length);
            const note = await this.read(progressPath);
            const parsed = parsePracticeNote(note.text);
            const completed = dateSchema.safeParse(progressPath === session?.progressPath ? session.completedOn : parsed.metadata.round_completed_on);
            const tags = Array.isArray(parsed.metadata.tags) ? parsed.metadata.tags : [parsed.metadata.tags];
            observations.push(...parseObservations(parsed.body, completed.success ? completed.data : undefined, {
              deferUndated: parsed.metadata.round_completed_on == null && tags.includes('system-design/wip'),
            }));
          }
          next = children.next;
        } while (next);
      }
      cursor = page.next;
    } while (cursor);
    return observations;
  }

  async rebuildDesignProfile() {
    await this.workflows.config('system-design');
    let revision: string | undefined;
    try { revision = (await this.read(DESIGN_PROFILE)).revision; }
    catch (error) { if (!(error instanceof NoteError) || error.code !== 'note_unavailable') throw error; }
    const observations = await this.assessmentObservations();
    await this.notes.put(DESIGN_PROFILE, renderProfile(observations), revision);
    return { observations: observations.length, rebuilt: true };
  }

  async outline(input: { id?: string; concept_ids?: string[] }) {
    await this.workflows.config('system-design');
    if ((input.id === undefined) === (input.concept_ids === undefined)) throw new PracticeError('provide_review_or_concepts');
    let concepts = input.concept_ids ?? [];
    if (input.id) {
      const note = await this.item(input.id);
      if (note.item.domain !== 'system-design') throw new PracticeError('unsupported_practice_domain');
      concepts = note.item.concept_ids;
    }
    return designOutline(concepts, await this.assessmentObservations());
  }

  async readNote(path: string) {
    await this.workflows.config(practiceNoteDomain(path));
    return { path, ...await this.read(path) };
  }
  async designTemplate(input: z.infer<typeof designSessionSchema>) {
    await this.workflows.config('system-design');
    return designSessionTemplate(input, this.today());
  }
  private async checkCanvasPath(path: string) {
    if (validatePracticeWritePath(path) !== 'system-design' ||
      !path.startsWith(practiceDomains['system-design'].root + 'Solutions/') || !path.endsWith('.excalidraw.md')) throw new NoteError('invalid_path');
    await this.workflows.config('system-design');
  }

  async designCanvas(path: string) {
    await this.checkCanvasPath(path);
    const note = await this.read(path);
    return { path, revision: note.revision, ...readDesignCanvas(note.text, this.settings.limits) };
  }
  private reviewPath(path: string) {
    return CANVAS_REVIEW_PREFIX + createHash('sha256').update(path).digest('hex') + '.md';
  }

  private reviewedScene(json: string) {
    const drawing = parseScene(json, this.settings.limits);
    for (const element of drawing.elements) {
      if (element.type !== 'image' || element.isDeleted) continue;
      const file = typeof element.fileId === 'string' && drawing.files?.[element.fileId];
      if (!file || typeof file !== 'object' || !('dataURL' in file) || !file.dataURL) {
        throw new PracticeError('canvas_image_missing');
      }
    }
    return drawing;
  }

  async stageCanvas(path: string, scene: Record<string, unknown>) {
    await this.checkCanvasPath(path);
    const json = JSON.stringify(scene);
    this.reviewedScene(json);
    const key = this.reviewPath(path);
    let snapshot;
    try { snapshot = await this.notes.put(key, json); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      const prior = await this.read(key);
      snapshot = prior.text === json ? prior.revision : await this.notes.put(key, json, prior.revision);
    }
    return { path, snapshot };
  }

  async saveCanvas(path: string, input: { snapshot?: string; scene?: Record<string, unknown> }, revision: string | null) {
    await this.checkCanvasPath(path);
    const { snapshot, scene: supplied } = input;
    if ((snapshot === undefined) === (supplied === undefined)) throw new PracticeError('provide_snapshot_or_scene');
    let json: string;
    if (snapshot !== undefined) {
      const staged = await this.read(this.reviewPath(path));
      if (staged.revision !== snapshot) throw new PracticeError('canvas_review_superseded');
      json = staged.text;
    } else {
      if (!supplied?.appState || !supplied.files) throw new PracticeError('incomplete_canvas_scene');
      json = JSON.stringify(supplied);
    }
    const scene = this.reviewedScene(json);
    const prior = revision === null ? undefined : await this.read(path);
    if (prior && prior.revision !== revision) throw new PracticeError('revision_conflict');
    const content = writeDesignCanvas(prior?.text, scene);
    readDesignCanvas(content, this.settings.limits);
    await this.notes.put(path, content, prior?.revision);
    const saved = await this.designCanvas(path);
    if (!isDeepStrictEqual(saved.drawing, scene)) throw new PracticeError('canvas_verification_failed');
    return { path, snapshot, revision: saved.revision, elements: scene.elements.length, verified: true };
  }

  private checkSessionCompletion(path: string, before: string | undefined, after: string) {
    if (!path.startsWith(practiceDomains['system-design'].root + 'Solutions/') || !path.endsWith('/progress.md')) return;
    const fields = (content: string) => {
      const metadata = parseFrontmatter(content)?.metadata ?? {};
      const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
      return { done: tags.includes('system-design/done'), round: metadata.round_id, topic: metadata.review_item_id };
    };
    const next = fields(after);
    const prior = before ? fields(before) : undefined;
    if (next.done && !prior?.done) throw new PracticeError('use_practice_finish_round');
    if (prior?.done && (!next.done || prior.round !== next.round || prior.topic !== next.topic)) throw new PracticeError('session_already_closed');
  }

  async createNote(path: string, content: string) {
    await this.workflows.config(validatePracticeWritePath(path));
    this.checkSessionCompletion(path, undefined, content);
    await this.notes.put(path, content);
    return { path, created: true };
  }
  async updateNote(path: string, revision: string, edits: { old: string; replacement: string }[]) {
    await this.workflows.config(validatePracticeWritePath(path));
    const note = await this.read(path);
    if (note.revision !== revision) throw new PracticeError('revision_conflict');
    let result = note.text;
    for (const edit of edits) {
      const start = result.indexOf(edit.old);
      if (start < 0 || result.indexOf(edit.old, start + 1) >= 0) throw new PracticeError('edit_anchor_not_unique');
      result = result.slice(0, start) + edit.replacement + result.slice(start + edit.old.length);
    }
    this.checkSessionCompletion(path, note.text, result);
    await this.notes.put(path, result, revision);
    return { path, updated: true };
  }
}
