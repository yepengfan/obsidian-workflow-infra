import { stringify } from 'yaml';
import { z } from 'zod';
import { PracticeError } from '../errors.js';
import { NoteError } from '../paths.js';
import { parsePracticeNote } from '../practice-note.js';
import { conceptIdSchema, REVIEW_ITEMS_PREFIX, reviewSummarySchema as summarySchema, slugSchema, type ReviewSummary } from '../practice-schema.js';
import type { IndexedReview } from '../review-index.js';
import { judge, type CriterionResult, type PassCriterion } from './criteria.js';
import { renderEntry } from './history.js';
import { nextSchedule, type ScheduleConfig } from './schedule.js';

const text = z.string().max(12000);
const requiredText = text.refine(value => value.trim().length > 0);
const itemSchema = summarySchema.extend({ prompt: requiredText, source: text.optional(), concept_ids: z.array(conceptIdSchema).max(50).default([]), attempt_ids: z.array(z.string()).max(5000).default([]) });

export function serializeNote(metadata: Record<string, unknown>, body: string) { return `---\n${stringify(metadata)}---\n${body}`; }

/** Read and conditional-write access to review notes. */
export interface ReviewNotes {
  read(path: string): Promise<{ text: string; revision: string }>;
  put(path: string, text: string, revision?: string): Promise<string>;
}

/** The active rows the index holds for one domain. */
export interface ActiveReviews<Domain extends string> {
  activeReviews(domain: Domain, signal: AbortSignal): Promise<IndexedReview[]>;
}

export interface NewReview<Domain extends string> {
  id: string; domain: Domain; title: string; prompt: string;
  source?: string; review_focus?: string; concept_ids?: string[];
}

/** One ended attempt, judged against every pass criterion of its module. */
export interface RecordedAttempt {
  id: string; revision: string; attempt_id: string; reflection: string; completed_on: string;
  criteria: readonly CriterionResult[]; submission?: string; observations?: string;
  /** Records the item's first attempt as a placement; see `nextSchedule`. */
  placement?: boolean;
  /** A module's own history section, rendered after the criteria. */
  details?: string;
}

/** How one module's items are scheduled and judged. */
export interface ReviewPolicy {
  readonly schedule: ScheduleConfig;
  readonly criteria: readonly PassCriterion[];
  /** The stage a passed placement moves to; absent when the module records no placements. */
  readonly placementStage?: number;
}

export interface ReviewItemsDependencies<Domain extends string> {
  readonly notes: ReviewNotes;
  readonly index: ActiveReviews<Domain>;
  /** Whether a domain belongs to a registered module. */
  registered(domain: string): domain is Domain;
  /** Checks that the domain may be used and returns its policy. */
  policy(domain: Domain): Promise<ReviewPolicy>;
  today(): string;
  readonly signal: AbortSignal;
}

type Queue = Record<'overdue' | 'today' | 'unstarted' | 'upcoming', ReviewSummary[]>;

/**
 * The spaced-repetition core: review items, the due queue and recorded
 * attempts. Every module follows the same schedule rule; a module supplies
 * only its configuration and pass criteria.
 */
export class ReviewItems<Domain extends string> {
  constructor(private readonly deps: ReviewItemsDependencies<Domain>) {}

  /** Reads one item. Outside the queue, an item of an unregistered domain is refused. */
  async note(id: string, forQueue = false) {
    const path = REVIEW_ITEMS_PREFIX + slugSchema.parse(id) + '.md';
    const note = await this.deps.notes.read(path);
    const parsed = parsePracticeNote(note.text);
    const item = itemSchema.parse(parsed.metadata);
    if (item.id !== id) throw new PracticeError('review_id_mismatch');
    if (!forQueue && !this.deps.registered(item.domain)) throw new PracticeError('unsupported_practice_domain');
    return { ...note, ...parsed, item, path };
  }

  private queue(rows: readonly ReviewSummary[], day: string) {
    const queue: Queue = { overdue: [], today: [], unstarted: [], upcoming: [] };
    const ordered = [...rows].sort((a, b) => (a.next_review ?? '').localeCompare(b.next_review ?? '') || a.id.localeCompare(b.id));
    for (const row of ordered) {
      const entry = summarySchema.parse(row);
      if (row.next_review === null) queue.unstarted.push(entry);
      else if (row.next_review < day) queue.overdue.push(entry);
      else if (row.next_review === day) queue.today.push(entry);
      else queue.upcoming.push(entry);
    }
    return queue;
  }

  async reviews(domain: Domain) {
    await this.deps.policy(domain);
    const day = this.deps.today();
    const rows = await this.currentReviews(await this.indexed(domain), day);
    return { date: day, domain, ...this.queue(rows.filter(row => row.domain === domain && row.status === 'active'), day) };
  }

  private async indexed(domain: Domain) {
    try { return await this.deps.index.activeReviews(domain, this.deps.signal); }
    catch {
      this.deps.signal.throwIfAborted();
      throw new PracticeError('review_index_unavailable');
    }
  }

  /** Confirms due and unstarted rows against their notes, four at a time. */
  private async currentReviews(indexed: IndexedReview[], day: string) {
    const summary = (row: ReviewSummary): ReviewSummary => summarySchema.parse(row);
    const needsNote = (row: IndexedReview) => row.next_review === null || row.next_review <= day;
    const rows = indexed.filter(row => !needsNote(row)).map(summary);
    const unconfirmed = indexed.filter(needsNote);
    for (let index = 0; index < unconfirmed.length; index += 4) {
      rows.push(...await Promise.all(unconfirmed.slice(index, index + 4).map(async row => {
        const note = await this.note(row.id, true);
        return summary(note.item);
      })));
    }
    return rows;
  }

  async review(id: string, includeHistory = false) {
    const note = await this.note(id);
    await this.deps.policy(note.item.domain as Domain);
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    return { ...summarySchema.parse(note.item), prompt: note.item.prompt, concept_ids: note.item.concept_ids, source: note.item.source ?? null,
      revision: note.revision, ...(includeHistory ? { history: note.body } : {}) };
  }

  /** Creates an unstarted item once; an existing item with the same domain and title is returned unchanged. */
  async add(input: NewReview<Domain>) {
    await this.deps.policy(input.domain);
    const metadata = { id: input.id, domain: input.domain, title: input.title.trim(), status: 'active', prompt: input.prompt,
      concept_ids: input.concept_ids ?? [], review_count: 0, stage: 0, last_review: null, next_review: null, attempt_ids: [], ...(input.source ? { source: input.source } : {}) };
    const body = `# ${metadata.title.replace(/[\r\n]/gu, ' ')}\n\n${input.review_focus ? '## Review focus\n\n' + input.review_focus + '\n\n' : ''}## Practice history\n`;
    try { await this.deps.notes.put(REVIEW_ITEMS_PREFIX + input.id + '.md', serializeNote(metadata, body)); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      const existing = await this.note(input.id);
      if (existing.item.domain !== input.domain || existing.item.title !== metadata.title) throw new PracticeError('review_id_conflict');
      return { ...summarySchema.parse(existing.item), concept_ids: existing.item.concept_ids, created: false, revision: existing.revision };
    }
    return { ...summarySchema.parse(metadata), concept_ids: metadata.concept_ids, created: true };
  }

  /** Records one attempt exactly once, judges it and appends it to the practice history. */
  async record(input: RecordedAttempt) {
    const note = await this.note(input.id);
    const { schedule, criteria, placementStage } = await this.deps.policy(note.item.domain as Domain);
    if (note.item.attempt_ids.includes(input.attempt_id)) return { ...summarySchema.parse(note.item), recorded: false };
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    if (input.completed_on > this.deps.today()) throw new PracticeError('review_date_is_in_future');
    if (input.revision !== note.revision) throw new PracticeError('revision_conflict');
    if (input.placement && placementStage === undefined) throw new PracticeError('placement_not_supported');
    const { passed, unmet } = judge(criteria, input.criteria);
    const change = nextSchedule(note.item, passed, input.completed_on, schedule, input.placement ? placementStage : undefined);
    // last_result replaces the legacy last_outcome.
    const metadata: Record<string, unknown> = { ...note.metadata, ...change, last_result: passed ? 'passed' : 'failed',
      unmet_criteria: unmet, attempt_ids: [...note.item.attempt_ids, input.attempt_id] };
    delete metadata.last_outcome;
    const ordered = criteria.map(criterion => input.criteria.find(result => result.id === criterion.id)!);
    const entry = renderEntry({ date: input.completed_on, round: change.review_count, passed, nextReview: change.next_review,
      criteria: ordered, reflection: input.reflection, submission: input.submission, observations: input.observations,
      placement: input.placement, details: input.details });
    await this.deps.notes.put(note.path, serializeNote(metadata, note.body + entry), note.revision);
    return { ...summarySchema.parse(metadata), passed, unmet_criteria: unmet, recorded: true };
  }
}
