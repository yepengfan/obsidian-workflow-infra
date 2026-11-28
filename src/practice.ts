import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';
import { PracticeWorkflow } from './practice-workflow.js';
import { checkFinalSummary } from './design-review.js';
import { practiceReviewConsumers } from './review-consumers.js';
import { ReviewItems, serializeNote as serialize } from './srs/review-items.js';
import { calendarDay } from './srs/schedule.js';
import type { Settings } from './config.js';
import { NoteError } from './paths.js';
import type { NoteStore, NoteWriter } from './note-store.js';
import { PracticeError } from './errors.js';
import { CANVAS_REVIEW_PREFIX, DESIGN_PROFILE, type PracticeDomain, domainSchema, practiceDomains, practiceNoteDomain, validatePracticeWritePath } from './practice-domains.js';
import { designSessionTemplate, designSessionSchema } from './design-session.js';
import { conceptObservationSchema, designOutline, parseObservations, renderProfile, upsertObservations, type StoredObservation } from './design-profile.js';
import { readDesignCanvas, parseScene, writeDesignCanvas } from './design-canvas.js';
import { conceptIdSchema, dateSchema, reviewSummarySchema as summarySchema, slugSchema } from './practice-schema.js';
import { parsePracticeNote, PracticeNotes } from './practice-note.js';
import type { ReviewIndex, SessionIndex } from './review-index.js';

export { calendarDay } from './srs/schedule.js';
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
export class Practice {
  private readonly notes: PracticeNotes;
  private readonly workflows: PracticeWorkflow;
  private readonly items: ReviewItems<PracticeDomain>;

  constructor(private readonly store: NoteStore, private readonly index: ReviewIndex & SessionIndex, private readonly settings: Pick<Settings, 'prefix' | 'practice' | 'limits'>,
    private readonly signal: AbortSignal, private readonly dependencies: { writer?: NoteWriter; now?: () => Date } = {}) {
    this.notes = new PracticeNotes(store, settings.prefix, signal, settings.limits.practiceNoteBytes, settings.practice.writesEnabled ? dependencies.writer : undefined);
    this.workflows = new PracticeWorkflow(settings.practice, path => this.read(path), dependencies.now ?? (() => new Date()), signal);
    this.items = new ReviewItems({
      notes: this.notes, index, signal, today: () => this.today(),
      consumers: practiceReviewConsumers({ designObservations: () => this.assessmentObservations() }),
      schedule: async domain => {
        const config = await this.workflows.config(domainSchema.parse(domain));
        return { intervals: config.interval_days, retryDays: config.retry_days, archiveAfterFinal: config.archive_after_final };
      },
    });
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

  async reviews(input: z.infer<typeof listReviewsSchema>) {
    const { date, domain, ...queue } = await this.items.reviews(domainSchema.parse(input.domain));
    return { date, time_zone: this.settings.practice.timeZone, domain, ...queue, complete: true };
  }
  async recalculateDesignReviews() {
    return this.items.recalculate('system-design');
  }
  async review(id: string, includeHistory = false) {
    return this.items.review(id, includeHistory);
  }
  async add(input: z.infer<typeof addReviewSchema>) {
    return this.items.add({ ...input, domain: domainSchema.parse(input.domain) });
  }
  async record(input: z.infer<typeof recordReviewSchema>) {
    if (input.concept_observations?.length) throw new PracticeError('use_practice_finish_round_for_evidence');
    return this.items.record(input);
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
      await this.assertFinalSummary(topic.id, attempt, { progressPath: progress_path, completedOn: attempt.completed_on });
      if (tags.includes('system-design/wip') && !metadata.confirmed_registration) {
        await this.notes.put(progress_path, serialize({ ...metadata, round_id: attempt.attempt_id, review_item_id: topic.id,
          round_completed_on: attempt.completed_on, confirmed_registration: { topic, attempt } }, body), note.revision);
      }
    }
    await this.add(topic);
    let current = await this.items.note(topic.id);
    if (topic.domain === 'system-design' && !current.item.concept_ids.length && topic.concept_ids?.length) {
      await this.notes.put(current.path, serialize({ ...current.metadata, concept_ids: topic.concept_ids }, current.body), current.revision);
      current = await this.items.note(topic.id);
    }
    if (!current.item.attempt_ids.includes(attempt.attempt_id)) {
      const registration = { ...attempt };
      delete registration.concept_observations;
      await this.record({ ...registration, id: topic.id, revision: current.revision });
    }
    const verified = await this.items.note(topic.id);
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

  /** Checks a System Design closing round before its session is bound, while the topic may not exist yet. */
  private async assertFinalSummary(id: string, attempt: z.infer<typeof finishRoundSchema>['attempt'], progress: { progressPath: string; completedOn: string }) {
    let current;
    try { current = await this.items.note(id); }
    catch (error) { if (error instanceof NoteError && error.code === 'note_unavailable') return; throw error; }
    if (current.item.domain !== 'system-design') return;
    await checkFinalSummary(current.item, attempt, () => this.assessmentObservations(progress));
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
      const note = await this.items.note(input.id);
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
