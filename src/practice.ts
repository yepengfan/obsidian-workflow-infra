import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import bundle from '../workflows/practice.json' with { type: 'json' };
import type { Settings } from './config.js';
import { decodeCursor, encodeCursor, keyFor, NoteError, validPath } from './paths.js';
import type { NoteStore, NoteWriter } from './note-store.js';
import { OperationError } from './errors.js';
import { type PracticeDomain, domainSchema, practiceDocuments, practiceDomains, practiceNoteDomain, sharedPracticeDocuments, validatePracticeWritePath } from './practice-domains.js';
import { designSessionTemplate, designSessionSchema } from './design-session.js';

export { domainSchema, validatePracticeWritePath } from './practice-domains.js';
export const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(120);
export const revisionSchema = z.string().min(1).max(256);
const text = z.string().max(12000);
const requiredText = text.refine(value => value.trim().length > 0);
export const dateSchema = z.iso.date().refine(value => !value.startsWith('0000-'), { message: 'Year must be between 0001 and 9999' });
export const addReviewSchema = z.strictObject({ id: slugSchema, domain: domainSchema, title: requiredText.max(200), prompt: requiredText,
  source: text.optional(), review_focus: text.optional() });
export const recordReviewSchema = z.strictObject({ id: slugSchema, revision: revisionSchema,
  attempt_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u).max(128),
  outcome: z.enum(['independent', 'assisted', 'incomplete']), reflection: requiredText,
  completed_on: dateSchema, submission: text.optional(), observations: text.optional() });
export const listReviewsSchema = z.strictObject({ domain: domainSchema, cursor: z.string().max(8192).optional() });
const summarySchema = z.object({ id: slugSchema, domain: z.enum(['algorithm', 'system-design', 'behavioral']), title: z.string().min(1).max(200), status: z.enum(['active', 'archived']),
  review_count: z.number().int().nonnegative(), stage: z.number().int().nonnegative(),
  last_review: dateSchema.nullable(), next_review: dateSchema.nullable() });
const itemSchema = summarySchema.extend({ prompt: requiredText, source: text.optional(), attempt_ids: z.array(z.string()).max(5000).default([]) });
const moduleSchema = z.object({ enabled: z.boolean(), interval_days: z.array(z.number().int().min(1).max(3650)).min(1).max(20),
  retry_days: z.number().int().min(1).max(3650), practice_flows: z.record(z.string(), z.unknown()),
  review_time_limits: z.record(z.string(), z.unknown()) });
type ModuleConfig = z.infer<typeof moduleSchema>;
type DomainAvailability = { domain: PracticeDomain; label: string } & (
  { status: 'enabled'; time_limit: number } | { status: 'disabled' | 'unavailable'; reason: string });
const prefix = 'Learning/Practice/Review/Items/';
const documents: Record<string, { text: string; sha256: string }> = bundle.documents;
export class PracticeError extends OperationError {}
function parseNote(value: string) {
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u);
  if (!match) throw new PracticeError('invalid_practice_note');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new PracticeError('invalid_practice_note');
  const data: unknown = document.toJS({ maxAliasCount: 20 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PracticeError('invalid_practice_note');
  return { metadata: data as Record<string, unknown>, body: match[2]! };
}
function serialize(metadata: Record<string, unknown>, body: string) { return `---\n${stringify(metadata)}---\n${body}`; }
export function calendarDay(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return dateSchema.parse(date.toISOString().slice(0, 10));
}
export function nextSchedule(item: z.infer<typeof summarySchema>, outcome: string, day: string, intervals: number[], retry: number) {
  dateSchema.parse(day);
  if (item.last_review && day < item.last_review) throw new PracticeError('review_date_precedes_last_review');
  let stage = item.stage;
  if (stage >= intervals.length) throw new PracticeError('invalid_review_stage');
  let next: string;
  if (outcome !== 'independent') next = addDays(day, retry);
  else if (!item.next_review) { stage = 0; next = addDays(day, intervals[0]!); }
  else if (day < item.next_review) next = item.next_review;
  else { stage = Math.min(stage + 1, intervals.length - 1); next = addDays(day, intervals[stage]!); }
  return { stage, next_review: next, last_review: day, review_count: item.review_count + 1 };
}

/** Private note state lives only in S3. Bundled documents contain public workflow definitions. */
export class Practice {
  constructor(private readonly store: NoteStore, private readonly settings: Settings, private readonly owner: string,
    private readonly signal: AbortSignal, private readonly dependencies: { writer?: NoteWriter; now?: () => Date } = {}) {}
  private key(path: string) { return keyFor(this.settings.prefix, validPath(path)); }
  private today() { return calendarDay(this.settings.practice.timeZone, this.dependencies.now?.() ?? new Date()); }
  async read(path: string) {
    const value = await this.store.read(this.key(path), 0, 65536, undefined, this.signal);
    if (value.total > value.bytes.length) throw new PracticeError('practice_note_too_large');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes); }
    catch { throw new NoteError('invalid_utf8'); }
    return { text, revision: value.etag };
  }
  private async config(domain?: z.infer<typeof domainSchema>) {
    if (!this.settings.practice.enabled) throw new PracticeError('practice_disabled');
    const note = await this.read('system/modules/practice-review/module.md');
    const config = moduleSchema.parse(parseNote(note.text).metadata);
    if (!config.enabled) throw new PracticeError('practice_module_disabled');
    return { ...config, time_limit: domain === undefined ? undefined : await this.checkDomain(config, domain) };
  }
  private async checkDomain(config: ModuleConfig, domain: PracticeDomain) {
    const definition = practiceDomains[domainSchema.parse(domain)];
    if (config.practice_flows[domain] !== definition.flow) throw new PracticeError('workflow_mapping_changed_refresh_required');
    const limit = z.number().positive().max(240).safeParse(config.review_time_limits[domain]);
    if (!limit.success) throw new PracticeError('invalid_review_time_limit');
    const guard = await this.read(definition.module);
    const enabled = parseNote(guard.text).metadata.enabled;
    if (typeof enabled !== 'boolean') throw new PracticeError('invalid_domain_module');
    if (!enabled) throw new PracticeError('domain_module_disabled');
    return limit.data;
  }
  private async domainAvailability(config: ModuleConfig, domain: PracticeDomain): Promise<DomainAvailability> {
    const definition = { domain, label: practiceDomains[domain].label };
    try {
      return { ...definition, status: 'enabled', time_limit: await this.checkDomain(config, domain) };
    } catch (error) {
      // Cancellation and unexpected implementation failures must retain their semantics.
      this.signal.throwIfAborted();
      if (!(error instanceof PracticeError || error instanceof NoteError)) throw error;
      return { ...definition, status: error.code === 'domain_module_disabled' ? 'disabled' : 'unavailable', reason: error.code };
    }
  }
  private workflowMetadata(config: ModuleConfig) {
    return { domains: domainSchema.options, source_commit: bundle.sourceCommit,
      intervals: config.interval_days, retry_days: config.retry_days,
      today: this.today(), time_zone: this.settings.practice.timeZone, writes_enabled: this.settings.practice.writesEnabled,
      adapter: bundle.adapter };
  }
  private readyWorkflow(config: ModuleConfig, domain: PracticeDomain, timeLimit: number) {
    const definition = practiceDomains[domain];
    return { ...this.workflowMetadata(config), status: 'ready' as const, availability: 'complete' as const,
      selected_domain: domain, available_domains: [{ domain, label: definition.label }], unavailable_domains: [] as DomainAvailability[],
      entry: bundle.entry.replaceAll('{{domain}}', domain).replaceAll('{{label}}', definition.label).replaceAll('{{flow}}', definition.flow),
      documents: practiceDocuments(domain), time_limits: { [domain]: timeLimit } };
  }
  async workflow(domain?: PracticeDomain) {
    if (domain !== undefined) domainSchema.parse(domain);
    const config = await this.config();
    if (domain !== undefined) return this.readyWorkflow(config, domain, await this.checkDomain(config, domain));
    // The registry bounds discovery. Shared config is read once; no learner data is read.
    const states = await Promise.all(domainSchema.options.map(value => this.domainAvailability(config, value)));
    this.signal.throwIfAborted();
    const available = states.filter(state => state.status === 'enabled');
    const unavailable = states.filter(state => state.status !== 'enabled');
    const availability = unavailable.some(state => state.status === 'unavailable') ? 'partial' as const : 'complete' as const;
    if (available.length === 1 && availability === 'complete') {
      const only = available[0]!;
      return { ...this.readyWorkflow(config, only.domain, only.time_limit), unavailable_domains: unavailable };
    }
    return { ...this.workflowMetadata(config), status: available.length ? 'overview' as const : 'unavailable' as const, availability,
      selected_domain: null, available_domains: available.map(({ domain, label }) => ({ domain, label })), unavailable_domains: unavailable,
      entry: bundle.overview, documents: sharedPracticeDocuments,
      time_limits: Object.fromEntries(available.map(state => [state.domain, state.time_limit])) };
  }
  async instruction(path: string, offset: number) {
    const doc = documents[path];
    if (!doc || !path.endsWith('.md') || offset > doc.text.length) throw new PracticeError('unknown_practice_instruction');
    const domain = domainSchema.options.find(domain => practiceDocuments(domain).includes(path));
    if (!domain) throw new PracticeError('unknown_practice_instruction');
    await this.config(sharedPracticeDocuments.includes(path) ? undefined : domain);
    const text = doc.text.slice(offset, offset + 12000);
    return { path, text, source_commit: bundle.sourceCommit, source_sha256: doc.sha256, offset, complete: offset + text.length >= doc.text.length,
      ...(offset + text.length < doc.text.length ? { next_offset: offset + text.length } : {}) };
  }
  private async item(id: string, forQueue = false) {
    const path = prefix + slugSchema.parse(id) + '.md';
    const note = await this.read(path), parsed = parseNote(note.text), item = itemSchema.parse(parsed.metadata);
    if (item.id !== id) throw new PracticeError('review_id_mismatch');
    if (!forQueue && !domainSchema.safeParse(item.domain).success) throw new PracticeError('unsupported_practice_domain');
    return { ...note, ...parsed, item, path };
  }
  async reviews(input: z.infer<typeof listReviewsSchema>) {
    domainSchema.parse(input.domain);
    await this.config(input.domain);
    const day = this.today(), context = createHash('sha256').update(JSON.stringify([this.owner, this.settings.bucket, this.settings.prefix, day, input.domain])).digest('hex');
    const decoded = input.cursor ? decodeCursor(input.cursor, z.strictObject({ context: z.string(), token: z.string().min(1).max(4096) })) : undefined;
    if (decoded && decoded.context !== context) throw new NoteError('invalid_cursor');
    const page = await this.store.list(this.settings.prefix + prefix, 20, decoded?.token, this.signal);
    if (page.notes.length + page.folders.length > 20) throw new PracticeError('invalid_queue_page');
    const queue: Record<'overdue' | 'today' | 'unstarted' | 'upcoming', z.infer<typeof summarySchema>[]> = { overdue: [], today: [], unstarted: [], upcoming: [] };
    const rows: z.infer<typeof summarySchema>[] = [];
    // At most four reads at once and twenty objects in this invocation.
    for (let index = 0; index < page.notes.length; index += 4) {
      const chunk = page.notes.slice(index, index + 4);
      const summaries = await Promise.all(chunk.map(async note => {
        const name = note.key.slice((this.settings.prefix + prefix).length);
        if (note.key !== this.settings.prefix + prefix + name || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(name)) throw new PracticeError('invalid_review_path');
        const value = await this.item(name.slice(0, -3), true);
        return summarySchema.parse(value.item);
      }));
      rows.push(...summaries.filter(item => item.domain === input.domain && item.status === 'active'));
    }
    rows.sort((a, b) => (a.next_review ?? '').localeCompare(b.next_review ?? '') || a.id.localeCompare(b.id));
    for (const row of rows) queue[row.next_review === null ? 'unstarted' : row.next_review < day ? 'overdue' : row.next_review === day ? 'today' : 'upcoming']!.push(row);
    return { date: day, time_zone: this.settings.practice.timeZone, domain: input.domain, ...queue, complete: !page.next,
      ordering: 'this_page_only', ...(page.next ? { nextCursor: encodeCursor({ context, token: page.next }) } : {}) };
  }
  async review(id: string, includeHistory = false) {
    const note = await this.item(id); await this.config(domainSchema.parse(note.item.domain));
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    return { ...summarySchema.parse(note.item), prompt: note.item.prompt, source: note.item.source ?? null,
      revision: note.revision, ...(includeHistory ? { history: note.body } : {}) };
  }
  private async put(path: string, value: string, revision?: string) {
    if (!this.settings.practice.writesEnabled || !this.dependencies.writer) throw new PracticeError('practice_writes_disabled');
    if (Buffer.byteLength(value) > 65536) throw new PracticeError('practice_note_too_large');
    return this.dependencies.writer.put(this.key(path), value, revision, this.signal);
  }
  async add(input: z.infer<typeof addReviewSchema>) {
    domainSchema.parse(input.domain);
    await this.config(input.domain);
    const metadata = { id: input.id, domain: input.domain, title: input.title.trim(), status: 'active', prompt: input.prompt,
      review_count: 0, stage: 0, last_review: null, next_review: null, attempt_ids: [], ...(input.source ? { source: input.source } : {}) };
    const body = `# ${metadata.title.replace(/[\r\n]/gu, ' ')}\n\n${input.review_focus ? '## Review focus\n\n' + input.review_focus + '\n\n' : ''}## Practice history\n`;
    try { await this.put(prefix + input.id + '.md', serialize(metadata, body)); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      const existing = await this.item(input.id);
      if (existing.item.domain !== input.domain || existing.item.title !== metadata.title) throw new PracticeError('review_id_conflict');
      return { ...summarySchema.parse(existing.item), created: false, revision: existing.revision };
    }
    return { ...summarySchema.parse(metadata), created: true };
  }
  async record(input: z.infer<typeof recordReviewSchema>) {
    const note = await this.item(input.id), config = await this.config(domainSchema.parse(note.item.domain));
    if (note.item.status !== 'active') throw new PracticeError('review_archived');
    if (note.item.attempt_ids.includes(input.attempt_id)) return { ...summarySchema.parse(note.item), recorded: false };
    if (input.completed_on > this.today()) throw new PracticeError('review_date_is_in_future');
    if (input.revision !== note.revision) throw new PracticeError('revision_conflict');
    const schedule = nextSchedule(note.item, input.outcome, input.completed_on, config.interval_days, config.retry_days);
    const metadata = { ...note.metadata, ...schedule, last_outcome: input.outcome, attempt_ids: [...note.item.attempt_ids, input.attempt_id] };
    let entry = `\n\n### ${input.completed_on} · Round ${schedule.review_count}\n\n**${input.outcome}** · Next review ${schedule.next_review}\n\n#### My reflection\n\n${input.reflection}\n`;
    if (input.submission) entry += `\n#### Submission\n\n${input.submission}\n`;
    if (input.observations) entry += `\n#### Feedback\n\n${input.observations}\n`;
    await this.put(note.path, serialize(metadata, note.body + entry), note.revision);
    return { ...summarySchema.parse(metadata), recorded: true };
  }
  async readNote(path: string) {
    await this.config(practiceNoteDomain(path));
    return { path, ...await this.read(path) };
  }
  async designTemplate(input: z.infer<typeof designSessionSchema>) {
    await this.config('system-design');
    return designSessionTemplate(input, this.today());
  }
  async createNote(path: string, content: string) {
    await this.config(validatePracticeWritePath(path));
    await this.put(path, content);
    return { path, created: true };
  }
  async updateNote(path: string, revision: string, edits: { old: string; replacement: string }[]) {
    await this.config(validatePracticeWritePath(path));
    const note = await this.read(path);
    if (note.revision !== revision) throw new PracticeError('revision_conflict');
    let result = note.text;
    for (const edit of edits) {
      const start = result.indexOf(edit.old);
      if (start < 0 || result.indexOf(edit.old, start + 1) >= 0) throw new PracticeError('edit_anchor_not_unique');
      result = result.slice(0, start) + edit.replacement + result.slice(start + edit.old.length);
    }
    await this.put(path, result, revision); return { path, updated: true };
  }
}
