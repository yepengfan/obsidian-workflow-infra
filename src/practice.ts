import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'yaml';
import { z } from 'zod';
import { DesignCoaching } from './design-coaching.js';
import { PracticeWorkflow } from './practice-workflow.js';
import { calendarDay, nextSchedule } from './review-schedule.js';
import type { Settings } from './config.js';
import { NoteError } from './paths.js';
import type { NoteReader, NoteStore, NoteWriter } from './note-store.js';
import { PracticeError } from './errors.js';
import { CANVAS_REVIEW_PREFIX, type PracticeDomain, domainSchema, practiceDomains, practiceNoteDomain, validatePracticeWritePath } from './practice-domains.js';
import { designSessionTemplate, designSessionSchema } from './design-session.js';
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
  source: text.optional(), review_focus: text.optional() });
export const recordReviewSchema = z.strictObject({ id: slugSchema, revision: revisionSchema,
  attempt_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u).max(128),
  outcome: z.enum(['independent', 'assisted', 'incomplete']), reflection: requiredText,
  completed_on: dateSchema, submission: text.optional(), observations: text.optional() });
export const listReviewsSchema = z.strictObject({ domain: domainSchema });
const itemSchema = summarySchema.extend({ prompt: requiredText, source: text.optional(), attempt_ids: z.array(z.string()).max(5000).default([]) });
function serialize(metadata: Record<string, unknown>, body: string) { return `---\n${stringify(metadata)}---\n${body}`; }
function reviewQueue(rows: readonly ReviewSummary[], day: string) {
  const queue: Record<'overdue' | 'today' | 'unstarted' | 'upcoming', ReviewSummary[]> = { overdue: [], today: [], unstarted: [], upcoming: [] };
  const ordered = [...rows].sort((a, b) => (a.next_review ?? '').localeCompare(b.next_review ?? '') || a.id.localeCompare(b.id));
  for (const row of ordered) {
    if (row.next_review === null) queue.unstarted.push(row);
    else if (row.next_review < day) queue.overdue.push(row);
    else if (row.next_review === day) queue.today.push(row);
    else queue.upcoming.push(row);
  }
  return queue;
}

export class Practice {
  private readonly notes: PracticeNotes;
  private readonly workflows: PracticeWorkflow;

  constructor(store: NoteReader, private readonly index: ReviewIndex & SessionIndex, private readonly settings: Pick<Settings, 'prefix' | 'practice' | 'limits'>,
    private readonly signal: AbortSignal, private readonly dependencies: { writer?: NoteWriter; now?: () => Date } = {}) {
    this.notes = new PracticeNotes(store, settings.prefix, signal, settings.limits.practiceNoteBytes, settings.practice.writesEnabled ? dependencies.writer : undefined);
    this.workflows = new PracticeWorkflow(settings.practice, path => this.read(path), dependencies.now ?? (() => new Date()), signal);
  }
  designCoaching(catalog: Pick<NoteStore, 'list'>) {
    return new DesignCoaching(catalog, this.notes, this.settings.prefix, this.signal, () => this.workflows.config('system-design'));
  }

  private today() { return calendarDay(this.settings.practice.timeZone, this.dependencies.now?.() ?? new Date()); }
  read(path: string) {
    return this.notes.read(path);
  }

  async workflow(domain?: PracticeDomain) {
    const workflow = await this.workflows.workflow(domain);
    if (domain || !workflow.available_domains.some(item => item.domain === 'system-design')) return workflow;
    try {
      return { ...workflow, unfinished_sessions: await this.index.unfinishedSessions(this.signal) };
    } catch {
      this.signal.throwIfAborted();
      return { ...workflow, unfinished_sessions: null };
    }
  }

  instruction(path: string, offset: number) {
    return this.workflows.instruction(path, offset);
  }

  private async item(id: string, forQueue = false) {
    const path = REVIEW_ITEMS_PREFIX + slugSchema.parse(id) + '.md';
    const note = await this.read(path);
    const parsed = parsePracticeNote(note.text);
    const item = itemSchema.parse(parsed.metadata);
    if (item.id !== id) throw new PracticeError('review_id_mismatch');
    if (!forQueue && !domainSchema.safeParse(item.domain).success) throw new PracticeError('unsupported_practice_domain');
    return { ...note, ...parsed, item, path };
  }
  async reviews(input: z.infer<typeof listReviewsSchema>) {
    domainSchema.parse(input.domain);
    await this.workflows.config(input.domain);
    const day = this.today();
    const rows = await this.currentReviews(await this.indexedReviews(input.domain), day);
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
  /**
   * The index trails note saves by seconds. Confirm every due or unstarted row
   * against its note so a just-recorded round never reappears as due. Upcoming
   * rows are not read; the daily reconcile bounds their staleness.
   */
  private async currentReviews(indexed: IndexedReview[], day: string) {
    const summary = (row: ReviewSummary): ReviewSummary => summarySchema.parse(row);
    const rows = indexed.filter(row => row.next_review !== null && row.next_review > day).map(summary);
    const unconfirmed = indexed.filter(row => row.next_review === null || row.next_review <= day);
    for (let index = 0; index < unconfirmed.length; index += 4) {
      rows.push(...await Promise.all(unconfirmed.slice(index, index + 4).map(async row => {
        const note = await this.item(row.id, true);
        return note.revision === row.revision ? summary(row) : summarySchema.parse(note.item);
      })));
    }
    return rows;
  }
  async review(id: string, includeHistory = false) {
    const note = await this.item(id);
    await this.workflows.config(domainSchema.parse(note.item.domain));
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    return { ...summarySchema.parse(note.item), prompt: note.item.prompt, source: note.item.source ?? null,
      revision: note.revision, ...(includeHistory ? { history: note.body } : {}) };
  }
  async add(input: z.infer<typeof addReviewSchema>) {
    domainSchema.parse(input.domain);
    await this.workflows.config(input.domain);
    const metadata = { id: input.id, domain: input.domain, title: input.title.trim(), status: 'active', prompt: input.prompt,
      review_count: 0, stage: 0, last_review: null, next_review: null, attempt_ids: [], ...(input.source ? { source: input.source } : {}) };
    const body = `# ${metadata.title.replace(/[\r\n]/gu, ' ')}\n\n${input.review_focus ? '## Review focus\n\n' + input.review_focus + '\n\n' : ''}## Practice history\n`;
    try { await this.notes.put(REVIEW_ITEMS_PREFIX + input.id + '.md', serialize(metadata, body)); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      const existing = await this.item(input.id);
      if (existing.item.domain !== input.domain || existing.item.title !== metadata.title) throw new PracticeError('review_id_conflict');
      return { ...summarySchema.parse(existing.item), created: false, revision: existing.revision };
    }
    return { ...summarySchema.parse(metadata), created: true };
  }
  async record(input: z.infer<typeof recordReviewSchema>) {
    const note = await this.item(input.id);
    const config = await this.workflows.config(domainSchema.parse(note.item.domain));
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    if (note.item.attempt_ids.includes(input.attempt_id)) return { ...summarySchema.parse(note.item), recorded: false };
    if (input.completed_on > this.today()) throw new PracticeError('review_date_is_in_future');
    if (input.revision !== note.revision) throw new PracticeError('revision_conflict');
    const schedule = nextSchedule(note.item, input.outcome, input.completed_on, config.interval_days, config.retry_days, config.archive_after_final);
    const metadata = { ...note.metadata, ...schedule, last_outcome: input.outcome, attempt_ids: [...note.item.attempt_ids, input.attempt_id] };
    let entry = `\n\n### ${input.completed_on} · Round ${schedule.review_count}\n\n**${input.outcome}** · ${schedule.status === 'archived' ? 'Archived' : `Next review ${schedule.next_review}`}\n\n#### My reflection\n\n${input.reflection}\n`;
    if (input.submission) entry += `\n#### Submission\n\n${input.submission}\n`;
    if (input.observations) entry += `\n#### Feedback\n\n${input.observations}\n`;
    await this.notes.put(note.path, serialize(metadata, note.body + entry), note.revision);
    return { ...summarySchema.parse(metadata), recorded: true };
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

  async stageCanvas(path: string, scene: Record<string, unknown>) {
    await this.checkCanvasPath(path);
    const json = JSON.stringify(scene);
    const drawing = parseScene(json, this.settings.limits);
    for (const element of drawing.elements) {
      if (element.type !== 'image' || element.isDeleted) continue;
      const file = typeof element.fileId === 'string' && drawing.files?.[element.fileId];
      if (!file || typeof file !== 'object' || !('dataURL' in file) || !file.dataURL) {
        throw new PracticeError('canvas_image_missing');
      }
    }
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

  async saveCanvas(path: string, snapshot: string, revision: string | null) {
    await this.checkCanvasPath(path);
    const staged = await this.read(this.reviewPath(path));
    if (staged.revision !== snapshot) throw new PracticeError('canvas_review_superseded');
    const scene = parseScene(staged.text, this.settings.limits);
    const prior = revision === null ? undefined : await this.read(path);
    if (prior && prior.revision !== revision) throw new PracticeError('revision_conflict');
    const content = writeDesignCanvas(prior?.text, scene);
    readDesignCanvas(content, this.settings.limits);
    await this.notes.put(path, content, prior?.revision);
    const saved = await this.designCanvas(path);
    if (!isDeepStrictEqual(saved.drawing, scene)) throw new PracticeError('canvas_verification_failed');
    return { path, snapshot, revision: saved.revision, elements: scene.elements.length, verified: true };
  }

  async createNote(path: string, content: string) {
    await this.workflows.config(validatePracticeWritePath(path));
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
    await this.notes.put(path, result, revision);
    return { path, updated: true };
  }
}
