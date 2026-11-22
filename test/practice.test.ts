import { createHash } from 'node:crypto';
import LZString from 'lz-string';
import { parse } from 'yaml';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import bundle from '../workflows/practice.json' with { type: 'json' };
import { calendarDay, nextSchedule, Practice, recordReviewSchema, validatePracticeWritePath } from '../src/practice.js';
import { NoteError } from '../src/paths.js';
import type { NoteStore, NoteWriter, WriteCondition } from '../src/note-store.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { reviewSummarySchema } from '../src/practice-schema.js';
import { practiceSkill } from '../src/practice-tools.js';
import type { IndexedReview, ReviewIndex, SessionIndex } from '../src/review-index.js';
import { owner, runtimeSettings } from './runtime-fixtures.js';

const root = 'Vault/';
const items = root + 'Learning/Practice/Review/Items/';
const configPath = root + 'system/modules/practice-review/module.md';
const moduleText = bundle.documents['system/modules/practice-review/module.md'].text;
const now = () => new Date('2026-11-14T02:00:00Z');
const settings = (writesEnabled = true) => runtimeSettings({ practice: { enabled: true, writesEnabled, timeZone: 'Australia/Brisbane' } });
const item = { id: 'lc-1071', domain: 'algorithm' as const, title: 'GCD of strings', status: 'active' as const,
  review_count: 0, stage: 0, last_review: null as string | null, next_review: null as string | null };
class PracticeStore implements NoteStore, NoteWriter {
  files = new Map<string, string>([[configPath, moduleText],
    ...['algorithm', 'system-design'].map(domain => [root + `system/modules/${domain}/module.md`, '---\nenabled: true\n---\n'] as [string, string])]);
  reads: string[] = []; writes: string[] = []; lists: { prefix: string; limit: number }[] = []; serial = 0;
  beforePut?: (key: string) => void;
  tag(key: string) { return '"' + createHash('sha256').update(this.files.get(key) ?? '').digest('hex') + '"'; }
  async list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted(); this.lists.push({ prefix, limit });
    const keys = [...this.files.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).sort();
    const start = Number(cursor ?? 0); const page = keys.slice(start, start + limit);
    return { folders: [], notes: page.map(key => ({ key, size: Buffer.byteLength(this.files.get(key)!) })), next: keys.length > start + limit ? String(start + limit) : undefined };
  }
  async read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted(); this.reads.push(key);
    if (!this.files.has(key) || (etag && etag !== this.tag(key))) throw new NoteError('note_unavailable');
    const data = Buffer.from(this.files.get(key)!); return { bytes: data.subarray(offset, offset + length), total: data.length, etag: this.tag(key) };
  }
  async put(key: string, text: string, condition: WriteCondition, signal: AbortSignal) {
    signal.throwIfAborted(); this.beforePut?.(key);
    // Practice saves are always conditional; an unconditional write is a defect.
    if (condition === 'any') throw Error('unconditional practice write');
    if (typeof condition === 'object' ? !this.files.has(key) || this.tag(key) !== condition.revision : this.files.has(key)) throw new NoteError('revision_conflict');
    this.files.set(key, text); this.writes.push(key); return this.tag(key);
  }
}
/** An index built from the fixture notes. snapshot() freezes it to model indexer lag. */
class FileIndex implements ReviewIndex {
  frozen?: IndexedReview[]; queries: string[] = []; failure?: Error;
  constructor(private readonly store: PracticeStore) {}
  sessions: Awaited<ReturnType<SessionIndex['unfinishedSessions']>> = [];
  async unfinishedSessions() { return this.sessions; }
  current() {
    return [...this.store.files].filter(([key]) => key.startsWith(items) && !key.slice(items.length).includes('/')).flatMap(([key, text]) => {
      const row = reviewSummarySchema.safeParse(parseFrontmatter(text)?.metadata);
      return row.success ? [{ ...row.data, revision: this.store.tag(key) }] : [];
    });
  }
  snapshot() { this.frozen = this.current(); }
  async activeReviews(domain: string, signal: AbortSignal) {
    signal.throwIfAborted(); this.queries.push(domain);
    if (this.failure) throw this.failure;
    return (this.frozen ?? this.current()).filter(row => row.domain === domain && row.status === 'active');
  }
}
function setup(writes = true) {
  const store = new PracticeStore(), index = new FileIndex(store);
  const practice = new Practice(store, index, settings(writes), AbortSignal.timeout(10000), { now, writer: store });
  return { store, practice, index };
}
const request = { id: item.id, domain: item.domain, title: item.title, prompt: 'Given two strings, find their greatest common divisor.', review_focus: 'Private post-attempt cue' };
const designRequest = { id: 'sysd-url-shortener', domain: 'system-design' as const, title: 'Design a URL shortener',
  prompt: 'Design a service that creates short links and redirects requests. Agree on scale and requirements.', review_focus: 'Compare collision handling after submission.' };
async function seeded() { const env = setup(); await env.practice.add(request); return env; }
function attempt(revision: string, extra: object = {}) { return recordReviewSchema.parse({ id: item.id, revision,
  attempt_id: 'attempt-001', outcome: 'independent', reflection: 'I checked string concatenation first.', completed_on: '2026-11-14', ...extra }); }

describe('canonical spaced review policy', () => {
  it.each([
    { name: 'first independent completion', prior: {}, outcome: 'independent', date: '2026-11-14', stage: 0, due: '2026-11-15' },
    { name: 'due independent completion', prior: { stage: 0, next_review: '2026-11-14', last_review: '2026-11-13' }, outcome: 'independent', date: '2026-11-14', stage: 1, due: '2026-11-17' },
    { name: 'overdue independent completion', prior: { stage: 1, next_review: '2026-11-10' }, outcome: 'independent', date: '2026-11-14', stage: 2, due: '2026-11-21' },
    { name: 'early extra practice', prior: { stage: 2, next_review: '2026-11-20' }, outcome: 'independent', date: '2026-11-14', stage: 2, due: '2026-11-20' },
    { name: 'assisted completion', prior: { stage: 3, next_review: '2026-11-14' }, outcome: 'assisted', date: '2026-11-14', stage: 3, due: '2026-11-15' },
    { name: 'incomplete round', prior: { stage: 1 }, outcome: 'incomplete', date: '2026-11-14', stage: 1, due: '2026-11-15' },
    { name: 'final stage repeats without archiving', prior: { stage: 4, next_review: '2026-11-14' }, outcome: 'independent', date: '2026-11-14', stage: 4, due: '2027-01-13' },
    { name: 'month boundary', prior: {}, outcome: 'independent', date: '2026-12-31', stage: 0, due: '2027-01-01' },
  ])('$name', ({ prior, outcome, date, stage, due }) => {
    expect(nextSchedule({ ...item, ...prior }, outcome, date, [1, 3, 7, 14, 60], 1)).toEqual({ stage, next_review: due, last_review: date, review_count: 1, status: 'active' });
  });
  it('archives an on-time independent final round when enabled', () => {
    const final = { ...item, stage: 4, review_count: 5, last_review: '2026-09-15', next_review: '2026-11-14' };
    expect(nextSchedule(final, 'independent', '2026-11-16', [1, 3, 7, 14, 60], 1, true)).toEqual({
      stage: 4, next_review: null, last_review: '2026-11-16', review_count: 6, status: 'archived', archived_on: '2026-11-16' });
    expect(nextSchedule({ ...final, stage: 3 }, 'independent', '2026-11-14', [1, 3, 7, 14, 60], 1, true)).toMatchObject({ stage: 4, next_review: '2027-01-13', status: 'active' });
  });
  it.each(['assisted', 'incomplete'])('retries an %s final round without archiving', outcome => {
    const final = { ...item, stage: 4, next_review: '2026-11-14' };
    expect(nextSchedule(final, outcome, '2026-11-14', [1, 3, 7, 14, 60], 1, true)).toMatchObject({ stage: 4, next_review: '2026-11-15', status: 'active' });
  });
  it('keeps early final-stage practice scheduled instead of archiving', () => {
    expect(nextSchedule({ ...item, stage: 4, next_review: '2026-12-31' }, 'independent', '2026-11-14', [1, 3, 7, 14, 60], 1, true))
      .toMatchObject({ stage: 4, next_review: '2026-12-31', status: 'active' });
  });
  it('uses the vault calendar rather than UTC and handles daylight saving', () => {
    expect(calendarDay('Australia/Brisbane', new Date('2026-11-14T15:00:00Z'))).toBe('2026-11-15');
    expect(calendarDay('America/New_York', new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
  });
  it('uses configured intervals and refuses invalid historical stages/dates', () => {
    expect(nextSchedule(item, 'independent', '2026-11-14', [2, 5], 3).next_review).toBe('2026-11-16');
    expect(() => nextSchedule({ ...item, stage: 4 }, 'independent', '2026-11-14', [1], 1)).toThrow('invalid_review_stage');
    expect(() => nextSchedule({ ...item, last_review: '2026-11-15' }, 'assisted', '2026-11-14', [1], 1)).toThrow('precedes');
  });
});

describe('practice storage behavior', () => {
  it('routes each domain to its own live mapping, time limit and guard', async () => {
    const { store, practice } = setup();
    const workflow = await practice.workflow('system-design');
    expect(workflow).toMatchObject({ selected_domain: 'system-design', time_limits: { 'system-design': 45 } });
    expect(workflow.time_limits).not.toHaveProperty('algorithm');
    expect(workflow.entry).toContain('# System Design practice'); expect(workflow.entry).not.toContain('{{');
    expect(workflow.documents).toContain('.agents/skills/sysd-solve/SKILL.md');
    expect(workflow.documents).not.toContain('.agents/skills/algo-solve/SKILL.md');
    expect(store.reads).toEqual([configPath, root + 'system/modules/system-design/module.md']);
    const path = 'Learning/Practice/System-Design/Log/2026-11-14.md';
    store.files.set(root + 'system/modules/algorithm/module.md', '---\nenabled: false\n---\n');
    await practice.createNote(path, '# Design log\n');
    await expect(practice.workflow()).resolves.toMatchObject({ status: 'ready', selected_domain: 'system-design' });
    store.files.set(root + 'system/modules/system-design/module.md', '---\nenabled: false\n---\n');
    await expect(practice.designTemplate({ topic: 'URL shortener', short_topic: 'URL-Shortener' })).rejects.toThrow('domain_module_disabled');
    await expect(practice.readNote(path)).rejects.toThrow('domain_module_disabled');
    await expect(practice.add(designRequest)).rejects.toThrow('domain_module_disabled');
    await expect(practice.instruction('.agents/skills/sysd-solve/SKILL.md', 0)).rejects.toThrow('domain_module_disabled');
    expect(store.writes).toEqual([root + path]);
  });
  it('fails closed for a changed or missing System Design mapping without blocking Algorithm', async () => {
    const { store, practice } = setup();
    store.files.set(configPath, moduleText.replace('.agents/skills/sysd-solve/SKILL.md', 'unexpected.md'));
    await expect(practice.workflow('system-design')).rejects.toThrow('mapping_changed');
    await expect(practice.workflow('algorithm')).resolves.toMatchObject({ status: 'ready', selected_domain: 'algorithm' });
    store.files.set(configPath, moduleText.replace('  system-design: 45\n', ''));
    await expect(practice.workflow('system-design')).rejects.toThrow('invalid_review_time_limit');
    await expect(practice.workflow('algorithm')).resolves.toMatchObject({ status: 'ready', selected_domain: 'algorithm' });
    store.files.set(configPath, moduleText.replace('  system-design: 45\n', '  system-design: invalid\n'));
    await expect(practice.workflow('system-design')).rejects.toThrow('invalid_review_time_limit');
    await expect(practice.workflow('algorithm')).resolves.toMatchObject({ status: 'ready', selected_domain: 'algorithm' });
    expect(store.writes).toHaveLength(0);
  });
  it('returns one domain\'s complete queue from the index without listing S3', async () => {
    const { store, practice, index } = setup();
    await practice.add(request);
    for (let i = 0; i < 21; i++) await practice.add({ ...designRequest, id: `sysd-${String(i).padStart(2, '0')}` });
    const design = await practice.reviews({ domain: 'system-design' });
    expect(design.complete).toBe(true); expect(design).not.toHaveProperty('nextCursor');
    expect(design.unstarted.map(row => row.id)).toEqual(Array.from({ length: 21 }, (_, i) => `sysd-${String(i).padStart(2, '0')}`));
    expect((await practice.reviews({ domain: 'algorithm' })).unstarted.map(row => row.id)).toEqual([item.id]);
    expect(index.queries).toEqual(['system-design', 'algorithm']); expect(store.lists).toEqual([]);
    store.files.set(root + 'system/modules/system-design/module.md', '---\nenabled: false\n---\n');
    await expect(practice.reviews({ domain: 'system-design' })).rejects.toThrow('domain_module_disabled');
    await expect(practice.review('sysd-00')).rejects.toThrow('domain_module_disabled');
    await expect(practice.record(attempt(store.tag(items + 'sysd-00.md'), { id: 'sysd-00' }))).rejects.toThrow('domain_module_disabled');
  });
  it('returns canonical workflow definitions and honors live module guards', async () => {
    const { store, practice } = setup(); const result = await practice.workflow('algorithm');
    expect(result.domains).toEqual(['algorithm', 'system-design']); expect(result.selected_domain).toBe('algorithm');
    expect(result.source_commit).toBe(bundle.sourceCommit); expect(result.intervals).toEqual([1, 3, 7, 14, 60]);
    let document = await practice.instruction('.agents/skills/algo-solve/SKILL.md', 0);
    let text = document.text;
    while (document.next_offset !== undefined) {
      document = await practice.instruction(document.path, document.next_offset); text += document.text;
    }
    expect(text).toBe(bundle.documents['.agents/skills/algo-solve/SKILL.md'].text); expect(store.writes).toHaveLength(0);
    store.files.set(configPath, moduleText.replace('enabled: true', 'enabled: false'));
    await expect(practice.workflow()).rejects.toThrow('practice_module_disabled');
  });
  it('rejects changed mappings and disabled domains before domain actions', async () => {
    const { store, practice } = setup();
    store.files.set(configPath, moduleText.replace('.agents/skills/algo-solve/SKILL.md', 'elsewhere.md'));
    await expect(practice.add(request)).rejects.toThrow('mapping_changed'); expect(store.writes).toHaveLength(0);
    store.files.set(configPath, moduleText); store.files.set(root + 'system/modules/algorithm/module.md', '---\nenabled: false\n---\n');
    await expect(practice.add(request)).rejects.toThrow('domain_module_disabled');
  });
  it('adds a create-only unstarted review, without replacing an existing item', async () => {
    const { store, practice } = setup(); expect(await practice.add(request)).toMatchObject({ created: true, next_review: null, review_count: 0 });
    const first = store.files.get(items + item.id + '.md');
    expect(await practice.add(request)).toMatchObject({ created: false }); expect(store.files.get(items + item.id + '.md')).toBe(first);
    await expect(practice.add({ ...request, title: 'Different object' })).rejects.toThrow('review_id_conflict');
  });
  it('keeps cold prompts free of old solutions, focus and reflections', async () => {
    const { practice } = await seeded(); const prompt = await practice.review(item.id);
    await practice.record(attempt(prompt.revision));
    const cold = await practice.review(item.id); expect(cold).not.toHaveProperty('history');
    expect(JSON.stringify(cold)).not.toContain('Private post-attempt cue'); expect(JSON.stringify(cold)).not.toContain('concatenation');
    expect((await practice.review(item.id, true)).history).toContain('Private post-attempt cue');
  });
  it('preserves the original body and unknown frontmatter while recording exactly once', async () => {
    const { store, practice } = await seeded(); const path = items + item.id + '.md';
    store.files.set(path, store.files.get(path)!.replace('domain: algorithm', 'domain: algorithm\ncustom_field: retained') + '\n历史记录\n');
    const before = await practice.review(item.id), oldBody = store.files.get(path)!.split('---\n').slice(2).join('---\n');
    const payload = attempt(before.revision);
    expect(await practice.record(payload)).toMatchObject({ recorded: true, review_count: 1, next_review: '2026-11-15' });
    const saved = store.files.get(path)!; expect(saved).toContain(oldBody); expect(saved).toContain('custom_field: retained');
    expect(saved).toContain(payload.reflection); expect(saved).toContain('历史记录');
    expect(await practice.record(payload)).toMatchObject({ recorded: false, review_count: 1 }); expect(store.files.get(path)).toBe(saved);
  });
  it('archives a passed final round, records it and removes it from the queue', async () => {
    const { store, practice } = await seeded(); const path = items + item.id + '.md';
    store.files.set(configPath, moduleText.replace(/^archive_after_final: .*\n/mu, '').replace('retry_days: 1\n', 'retry_days: 1\narchive_after_final: true\n'));
    store.files.set(path, store.files.get(path)!.replace('stage: 0', 'stage: 4').replace('review_count: 0', 'review_count: 5')
      .replace('last_review: null', 'last_review: 2026-09-15').replace('next_review: null', 'next_review: 2026-11-14'));
    const prompt = await practice.review(item.id);
    expect(await practice.record(attempt(prompt.revision))).toMatchObject({ recorded: true, status: 'archived', next_review: null, stage: 4, review_count: 6 });
    const saved = parse(store.files.get(path)!.split('---\n')[1]!);
    expect(saved).toMatchObject({ status: 'archived', archived_on: '2026-11-14', next_review: null, last_review: '2026-11-14' });
    expect(store.files.get(path)).toContain('**independent** · Archived');
    await expect(practice.review(item.id)).rejects.toThrow('review_archived');
    const queue = await practice.reviews({ domain: 'algorithm' });
    expect([...queue.overdue, ...queue.today, ...queue.unstarted, ...queue.upcoming]).toHaveLength(0);
  });
  it('rejects stale writes and preserves a concurrent Obsidian edit', async () => {
    const { store, practice } = await seeded(); const prompt = await practice.review(item.id);
    store.beforePut = key => { store.files.set(key, store.files.get(key)! + '\nUser edit\n'); store.beforePut = undefined; };
    await expect(practice.record(attempt(prompt.revision))).rejects.toThrow('revision_conflict');
    expect(store.files.get(items + item.id + '.md')).toContain('User edit');
    expect((await practice.review(item.id)).review_count).toBe(0);
  });
  it.each([false, true])('keeps multi-day System Design checkpoints separate from scheduling (existing review: %s)', async existing => {
    const store = new PracticeStore();
    let day = '2026-11-12';
    // Each request can construct a fresh service over persisted notes, like Lambda.
    const session = () => new Practice(store, new FileIndex(store), settings(), AbortSignal.timeout(10000),
      { writer: store, now: () => new Date(day + 'T02:00:00Z') });
    if (existing) {
      day = '2026-11-11';
      await session().add(designRequest);
      const review = await session().review(designRequest.id);
      await session().record(attempt(review.revision, { id: designRequest.id, completed_on: day }));
      day = '2026-11-12';
    }
    const draft = await session().designTemplate({ topic: 'Design a URL shortener', short_topic: 'URL-Shortener' });
    for (const file of draft.files) await session().createNote(file.path, file.content);
    const reviewPath = items + designRequest.id + '.md', before = store.files.get(reviewPath);
    const progress = draft.files[0]!;
    let previous = 'Start Step 1: Requirements.';
    for (const [date, next] of [['2026-11-13', 'Resume Step 2: Core Entities.'], ['2026-11-14', 'Resume Step 6: Deep Dives.']]) {
      day = date!;
      const checkpoint = await session().readNote(progress.path);
      await session().updateNote(progress.path, checkpoint.revision, [{ old: previous, replacement: next! }]);
      previous = next!;
      expect(store.files.get(root + progress.path)).toContain('started: 2026-11-12');
      expect(store.files.get(reviewPath)).toBe(before);
      if (existing) expect(await session().review(designRequest.id)).toMatchObject({ next_review: '2026-11-12', review_count: 1 });
      else expect([...store.files.keys()].filter(key => key.startsWith(items))).toEqual([]);
    }
    // The round ends on the 14th; confirmation/save happens on the 15th.
    day = '2026-11-15';
    if (!existing) await session().add(designRequest);
    const completed = await session().review(designRequest.id);
    const payload = attempt(completed.revision, { id: designRequest.id, completed_on: '2026-11-14',
      attempt_id: 'multi-day-design', reflection: 'I separated the redirect path from analytics.' });
    const saved = await session().record(payload);
    expect(saved).toMatchObject({ last_review: '2026-11-14', next_review: existing ? '2026-11-17' : '2026-11-15',
      review_count: existing ? 2 : 1, recorded: true });
    expect(await session().record(payload)).toMatchObject({ recorded: false, next_review: saved.next_review });
  });
  it('records the actual completion date on a later save and rejects future dates', async () => {
    const { practice } = await seeded(); const prompt = await practice.review(item.id);
    expect(await practice.record(attempt(prompt.revision, { completed_on: '2026-11-12' }))).toMatchObject({ last_review: '2026-11-12', next_review: '2026-11-13' });
    await expect(practice.record(attempt((await practice.review(item.id)).revision, { attempt_id: 'future', completed_on: '2026-11-15' }))).rejects.toThrow('future');
  });
  it('confirms due rows against their notes while the index lags a save', async () => {
    const { store, practice, index } = await seeded();
    await practice.add({ ...request, id: 'lc-2000', title: 'Later problem' });
    const later = items + 'lc-2000.md';
    store.files.set(later, store.files.get(later)!.replace('next_review: null', 'next_review: 2026-12-01'));
    index.snapshot();
    const recorded = await practice.record(attempt((await practice.review(item.id)).revision));
    expect(recorded).toMatchObject({ next_review: '2026-11-15' });
    store.reads = [];
    const queue = await practice.reviews({ domain: 'algorithm' });
    // The stale unstarted row is replaced by the saved note; it is not due again.
    expect(queue.unstarted).toEqual([]);
    expect(queue.upcoming.map(row => [row.id, row.next_review])).toEqual([[item.id, '2026-11-15'], ['lc-2000', '2026-12-01']]);
    // Only the unconfirmed row's note is read, besides the module guards.
    expect(store.reads.filter(key => key.startsWith(items))).toEqual([items + item.id + '.md']);
  });
  it('orders due work by date then ID and reports an unavailable index', async () => {
    const { store, practice, index } = setup();
    for (const [id, due] of [['lc-3', '2026-11-14'], ['lc-1', '2026-11-14'], ['lc-2', '2026-11-10'], ['lc-4', null]] as const) {
      await practice.add({ ...request, id });
      if (due) store.files.set(items + id + '.md', store.files.get(items + id + '.md')!.replace('next_review: null', `next_review: ${due}`));
    }
    const queue = await practice.reviews({ domain: 'algorithm' });
    expect(queue.overdue.map(row => row.id)).toEqual(['lc-2']);
    expect(queue.today.map(row => row.id)).toEqual(['lc-1', 'lc-3']);
    expect(queue.unstarted.map(row => row.id)).toEqual(['lc-4']);
    index.failure = Error('ProvisionedThroughputExceededException');
    await expect(practice.reviews({ domain: 'algorithm' })).rejects.toThrow('review_index_unavailable');
  });
  it('keeps cancellation distinct from an unavailable index', async () => {
    const store = new PracticeStore(), index = new FileIndex(store), controller = new AbortController();
    const practice = new Practice(store, index, settings(), controller.signal, { now });
    index.activeReviews = async () => { controller.abort(new Error('client cancelled')); throw controller.signal.reason; };
    await expect(practice.reviews({ domain: 'algorithm' })).rejects.toThrow('client cancelled');
  });
  it('skips other domains in a mixed queue and refuses to read or record their attempts', async () => {
    const { store, practice } = await seeded();
    const algorithmNote = store.files.get(items + item.id + '.md')!;
    for (const domain of ['behavioral']) {
      const id = `other-${domain}`;
      store.files.set(items + id + '.md', algorithmNote.replace('id: lc-1071', `id: ${id}`).replace('domain: algorithm', `domain: ${domain}`));
      await expect(practice.review(id)).rejects.toThrow('unsupported_practice_domain');
      await expect(practice.record(attempt(store.tag(items + id + '.md'), { id }))).rejects.toThrow('unsupported_practice_domain');
    }
    const queue = await practice.reviews({ domain: 'algorithm' });
    expect(queue.complete).toBe(true); expect(queue.unstarted.map(item => item.id)).toEqual([item.id]);
    expect(store.writes).toEqual([items + item.id + '.md']);
  });
  it('discovers both domains without reading learner data or selecting a default', async () => {
    const { store, practice } = setup();
    const workflow = await practice.workflow();
    expect(workflow).toMatchObject({ status: 'overview', availability: 'complete', selected_domain: null,
      available_domains: [{ domain: 'algorithm', label: 'Algorithm' }, { domain: 'system-design', label: 'System Design' }],
      unavailable_domains: [], time_limits: { algorithm: 30, 'system-design': 45 }, writes_enabled: true });
    expect(store.reads).toEqual([configPath, root + 'system/modules/algorithm/module.md', root + 'system/modules/system-design/module.md']);
    expect(store.lists).toEqual([]); expect(store.writes).toEqual([]);
    expect(workflow.documents).toContain('.agents/skills/practice/SKILL.md');
    for (const path of ['.agents/skills/sysd-solve/SKILL.md', '.agents/skills/algo-solve/SKILL.md', 'Learning/Practice/Review/Flows/behavioral.md']) {
      expect(workflow.documents).not.toContain(path);
    }
    expect((await practice.instruction('.agents/skills/practice/SKILL.md', 0)).text).toBe(bundle.documents['.agents/skills/practice/SKILL.md'].text);
    await expect(practice.instruction('Learning/Practice/Review/Flows/behavioral.md', 0)).rejects.toThrow('unknown_practice_instruction');
  });
  it.each(['algorithm', 'system-design'] as const)('auto-enters the sole confirmed enabled domain %s', async domain => {
    const { store, practice } = setup();
    const disabled = domain === 'algorithm' ? 'system-design' : 'algorithm';
    store.files.set(root + `system/modules/${disabled}/module.md`, '---\nenabled: false\n---\n');
    expect(await practice.workflow()).toMatchObject({ status: 'ready', availability: 'complete', selected_domain: domain,
      available_domains: [{ domain }], unavailable_domains: [{ domain: disabled, status: 'disabled', reason: 'domain_module_disabled' }] });
    expect(store.lists).toEqual([]); expect(store.writes).toEqual([]);
  });
  it.each([
    { guard: undefined, reason: 'note_unavailable' },
    { guard: '# Missing frontmatter', reason: 'invalid_practice_note' },
    { guard: '---\nenabled: [\n---\n', reason: 'invalid_practice_note' },
    { guard: '---\nenabled: "false"\n---\n', reason: 'invalid_domain_module' },
    { guard: '---\nname: module\n---\n', reason: 'invalid_domain_module' },
  ])('keeps unreadable/invalid guard $reason distinct from disabled without auto-entry', async ({ guard, reason }) => {
    const { store, practice } = setup(), path = root + 'system/modules/system-design/module.md';
    if (guard === undefined) store.files.delete(path); else store.files.set(path, guard);
    expect(await practice.workflow()).toMatchObject({ status: 'overview', availability: 'partial', selected_domain: null,
      available_domains: [{ domain: 'algorithm' }], unavailable_domains: [{ domain: 'system-design', status: 'unavailable', reason }] });
    expect(store.lists).toEqual([]); expect(store.writes).toEqual([]);
  });
  it.each([
    { from: '.agents/skills/sysd-solve/SKILL.md', to: 'unexpected.md', reason: 'workflow_mapping_changed_refresh_required' },
    { from: '  system-design: 45\n', to: '', reason: 'invalid_review_time_limit' },
  ])('reports invalid mappings and limits as partial: $reason', async ({ from, to, reason }) => {
    const { store, practice } = setup(); store.files.set(configPath, moduleText.replace(from, to));
    expect(await practice.workflow()).toMatchObject({ status: 'overview', availability: 'partial', selected_domain: null,
      unavailable_domains: [{ domain: 'system-design', status: 'unavailable', reason }] });
    await expect(practice.workflow('system-design')).rejects.toThrow(reason);
  });
  it('returns unavailable without queue reads when both domains are disabled or unknown', async () => {
    const { store, practice } = setup();
    for (const domain of ['algorithm', 'system-design']) store.files.set(root + `system/modules/${domain}/module.md`, '---\nenabled: false\n---\n');
    expect(await practice.workflow()).toMatchObject({ status: 'unavailable', availability: 'complete', selected_domain: null,
      available_domains: [], unavailable_domains: [{ status: 'disabled' }, { status: 'disabled' }] });
    store.files.delete(root + 'system/modules/algorithm/module.md');
    expect(await practice.workflow()).toMatchObject({ status: 'unavailable', availability: 'partial', available_domains: [] });
    expect(store.lists).toEqual([]); expect(store.writes).toEqual([]);
  });
  it('reports invalid UTF-8 and storage timeouts as unavailable without masking cancellation', async () => {
    const { store, practice } = setup(), read = store.read.bind(store);
    store.read = async (...args) => args[0].includes('/system-design/')
      ? { bytes: Buffer.from([255]), total: 1, etag: 'revision' } : read(...args);
    expect(await practice.workflow()).toMatchObject({ status: 'overview', availability: 'partial', selected_domain: null,
      unavailable_domains: [{ domain: 'system-design', status: 'unavailable', reason: 'invalid_utf8' }] });
    store.read = async (...args) => { if (args[0].includes('/system-design/')) throw new NoteError('timeout'); return read(...args); };
    expect(await practice.workflow()).toMatchObject({ availability: 'partial', unavailable_domains: [{ reason: 'timeout' }] });
  });
  it('does not turn cancellation or unexpected storage failures into partial availability', async () => {
    const store = new PracticeStore(), controller = new AbortController(), original = store.read.bind(store);
    const practice = new Practice(store, new FileIndex(store), settings(), controller.signal);
    store.read = async (...args) => {
      if (args[0].includes('/algorithm/')) { controller.abort(new Error('cancel discovery')); controller.signal.throwIfAborted(); }
      return original(...args);
    };
    await expect(practice.workflow()).rejects.toThrow('cancel discovery');
    const healthy = setup(), read = healthy.store.read.bind(healthy.store);
    healthy.store.read = async (...args) => { if (args[0].includes('/algorithm/')) throw new Error('unexpected failure'); return read(...args); };
    await expect(healthy.practice.workflow()).rejects.toThrow('unexpected failure');
    expect(store.lists).toEqual([]); expect(healthy.store.lists).toEqual([]);
  });
  it('does not permit private record changes when writes are disabled', async () => {
    const { store, practice } = setup(false); await expect(practice.add(request)).rejects.toThrow('writes_disabled'); expect(store.writes).toHaveLength(0);
  });
  it.each(['system/modules/algorithm/module.md', 'WeRead/a.md', 'Learning/Practice/Algorithm/Patterns/AGENTS.md',
    'Learning/Practice/Algorithm/Patterns/../AGENTS.md', 'Learning/Practice/Review/Items/lc-1.md',
    'Learning/Practice/System-Design/Patterns/Guide.md', 'Learning/Practice/System-Design/Solutions/URL-Shortener/AGENTS.md',
    'Learning/Practice/System-Design/Core Concepts/queues.md', 'Learning/Practice/System-Design/Key Technologies/Redis.md',
    'Learning/Practice/System-Design/Design Patterns/Caching.md', 'Learning/Practice/System-Design/Attachments/diagram.excalidraw.md',
    'Learning/Practice/System-Design/Solutions/progress.md', 'Learning/Practice/System-Design/Solutions/URL-Shortener/nested/progress.md',
    'Learning/Practice/System-Design/Solutions/URL-Shortener/notes.md', 'Learning/Practice/System-Design/Solutions/URL-Shortener/drawing.json.md',
    'Templates/SD Log.md'])('rejects ordinary edits to %s', path => {
    expect(() => validatePracticeWritePath(path)).toThrow();
  });
  it.each(['System-Design/Patterns/Caching.md', 'System-Design/Insights/Read bottleneck.md', 'System-Design/Log/2026-11-14.md',
    'System-Design/Solutions/URL-Shortener-2026-11-14/progress.md', 'System-Design/Solutions/URL-Shortener-2026-11-14/URL-Shortener.excalidraw.md'])('permits conditional data edits to %s', async relative => {
    const { practice } = setup(), path = 'Learning/Practice/' + relative;
    await practice.createNote(path, '# Human note\n');
    const note = await practice.readNote(path);
    await practice.updateNote(path, note.revision, [{ old: '# Human note', replacement: '# Human note\nNew learning' }]);
    expect((await practice.readNote(path)).text).toBe('# Human note\nNew learning\n');
  });
  it('updates only unique anchors and refuses stale or ambiguous note edits', async () => {
    const { store, practice } = setup(); const path = 'Learning/Practice/Algorithm/Log/2026-11-14.md';
    await practice.createNote(path, '# Log\n\nExisting human words.\n'); const read = await practice.readNote(path);
    await practice.updateNote(path, read.revision, [{ old: 'Existing human words.', replacement: 'Existing human words.\nNew observation.' }]);
    expect(store.files.get(root + path)).toContain('Existing human words.');
    await expect(practice.updateNote(path, read.revision, [{ old: '# Log', replacement: '# Wrong' }])).rejects.toThrow('revision_conflict');
    await expect(practice.updateNote(path, (await practice.readNote(path)).revision, [{ old: 'Missing', replacement: 'Wrong' }])).rejects.toThrow('anchor_not_unique');
  });

});

it('offers saved checkpoints on fresh practice entry even with empty queues', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { index, store } = setup();
  const options = settings();
  const handler = createFetchHandler(options, { skills: [practiceSkill(options, index)], store, writer: store, verify: async () => owner });
  const client = new Client({ name: 'resume-practice-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => handler(new Request(input, init)),
    }));
    const enter = async (args = {}) => (await client.callTool({ name: 'practice', arguments: args })).structuredContent;
    for (const topic of ['Bitly', 'Dropbox']) {
      index.sessions.push({ topic, folder: `Learning/Practice/System-Design/Solutions/${topic}-2026-11-21/`, current_step: 'Data Flow' });
      expect(await enter()).toMatchObject({ unfinished_sessions: [...index.sessions] });
    }
    expect(await enter({ domain: 'algorithm' })).not.toHaveProperty('unfinished_sessions');
    index.unfinishedSessions = async () => { throw Error('index unavailable'); };
    expect(await enter()).toMatchObject({ unfinished_sessions: null });
    expect(store.writes).toEqual([]);
  } finally { await client.close(); }
});

it('rejects a topic that can corrupt Excalidraw Markdown through the real MCP client', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store } = setup(), options = settings();
  const client = new Client({ name: 'system-design-topic-test', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, writer: store, verify: async () => owner })(new Request(input, init)),
    }));
    const result = await client.callTool({ name: 'practice_design_template', arguments: {
      topic: 'Design Dropbox\n%%\n## Drawing\n```json\n{}\n```', short_topic: 'Dropbox',
    } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(store.writes).toHaveLength(0);
  } finally { await client.close(); }
});

it('creates, updates and reopens a large editable canvas through MCP', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, index } = setup(), options = settings();
  const path = 'Learning/Practice/System-Design/Solutions/Cache-2026-11-14/Cache.excalidraw.md';
  const handler = createFetchHandler(options, { skills: [practiceSkill(options, index)], store, writer: store,
    verify: async () => owner, verifyScope: async () => owner });
  const client = new Client({ name: 'large-canvas', version: '1' });
  const scene = { type: 'excalidraw', version: 2, elements: Array.from({ length: 11500 }, (_, index) => ({
    id: String(index), type: 'text', x: index, y: index, width: 300, height: 60,
    text: createHash('sha256').update(String(index)).digest('hex'),
  })), appState: {}, files: {} };
  const encode = () => LZString.compressToBase64(JSON.stringify(scene));
  const original = encode();
  expect(original.length).toBeGreaterThan(512 * 1024);
  expect(Buffer.byteLength(JSON.stringify(scene))).toBeGreaterThan(1024 * 1024);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    const content = '## Drawing\n```compressed-json\n' + original + '\n```\n';
    const create = await client.callTool({ name: 'practice_create_note', arguments: { path, content } });
    expect(create.structuredContent).toMatchObject({ created: true });
    const read = await client.callTool({ name: 'practice_read_note', arguments: { path } });
    expect(read.structuredContent).toMatchObject({ text: content });
    scene.elements[0]!.text = 'Final architecture';
    const update = await client.callTool({ name: 'practice_update_note', arguments: {
      path, revision: (read.structuredContent as { revision: string }).revision, edits: [{ old: original, replacement: encode() }],
    } });
    expect(update.structuredContent).toMatchObject({ updated: true });
    const reopened = await client.callTool({ name: 'practice_design_canvas', arguments: { path } });
    expect(reopened.structuredContent).toMatchObject({ drawing: scene });
  } finally { await client.close(); }
});

it('loads and refreshes a saved canvas through the real MCP client without writes or text-summary reconstruction', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store } = setup(false), options = settings(false);
  const path = 'Learning/Practice/System-Design/Solutions/Cache-2026-11-14/Original-name.excalidraw.md';
  const scene = { type: 'excalidraw', version: 2, elements: [
    { id: 'learner-node', type: 'text', x: 100, y: 200, width: 240, height: 30, text: 'Learner cache design' },
  ], files: {} };
  const putScene = () => store.files.set(root + path, `## Text Elements\nStale summary ^old\n\n%%\n## Drawing\n\`\`\`compressed-json\n${LZString.compressToBase64(JSON.stringify(scene))}\n\`\`\`\n%%\n`);
  putScene();
  const client = new Client({ name: 'system-design-canvas-test', version: '1' }); client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, writer: store, verify: async () => owner })(new Request(input, init)),
    }));
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'practice_design_canvas');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const workflow = await client.callTool({ name: 'practice', arguments: { domain: 'system-design' } });
    const entry = (workflow.structuredContent as { entry: string }).entry;
    expect(entry).toContain('before the first interview');
    expect(entry).toContain('Before every coaching turn');
    expect(entry).toContain('Review canvas');
    const uri = 'ui://practice/design-canvas-v10.html';
    expect(tool?._meta?.ui).toEqual({ resourceUri: uri });
    const resource = await client.readResource({ uri });
    expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: expect.stringContaining('Review canvas') });
    expect(resource.contents[0]).toMatchObject({ text: expect.stringMatching(/id="minutes"[^>]*value="120"/u) });
    const earlierCanvas = await client.readResource({ uri: 'ui://practice/design-canvas-v1.html' });
    expect(earlierCanvas.contents[0]).toEqual({ ...resource.contents[0], uri: 'ui://practice/design-canvas-v1.html' });
    expect(entry).toContain('not a substitute for');
    const first = await client.callTool({ name: 'practice_design_canvas', arguments: { path } });
    expect(first.structuredContent).toMatchObject({ path, encoding: 'compressed-json', drawing: scene });
    const revision = (first.structuredContent as { revision: string }).revision;
    scene.elements[0]!.text = 'Revised learner cache design'; putScene();
    const latest = await client.callTool({ name: 'practice_design_canvas', arguments: { path } });
    expect(latest.structuredContent).toMatchObject({ drawing: scene });
    expect((latest.structuredContent as { revision: string }).revision).not.toBe(revision);
    for (const denied of ['Learning/Practice/Algorithm/Log/2026-11-14.md', path.replace('Original-name.excalidraw.md', 'progress.md'),
      'Learning/Practice/System-Design/Attachments/Old.excalidraw.md']) {
      expect((await client.callTool({ name: 'practice_design_canvas', arguments: { path: denied } })).isError).toBe(true);
    }
    store.files.set(root + 'system/modules/system-design/module.md', '---\nenabled: false\n---\n');
    expect((await client.callTool({ name: 'practice_design_canvas', arguments: { path } })).isError).toBe(true);
    expect(store.writes).toHaveLength(0);
    expect(store.lists).toHaveLength(0);
  } finally { await client.close(); }
});

it('supports a System Design session and review through the real MCP client without changing Algorithm records', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { AuthError } = await import('../src/auth.js');
  const { store, practice } = await seeded(), options = settings();
  const algorithm = store.files.get(items + item.id + '.md');
  const client = new Client({ name: 'system-design-user-test', version: '1' });
  client.onerror = () => {};
  let writable = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, writer: store, verify: async () => owner,
        verifyScope: async () => { if (!writable) throw new AuthError(401); return owner; } })(new Request(input, init)),
    }));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const firstRound = 'e8c1dc3a-7cdd-4c93-a420-16278c975ba1';
    const secondRound = 'e8c1dc3a-7cdd-4c93-a420-16278c975ba2';
    const workflow = await call('practice', { domain: 'system-design' });
    expect(workflow.structuredContent).toMatchObject({ selected_domain: 'system-design', time_limits: { 'system-design': 45 } });
    const instructions = await call('practice_instruction', { path: '.agents/skills/sysd-solve/SKILL.md' });
    expect(instructions.isError).not.toBe(true);
    expect(instructions.structuredContent).toMatchObject({ source_commit: bundle.sourceCommit });
    const draft = await call('practice_design_template', { topic: 'Design a URL shortener', short_topic: 'URL-Shortener' });
    const template = z.object({ saved: z.literal(false), files: z.array(z.object({ path: z.string(), content: z.string() })) }).parse(draft.structuredContent);
    expect(store.writes).toHaveLength(1);
    expect((await call('practice_create_note', template.files[0]!)).isError).toBe(true);
    expect(store.writes).toHaveLength(1);
    writable = true;
    for (const file of template.files) {
      expect((await call('practice_create_note', file)).structuredContent).toMatchObject({ created: true });
      const previous = store.files.get(root + file.path);
      expect((await call('practice_create_note', file)).isError).toBe(true);
      expect(store.files.get(root + file.path)).toBe(previous);
    }
    const progress = template.files[0]!;
    const read = await call('practice_read_note', { path: progress.path });
    const revision = z.object({ revision: z.string() }).parse(read.structuredContent).revision;
    const edits = [{ old: 'Start Step 1: Requirements.', replacement: 'Resume Step 2: Core Entities.' }];
    expect((await call('practice_update_note', { path: progress.path, revision, edits })).structuredContent).toMatchObject({ updated: true });
    expect((await call('practice_update_note', { path: progress.path, revision, edits })).isError).toBe(true);
    expect((await call('practice_add_review', designRequest)).structuredContent).toMatchObject({ domain: 'system-design', created: true });
    const prompt = await call('practice_review', { id: designRequest.id });
    expect(JSON.stringify(prompt.structuredContent)).not.toContain('collision handling');
    const reviewRevision = z.object({ revision: z.string() }).parse(prompt.structuredContent).revision;
    const payload = { ...attempt(reviewRevision), id: designRequest.id, attempt_id: secondRound, reflection: 'The redirect read path drives the latency target.', submission: 'My design and tradeoffs.' };
    expect((await call('practice_record_review', payload)).structuredContent).toMatchObject({ recorded: true, domain: 'system-design', next_review: '2026-11-15' });
    expect((await call('practice_record_review', payload)).structuredContent).toMatchObject({ recorded: false, review_count: 1 });
    const row = async (id: string) => (await call('practice_review', { id })).structuredContent;
    const second = await row(designRequest.id);
    expect(second).toMatchObject({ next_round: 2, coaching_mode: 'guided' });
    const secondAttempt = { ...payload, outcome: 'assisted', attempt_id: firstRound, revision: z.object({ revision: z.string() }).parse(second).revision };
    expect((await call('practice_record_review', secondAttempt)).structuredContent).toMatchObject({ recorded: true, next_review: '2026-11-17' });
    expect((await call('practice_record_review', secondAttempt)).structuredContent).toMatchObject({ recorded: false, completed_design_rounds: 2 });
    expect(await row(designRequest.id)).toMatchObject({ next_round: 3, coaching_mode: 'mock_interview' });
    const dropbox = { ...designRequest, id: 'sysd-dropbox', title: 'Design Dropbox' };
    await call('practice_add_review', dropbox);
    expect(await row(dropbox.id)).toMatchObject({ next_round: 1, coaching_mode: 'guided' });
    const feedback = await call('practice_review', { id: designRequest.id, phase: 'feedback' });
    expect(feedback.structuredContent).toMatchObject({ history: expect.stringContaining(payload.reflection) });
    expect((await call('practice_reviews', { domain: 'system-design' })).structuredContent).toMatchObject({ domain: 'system-design', complete: true });
    expect(store.files.get(items + item.id + '.md')).toBe(algorithm);
    for (const path of ['Learning/Practice/System-Design/Patterns/AGENTS.md', 'Learning/Practice/System-Design/Core Concepts/Caching.md']) {
      expect((await call('practice_create_note', { path, content: '# Not allowed' })).isError).toBe(true);
      expect(store.files.has(root + path)).toBe(false);
    }
    expect((await practice.workflow()).selected_domain).toBeNull();
  } finally { await client.close(); }
});

it('exposes and executes the workflow through the real stateless MCP SDK client', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { AuthError } = await import('../src/auth.js');
  const store = new PracticeStore(), logs: unknown[] = [];
  let writableToken = false;
  const options = settings();
  const client = new Client({ name: 'practice-user-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(options.resource), {
    fetch: async (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, writer: store,
      verify: async () => owner, verifyScope: async () => { if (!writableToken) throw new AuthError(401); return owner; },
      log: event => logs.push(event),
    })(new Request(input, init)),
  });
  client.onerror = () => {};
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.some(tool => tool.name === 'practice')).toBe(true);
    expect(tools.map(tool => tool.name)).not.toContain('practice_create_design_session');
    for (const domain of ['behavioral']) {
      for (const name of ['practice', 'practice_reviews', 'practice_add_review']) {
        expect((await client.callTool({ name, arguments: { ...(name === 'practice_add_review' ? request : {}), domain } })).isError).toBe(true);
      }
    }
    expect(store.writes).toHaveLength(0);
    expect(tools.find(tool => tool.name === 'practice_record_review')?._meta?.securitySchemes)
      .toEqual([{ type: 'oauth2', scopes: ['openid', options.scope, `${options.resource}/write`] }]);
    const workflow = await client.callTool({ name: 'practice', arguments: {} });
    expect(workflow.structuredContent).toMatchObject({ status: 'overview', selected_domain: null, source_commit: bundle.sourceCommit });
    const denied = await client.callTool({ name: 'practice_add_review', arguments: request });
    expect(denied.isError).toBe(true); expect(denied._meta?.['mcp/www_authenticate']).toContain('/write'); expect(store.writes).toHaveLength(0);
    writableToken = true;
    expect((await client.callTool({ name: 'practice_add_review', arguments: request })).structuredContent).toMatchObject({ created: true });
    const prompt = await client.callTool({ name: 'practice_review', arguments: { id: item.id } });
    const revision = z.object({ revision: z.string() }).parse(prompt.structuredContent).revision;
    const saved = await client.callTool({ name: 'practice_record_review', arguments: attempt(revision) });
    expect(saved.structuredContent).toMatchObject({ recorded: true, review_count: 1 });
    expect((await client.callTool({ name: 'practice_record_review', arguments: attempt(revision) })).structuredContent).toMatchObject({ recorded: false });
    expect((await client.callTool({ name: 'practice_record_review', arguments: { ...attempt(revision), reflection: '' } })).isError).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(request.prompt); expect(JSON.stringify(logs)).not.toContain('concatenation');
  } finally { await client.close(); }
});

it.each([
  { date: '0000-01-01', valid: false },
  { date: '0000-02-29', valid: false },
  { date: '1900-02-29', valid: false },
  { date: '0001-01-01', valid: true },
  { date: '2000-02-29', valid: true },
  { date: '2024-02-29', valid: true },
])('validates calendar date $date through MCP before persisting', async ({ date, valid }) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, practice } = await seeded(), options = settings();
  const revision = (await practice.review(item.id)).revision;
  const before = new Map(store.files), writesBefore = [...store.writes];
  const client = new Client({ name: 'practice-date-test', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: async (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, writer: store, verify: async () => owner,
        verifyScope: async () => owner })(new Request(input, init)),
    }));
    const review = await client.callTool({ name: 'practice_record_review',
      arguments: { ...attempt(revision), completed_on: date } });
    if (!valid) {
      expect(review.isError).toBe(true);
      expect(store.files).toEqual(before); expect(store.writes).toEqual(writesBefore);
    } else {
      expect(review.isError).not.toBe(true);
      expect(review.structuredContent).toMatchObject({ recorded: true, last_review: date });
      expect(parse(store.files.get(items + item.id + '.md')!.split('---\n')[1]!))
        .toMatchObject({ last_review: date, next_review: date.endsWith('02-29') ? date.slice(0, 4) + '-03-01' : '0001-01-02' });

    }
  } finally { await client.close(); }
});

it('keeps write tools out of the read-only practice catalog', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const store = new PracticeStore(), options = settings(false);
  const client = new Client({ name: 'practice-read-test', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: async (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, writer: store, verify: async () => owner })(new Request(input, init)),
    }));
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toContain('practice_review');
    expect(tools.map(tool => tool.name)).not.toContain('practice_complete_design_round');
    expect(tools).toHaveLength(10); expect(tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    expect((await client.callTool({ name: 'practice_design_template', arguments: { topic: 'Design Dropbox', short_topic: 'Dropbox' } })).structuredContent).toMatchObject({ saved: false });
    expect((await client.callTool({ name: 'practice_add_review', arguments: request })).isError).toBe(true); expect(store.writes).toHaveLength(0);
  } finally { await client.close(); }
});

it('requires an explicit writer capability even when the reader also implements put', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const store = new PracticeStore(), options = settings();
  const client = new Client({ name: 'read-capability-test', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, verify: async () => owner,
        verifyScope: async () => owner })(new Request(input, init)),
    }));
    const response = await client.callTool({ name: 'practice_add_review', arguments: request });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{ type: 'text', text: 'practice_writes_disabled' }]);
    expect(store.writes).toHaveLength(0);
  } finally { await client.close(); }
});

it('starts generic practice with an overview through the real MCP client, then reads each domain queue in one call', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const store = new PracticeStore(), options = settings();
  for (let index = 0; index < 23; index++) {
    const domain = index % 2 ? 'system-design' : 'algorithm';
    const id = `mixed-${String(index).padStart(2, '0')}`;
    store.files.set(items + id + '.md', '---\n' + JSON.stringify({ ...item, id, domain, prompt: 'Neutral prompt',
      next_review: index % 3 ? '2001-01-02' : '2001-01-01' }) + '\n---\nPrivate old solution');
  }
  const before = new Map(store.files);
  const client = new Client({ name: 'practice-overview-user', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { skills: [practiceSkill(options, new FileIndex(store))], store, verify: async () => owner })(new Request(input, init)),
    }));
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'practice_reviews')?.inputSchema.required).toContain('domain');
    expect((await client.callTool({ name: 'practice_reviews', arguments: {} })).isError).toBe(true);
    expect(store.reads).toEqual([]); expect(store.lists).toEqual([]);
    const overview = await client.callTool({ name: 'practice', arguments: {} });
    expect(overview.structuredContent).toMatchObject({ status: 'overview', availability: 'complete', selected_domain: null,
      available_domains: [{ domain: 'algorithm', label: 'Algorithm' }, { domain: 'system-design', label: 'System Design' }] });
    expect(store.reads).toHaveLength(3); expect(store.lists).toEqual([]);
    expect(JSON.stringify(overview.structuredContent)).not.toContain('Private old solution');
    for (const domain of ['algorithm', 'system-design']) {
      const result = await client.callTool({ name: 'practice_reviews', arguments: { domain } });
      const queue = z.object({ domain: z.string(), complete: z.literal(true), overdue: z.array(z.object({ domain: z.string(), next_review: z.string(), id: z.string() })) }).parse(result.structuredContent);
      expect(queue.overdue).toHaveLength(domain === 'algorithm' ? 12 : 11);
      expect(queue.overdue.every(row => row.domain === domain)).toBe(true);
      const order = queue.overdue.map(row => `${row.next_review} ${row.id}`);
      expect(order).toEqual([...order].sort());
      expect(result.structuredContent).not.toHaveProperty('nextCursor');
      expect(JSON.stringify(result.structuredContent)).not.toContain('Private old solution');
      // Cursors no longer exist; the strict input rejects one.
      expect((await client.callTool({ name: 'practice_reviews', arguments: { domain, cursor: 'x' } })).isError).toBe(true);
    }
    expect(store.lists).toEqual([]);
    const selected = await client.callTool({ name: 'practice', arguments: { domain: 'system-design' } });
    expect(selected.structuredContent).toMatchObject({ status: 'ready', selected_domain: 'system-design', time_limits: { 'system-design': 45 } });
    expect(store.files).toEqual(before); expect(store.writes).toEqual([]);
  } finally { await client.close(); }
});

it('projects a legacy two-round guided topic into the first independent review without writing its history', async () => {
  const { store, practice } = setup();
  const key = items + designRequest.id + '.md';
  const fixture = { ...item, ...designRequest, review_count: 2, last_review: '2026-11-22', next_review: '2026-11-23' };
  const history = '### 2026-11-21 · Round 1\n\n**assisted** · Next review 2026-11-22\n\n### 2026-11-22 · 第 2 轮\n\n**提示后完成** · 下次复习 2026-11-23';
  store.files.set(key, '---\n' + JSON.stringify(fixture) + '\n---\n' + history);
  expect(await practice.review(designRequest.id)).toMatchObject({ next_round: 3, coaching_mode: 'mock_interview', next_review: '2026-11-25' });
  expect((await practice.reviews({ domain: 'system-design' })).upcoming[0]).toMatchObject({ next_round: 3, next_review: '2026-11-25' });
  const third = { ...fixture, review_count: 3, stage: 1, last_review: '2026-11-25', next_review: '2026-11-28' };
  store.files.set(key, '---\n' + JSON.stringify(third) + '\n---\n' + history + '\n### 2026-11-25 · Round 3\n\n**independent** · Next review 2026-11-28');
  expect(await practice.review(designRequest.id)).toMatchObject({ next_round: 4, stage: 2, next_review: '2026-12-02' });
  expect(store.writes).toHaveLength(0);
});

it('saves an exact reviewed scene from ChatGPT by receipt and conditionally overwrites a saved drawing', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, index } = setup(), options = settings();
  const path = 'Learning/Practice/System-Design/Solutions/Bitly-2026-11-22/Bitly.excalidraw.md';
  const handler = createFetchHandler(options, { skills: [practiceSkill(options, index)], store, writer: store,
    verify: async () => owner, verifyScope: async () => owner });
  const client = new Client({ name: 'canvas-checkpoint', version: '1' });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { path, ...args } });
  const scene = { type: 'excalidraw', version: 2, elements: [{ id: 'node1234', type: 'text', x: 5, y: 8,
    width: 80, height: 20, text: 'Before\n%%\n## Embedded Files\nBefore' }], appState: { viewBackgroundColor: '#ffffff' }, files: {} };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    const stage = async () => ((await call('practice_stage_canvas', { scene })).structuredContent as { snapshot: string }).snapshot;
    const first = await stage();
    expect(store.files.has(root + path)).toBe(false);
    const created = (await call('practice_save_canvas', { snapshot: first, revision: null })).structuredContent as { revision: string };
    expect(created).toMatchObject({ verified: true, elements: 1 });
    expect(store.files.get(root + path)?.match(/^%%$/gmu)).toHaveLength(2);
    expect((await call('practice_design_canvas', {})).structuredContent).toMatchObject({ drawing: scene });
    scene.elements[0]!.text = 'After\n%%\n## Drawing\n```json\n{}\n```\nFinal design';
    const next = await stage();
    expect((await call('practice_save_canvas', { snapshot: first, revision: created.revision })).isError).toBe(true);
    expect((await call('practice_save_canvas', { snapshot: next, revision: null })).isError).toBe(true);
    expect((await call('practice_save_canvas', { snapshot: next, revision: 'old' })).isError).toBe(true);
    expect((await call('practice_save_canvas', { snapshot: next, revision: created.revision })).structuredContent).toMatchObject({ verified: true });
    expect((await call('practice_design_canvas', {})).structuredContent).toMatchObject({ drawing: scene });
    expect(store.files.get(root + path)).toContain('Final design ^node1234');
    expect(store.files.get(root + path)).not.toContain('Before');
    expect(store.files.get(root + path)?.match(/^%%$/gmu)).toHaveLength(2);
  } finally { await client.close(); }
});
