import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'yaml';
import { z } from 'zod';
import { PracticeError } from '../errors.js';
import { NoteError } from '../paths.js';
import { parsePracticeNote } from '../practice-note.js';
import { conceptIdSchema, REVIEW_ITEMS_PREFIX, reviewSummarySchema as summarySchema, slugSchema, type ReviewSummary } from '../practice-schema.js';
import type { IndexedReview } from '../review-index.js';
import type { ReviewAttempt, ReviewConsumer, ReviewConsumers } from './consumer.js';
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

export interface RecordedAttempt extends ReviewAttempt {
  id: string; revision: string; reflection: string; completed_on: string; observations?: string;
}

export interface ReviewItemsDependencies<Domain extends string> {
  readonly notes: ReviewNotes;
  readonly index: ActiveReviews<Domain>;
  readonly consumers: ReviewConsumers<Domain>;
  /** Checks that the domain may be used and returns its schedule. */
  schedule(domain: Domain): Promise<ScheduleConfig>;
  today(): string;
  readonly signal: AbortSignal;
}

type Queue = Record<'overdue' | 'today' | 'unstarted' | 'upcoming', ReviewSummary[]>;

/**
 * The spaced-repetition core: review items, the due queue and recorded
 * attempts. Module-specific behavior comes only from registered consumers.
 */
export class ReviewItems<Domain extends string> {
  constructor(private readonly deps: ReviewItemsDependencies<Domain>) {}

  private consumer(domain: string): ReviewConsumer | undefined {
    return Object.hasOwn(this.deps.consumers, domain) ? this.deps.consumers[domain as Domain] : undefined;
  }

  /** Reads one item. Outside the queue, an item of an unregistered domain is refused. */
  async note(id: string, forQueue = false, config?: ScheduleConfig) {
    const path = REVIEW_ITEMS_PREFIX + slugSchema.parse(id) + '.md';
    const note = await this.deps.notes.read(path);
    const parsed = parsePracticeNote(note.text);
    const item = itemSchema.parse(parsed.metadata);
    if (item.id !== id) throw new PracticeError('review_id_mismatch');
    const consumer = this.consumer(item.domain);
    if (!forQueue && !consumer) throw new PracticeError('unsupported_practice_domain');
    const correctHistory = consumer?.correctHistory;
    if (correctHistory) {
      const schedule = config ?? await this.deps.schedule(item.domain as Domain);
      Object.assign(item, correctHistory(item, parsed.body, schedule));
    }
    return { ...note, ...parsed, item, path };
  }

  private present(item: ReviewSummary) {
    return { ...item, ...this.consumer(item.domain)?.present(item) };
  }

  private queue(rows: readonly ReviewSummary[], day: string) {
    const queue: Queue = { overdue: [], today: [], unstarted: [], upcoming: [] };
    const ordered = [...rows].sort((a, b) => (a.next_review ?? '').localeCompare(b.next_review ?? '') || a.id.localeCompare(b.id));
    for (const row of ordered) {
      const entry = this.present(row);
      if (row.next_review === null) queue.unstarted.push(entry);
      else if (row.next_review < day) queue.overdue.push(entry);
      else if (row.next_review === day) queue.today.push(entry);
      else queue.upcoming.push(entry);
    }
    return queue;
  }

  async reviews(domain: Domain) {
    const config = await this.deps.schedule(domain);
    const day = this.deps.today();
    const rows = await this.currentReviews(await this.indexed(domain), day, config);
    return { date: day, domain, ...this.queue(rows.filter(row => row.domain === domain && row.status === 'active'), day) };
  }

  private async indexed(domain: Domain) {
    try { return await this.deps.index.activeReviews(domain, this.deps.signal); }
    catch {
      this.deps.signal.throwIfAborted();
      throw new PracticeError('review_index_unavailable');
    }
  }

  /** Confirms due, unstarted and history-corrected rows against their notes, four at a time. */
  private async currentReviews(indexed: IndexedReview[], day: string, config: ScheduleConfig) {
    const summary = (row: ReviewSummary): ReviewSummary => summarySchema.parse(row);
    const needsNote = (row: IndexedReview) => Boolean(this.consumer(row.domain)?.correctHistory) || row.next_review === null || row.next_review <= day;
    const rows = indexed.filter(row => !needsNote(row)).map(summary);
    const unconfirmed = indexed.filter(needsNote);
    for (let index = 0; index < unconfirmed.length; index += 4) {
      rows.push(...await Promise.all(unconfirmed.slice(index, index + 4).map(async row => {
        const note = await this.note(row.id, true, config);
        return summary(note.item);
      })));
    }
    return rows;
  }

  /** Writes the consumer's history correction back to every active item of the domain. */
  async recalculate(domain: Domain) {
    const config = await this.deps.schedule(domain);
    const correctHistory = this.consumer(domain)?.correctHistory;
    let updated = 0;
    if (!correctHistory) return { updated };
    for (const row of await this.indexed(domain)) {
      const note = await this.note(row.id, true, config);
      const corrected = correctHistory(itemSchema.parse(note.metadata), note.body, config);
      if (Object.entries(corrected).every(([key, value]) => isDeepStrictEqual(note.metadata[key], value))) continue;
      await this.deps.notes.put(note.path, serializeNote({ ...note.metadata, ...corrected }, note.body), note.revision);
      updated++;
    }
    return { updated };
  }

  async review(id: string, includeHistory = false) {
    const note = await this.note(id);
    await this.deps.schedule(note.item.domain as Domain);
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    return { ...this.present(summarySchema.parse(note.item)), prompt: note.item.prompt, concept_ids: note.item.concept_ids, source: note.item.source ?? null,
      revision: note.revision, ...(includeHistory ? { history: note.body } : {}) };
  }

  /** Creates an unstarted item once; an existing item with the same domain and title is returned unchanged. */
  async add(input: NewReview<Domain>) {
    await this.deps.schedule(input.domain);
    const metadata = { id: input.id, domain: input.domain, title: input.title.trim(), status: 'active', prompt: input.prompt,
      concept_ids: input.concept_ids ?? [], review_count: 0, stage: 0, ...this.consumer(input.domain)?.initialState(), last_review: null, next_review: null, attempt_ids: [], ...(input.source ? { source: input.source } : {}) };
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

  /** Records one attempt exactly once and appends it to the practice history. */
  async record(input: RecordedAttempt) {
    const note = await this.note(input.id);
    const domain = note.item.domain as Domain;
    const config = await this.deps.schedule(domain);
    const consumer = this.consumer(domain)!;
    if (note.item.attempt_ids.includes(input.attempt_id)) return { ...summarySchema.parse(note.item), recorded: false };
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    if (input.completed_on > this.deps.today()) throw new PracticeError('review_date_is_in_future');
    if (input.revision !== note.revision) throw new PracticeError('revision_conflict');
    const outcome = input.outcome ?? consumer.defaultOutcome;
    if (!outcome) throw new PracticeError('invalid_review_outcome');
    await consumer.beforeRecord(note.item, input);
    const schedule = nextSchedule(note.item, outcome, input.completed_on, config, consumer.schedule);
    const metadata = { ...note.metadata, ...schedule, last_outcome: outcome, attempt_ids: [...note.item.attempt_ids, input.attempt_id] };
    let entry = `\n\n### ${input.completed_on} · Round ${schedule.review_count}\n\n**${outcome}** · ${schedule.status === 'archived' ? 'Archived' : `Next review ${schedule.next_review}`}\n\n#### My reflection\n\n${input.reflection}\n`;
    if (input.submission) entry += `\n#### Submission\n\n${input.submission}\n`;
    if (input.observations) entry += `\n#### Feedback\n\n${input.observations}\n`;
    await this.deps.notes.put(note.path, serializeNote(metadata, note.body + entry), note.revision);
    return { ...summarySchema.parse(metadata), recorded: true };
  }
}
