import { createHash } from 'node:crypto';
import LZString from 'lz-string';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import bundle from '../workflows/practice.json' with { type: 'json' };
import designRounds from './fixtures/design-rounds.json' with { type: 'json' };
import { calendarDay, nextSchedule, Practice, finishRoundSchema, recordReviewSchema, validatePracticeWritePath } from '../src/practice.js';
import { parseObservations, renderProfile, type StoredObservation } from '../src/design-profile.js';
import { NoteError } from '../src/paths.js';
import type { NoteStore, NoteWriter, WriteCondition } from '../src/note-store.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { reviewSummarySchema } from '../src/practice-schema.js';
import { practiceSkill, registerPracticeTools } from '../src/practice-tools.js';
import type { IndexedReview, ReviewIndex, SessionIndex } from '../src/review-index.js';
import { owner, runtimeSettings } from './runtime-fixtures.js';

const root = 'Vault/';
const items = root + 'Learning/Practice/Review/Items/';
const configPath = root + 'system/modules/practice-review/module.md';
const moduleText = bundle.documents['system/modules/practice-review/module.md'].text;
const moduleNote = parseFrontmatter(moduleText)!;
const configuredLimits = z.record(z.string(), z.number()).parse(moduleNote.metadata.review_time_limits);
const mockMinutes = configuredLimits['system-design']!;
function withMockMinutes(minutes?: number | string) {
  const limits: Record<string, number | string> = { ...configuredLimits };
  if (minutes === undefined) delete limits['system-design'];
  else limits['system-design'] = minutes;
  return `---\n${stringify({ ...moduleNote.metadata, review_time_limits: limits })}---\n${moduleNote.body}`;
}

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
    const matching = [...this.files.keys()].filter(key => key.startsWith(prefix));
    const folders = [...new Set(matching.flatMap(key => {
      const slash = key.indexOf('/', prefix.length);
      return slash < 0 ? [] : [key.slice(0, slash + 1)];
    }))];
    const keys = [...folders, ...matching.filter(key => !key.slice(prefix.length).includes('/'))].sort();
    const start = Number(cursor ?? 0); const page = keys.slice(start, start + limit);
    return { folders: page.filter(key => key.endsWith('/')), notes: page.filter(key => !key.endsWith('/')).map(key => ({ key, size: Buffer.byteLength(this.files.get(key)!) })), next: keys.length > start + limit ? String(start + limit) : undefined };
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
  async pendingFinalizations() { return []; }
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
    expect(workflow).toMatchObject({ selected_domain: 'system-design', time_limits: { 'system-design': mockMinutes } });
    expect(workflow.time_limits).not.toHaveProperty('algorithm');
    expect(workflow.entry).toContain('# System Design practice'); expect(workflow.entry).not.toContain('{{');
    expect(workflow.documents).toContain('.agents/skills/sysd-solve/SKILL.md');
    expect(workflow.documents).not.toContain('.agents/skills/algo-solve/SKILL.md');
    expect(store.reads).toEqual([configPath, root + 'system/modules/system-design/module.md']);
    const overrideMinutes = mockMinutes > 1 ? mockMinutes - 1 : mockMinutes + 1;
    store.files.set(configPath, withMockMinutes(overrideMinutes));
    await expect(practice.workflow('system-design')).resolves.toMatchObject({ time_limits: { 'system-design': overrideMinutes } });
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
    store.files.set(configPath, withMockMinutes());
    await expect(practice.workflow('system-design')).rejects.toThrow('invalid_review_time_limit');
    await expect(practice.workflow('algorithm')).resolves.toMatchObject({ status: 'ready', selected_domain: 'algorithm' });
    store.files.set(configPath, withMockMinutes('invalid'));
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
      unavailable_domains: [], time_limits: { algorithm: configuredLimits.algorithm, 'system-design': mockMinutes }, writes_enabled: true });
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
    { config: moduleText.replace('.agents/skills/sysd-solve/SKILL.md', 'unexpected.md'), reason: 'workflow_mapping_changed_refresh_required' },
    { config: withMockMinutes(), reason: 'invalid_review_time_limit' },
  ])('reports invalid mappings and limits as partial: $reason', async ({ config, reason }) => {
    const { store, practice } = setup(); store.files.set(configPath, config);
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
    const ended = { folder: 'Learning/Practice/System-Design/Solutions/Dropbox-2026-11-23/', topic: 'Dropbox', round_completed_on: '2026-11-23' };
    Object.assign(index, { pendingFinalizations: async () => [ended] });
    expect(await enter()).toMatchObject({ pending_finalizations: [ended], unfinished_sessions: [] });
    expect(await enter({ domain: 'system-design' })).toMatchObject({ pending_finalizations: [ended] });
    expect(await enter({ domain: 'algorithm' })).not.toHaveProperty('pending_finalizations');
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
    const uri = 'ui://practice/design-canvas-v12.html';
    expect(tool?._meta?.ui).toEqual({ resourceUri: uri });
    const resource = await client.readResource({ uri });
    expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: expect.stringContaining('Review canvas') });
    expect(resource.contents[0]).toMatchObject({ text: expect.stringContaining('aria-label="Elapsed time">00:00</span>') });
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
    expect(workflow.structuredContent).toMatchObject({ selected_domain: 'system-design', time_limits: { 'system-design': mockMinutes } });
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
    const roundTopic = { ...designRequest, id: 'sysd-dropbox-closeout', title: 'Dropbox' };
    const finish = { topic: roundTopic, progress_path: progress.path, attempt: {
      attempt_id: 'closeout-round', outcome: 'assisted', reflection: 'Chunk uploads can resume.', completed_on: '2026-11-14' } };
    const writesBeforeFinish = store.writes.length;
    expect((await call('practice_finish_round', { topic: roundTopic, attempt: finish.attempt })).isError).toBe(true);
    expect((await call('practice_finish_round', finish)).isError).toBe(true);
    expect(store.writes).toHaveLength(writesBeforeFinish);
    const dropboxDraft = await call('practice_design_template', { topic: 'Dropbox', short_topic: 'Dropbox' });
    const dropboxProgress = z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) }).parse(dropboxDraft.structuredContent).files[0]!;
    expect((await call('practice_create_note', dropboxProgress)).isError).not.toBe(true);
    finish.progress_path = dropboxProgress.path;
    const unfinished = await call('practice_read_note', { path: progress.path });
    expect((await call('practice_update_note', { path: progress.path, revision: z.object({ revision: z.string() }).parse(unfinished.structuredContent).revision,
      edits: [{ old: 'system-design/wip', replacement: 'system-design/done' }] })).isError).toBe(true);
    store.beforePut = key => {
      if (key === root + finish.progress_path && store.files.get(items + roundTopic.id + '.md')?.includes('closeout-round')) {
        throw new NoteError('note_unavailable');
      }
    };
    expect((await call('practice_finish_round', finish)).isError).toBe(true);
    expect(store.files.get(root + finish.progress_path)).toContain('system-design/wip');
    delete store.beforePut;
    for (let retry = 0; retry < 2; retry++) {
      expect((await call('practice_finish_round', finish)).structuredContent).toMatchObject({ verified: true, review_count: 1, next_review: '2026-11-15' });
    }
    expect((await call('practice_read_note', { path: finish.progress_path })).structuredContent).toMatchObject({ text: expect.stringContaining('system-design/done') });
    const algorithmFinish = { topic: { ...request, id: 'lc-closeout' }, attempt: { ...finish.attempt, attempt_id: 'algorithm-closeout' } };
    for (let retry = 0; retry < 2; retry++) {
      expect((await call('practice_finish_round', algorithmFinish)).structuredContent).toMatchObject({ verified: true, review_count: 1 });
    }
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
    expect(tools).toHaveLength(11); expect(tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
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
    expect(selected.structuredContent).toMatchObject({ status: 'ready', selected_domain: 'system-design', time_limits: { 'system-design': mockMinutes } });
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
    // A legacy review can deliver its full scene to chat even when staging failed.
    const missing = await call('practice_save_canvas', { snapshot: 'widget-review-uuid', revision: null });
    expect(missing.isError).toBe(true);
    const recoveryPath = path.replaceAll('Bitly', 'Dropbox');
    const recovered = await call('practice_save_canvas', { path: recoveryPath, scene, revision: null });
    expect(recovered.structuredContent).toMatchObject({ verified: true, elements: 1 });
    expect((await call('practice_design_canvas', { path: recoveryPath })).structuredContent).toMatchObject({ drawing: scene });
    expect((await call('practice_save_canvas', { path: recoveryPath, scene, revision: 'stale' })).isError).toBe(true);
    expect((await call('practice_save_canvas', { path: recoveryPath, scene, snapshot: 'ambiguous', revision: null })).isError).toBe(true);
    const updated = { ...scene, elements: [{ ...scene.elements[0], text: 'Dropbox final edit' }] };
    const recoveryRevision = (recovered.structuredContent as { revision: string }).revision;
    const checkpoint = await call('practice_save_canvas', { path: recoveryPath, scene: updated, revision: recoveryRevision });
    expect(checkpoint.structuredContent).toMatchObject({ verified: true });
    expect((await call('practice_design_canvas', { path: recoveryPath })).structuredContent).toMatchObject({ drawing: updated });
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

it('normalizes upcoming indexed design rows and persists cutover idempotently without changing history', async () => {
  const { store, index } = setup();
  const practice = new Practice(store, index, settings(), AbortSignal.timeout(10000),
    { writer: store, now: () => new Date('2026-11-26T02:00:00Z') });
  const key = items + designRequest.id + '.md';
  const history = ['2026-11-21', '2026-11-22', '2026-11-25'].map((day, i) =>
    `### ${day} · Round ${i + 1}\n\n**assisted** · Next review 2026-11-28`).join('\n\n');
  store.files.set(key, '---\n' + stringify({ ...item, ...designRequest, completed_design_rounds: 3,
    review_count: 3, last_review: '2026-11-25', next_review: '2026-11-28' }) + '---\n' + history);
  index.snapshot();
  expect((await practice.reviews({ domain: 'system-design' })).upcoming[0]).toMatchObject({ next_review: '2026-12-02', stage: 2 });
  expect(await practice.review(designRequest.id)).toMatchObject({ next_review: '2026-12-02', stage: 2 });
  expect(store.writes).toHaveLength(0);
  expect(await practice.recalculateDesignReviews()).toEqual({ updated: 1 });
  expect(parseFrontmatter(store.files.get(key)!)!.metadata).toMatchObject({ next_review: '2026-12-02', stage: 2 });
  expect(parseFrontmatter(store.files.get(key)!)!.body).toBe(history);
  expect(await practice.recalculateDesignReviews()).toEqual({ updated: 0 });
  expect(store.writes).toHaveLength(1);
});

it.each(['assisted', 'incomplete'])('keeps replayed archives terminal after a trailing %s attempt', async outcome => {
  const { store, index, practice } = setup();
  const history = Array.from({ length: 6 }, (_, i) => `### 2026-11-0${i + 1} · Round ${i + 1}\n\n**assisted** · Next review 2026-11-14`).join('\n\n') +
    `\n\n### 2026-11-07 · Round 7\n\n**${outcome}** · Next review 2026-11-14`;
  const key = items + designRequest.id + '.md';
  store.files.set(configPath, moduleText.replace(/^archive_after_final: .*\n/mu, ''));
  store.files.set(key, '---\n' + stringify({ ...item, ...designRequest, review_count: 7,
    last_review: '2026-11-07', next_review: '2026-11-14' }) + '---\n' + history);
  index.snapshot();
  await expect(practice.review(designRequest.id)).rejects.toThrow('review_archived');
  expect(await practice.reviews({ domain: 'system-design' })).toMatchObject({ overdue: [], today: [], upcoming: [], unstarted: [] });
  expect(await practice.recalculateDesignReviews()).toEqual({ updated: 1 });
  expect(parseFrontmatter(store.files.get(key)!)!.metadata).toMatchObject({ status: 'archived', archived_on: '2026-11-06',
    completed_design_rounds: 6, review_count: 7, last_review: '2026-11-07', next_review: null });
  expect(parseFrontmatter(store.files.get(key)!)!.body).toBe(history);
  await expect(practice.record(attempt(store.tag(key), { id: designRequest.id, attempt_id: 'after-archive' }))).rejects.toThrow('review_archived');
  expect(await practice.recalculateDesignReviews()).toEqual({ updated: 0 });
});

it('preserves concurrent edits during cutover', async () => {
  const { store, practice } = setup();
  const key = items + designRequest.id + '.md';
  store.files.set(key, '---\n' + stringify({ ...item, ...designRequest, review_count: 1,
    last_review: '2026-11-01', next_review: '2026-11-14' }) + '---\n### 2026-11-01 · Round 1\n\n**assisted** · Next review 2026-11-14');
  store.beforePut = path => { store.beforePut = undefined; store.files.set(path, store.files.get(path)! + '\nHuman edit'); };
  await expect(practice.recalculateDesignReviews()).rejects.toThrow('revision_conflict');
  expect(store.files.get(key)).toContain('Human edit');
  expect(parseFrontmatter(store.files.get(key)!)!.metadata.next_review).toBe('2026-11-14');
});

it.each(['practice_record_review', 'practice_finish_round'])('executes the shared six-round sample through %s with duplicate and concurrent registration', async name => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, index } = setup(), options = settings();
  store.files.set(configPath, moduleText.replace(/^archive_after_final: .*\n/mu, ''));
  let day = designRounds.rounds[0]!.date;
  const practice = new Practice(store, index, options, AbortSignal.timeout(10000),
    { writer: store, now: () => new Date(day + 'T02:00:00Z') });
  const handler = createFetchHandler(options, { store, writer: store, verify: async () => owner,
    verifyScope: async () => owner, skills: [{ instructions: '', scopes: [],
      register: ({ server, result }) => registerPracticeTools(server, practice, options, result, async () => {}) }] });
  const client = new Client({ name: 'design-round-sample', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    await client.callTool({ name: 'practice_add_review', arguments: designRequest });
    let count = 0;
    for (const step of designRounds.rounds) {
      day = step.date;
      const attempt = { attempt_id: step.attempt_id, outcome: step.outcome,
        completed_on: day, reflection: 'My actual reflection.',
        ...(name === 'practice_finish_round' && step.attempt_id === 'r1' ? { concept_observations: [{
          observation_id: 'sample-cache', concept_id: 'cache.expiry', performance: 'weak',
          summary: 'Left the cache unbounded.', anchor: 'Assessment' }] } : {}),
        ...(step.attempt_id === 'r6' ? { submission: '## Summary\nCache expiry needs work, citing sample-cache from round r1.' } : {}),
      };
      const review = await practice.review(designRequest.id);
      expect(review).toMatchObject({ coaching_mode: step.completed_design_rounds <= 2 ? 'guided' : 'mock_interview',
        summary_required: step.attempt_id === 'r6' });
      const progress_path = `Learning/Practice/System-Design/Solutions/${step.attempt_id}/progress.md`;
      const checkpoint = designRounds.checkpoints.find(entry => entry.attempt_id === step.attempt_id);
      if (checkpoint) {
        day = checkpoint.paused_on;
        const before = store.files.get(items + designRequest.id + '.md');
        expect((await client.callTool({ name: 'practice_create_note', arguments: { path: progress_path,
          content: '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'], round_id: checkpoint.attempt_id,
            started: day }) + '---\nResume the active round.' } })).isError).not.toBe(true);
        const saved = await client.callTool({ name: 'practice_read_note', arguments: { path: progress_path } });
        const revision = z.object({ revision: z.string() }).parse(saved.structuredContent).revision;
        expect((await client.callTool({ name: 'practice_update_note', arguments: { path: progress_path, revision,
          edits: [{ old: 'Resume the active round.', replacement: 'Paused at the end of the day. Resume Deep Dives.' }] } })).isError).not.toBe(true);
        expect(store.files.get(items + designRequest.id + '.md')).toBe(before);
        day = checkpoint.resumed_on;
        const resumed = await client.callTool({ name: 'practice_read_note', arguments: { path: progress_path } });
        const note = parseFrontmatter(z.object({ text: z.string() }).parse(resumed.structuredContent).text)!;
        expect(note.metadata).toMatchObject({ round_id: step.attempt_id, started: checkpoint.paused_on, tags: ['system-design/wip'] });
        expect(note.body).toBe('Paused at the end of the day. Resume Deep Dives.');
        expect(store.files.get(items + designRequest.id + '.md')).toBe(before);
        expect(await practice.review(designRequest.id)).toEqual(review);
      }
      if (name === 'practice_finish_round' && !checkpoint) await practice.createNote(progress_path,
        '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
      if (name === 'practice_record_review' && step.attempt_id === 'r6') await practice.createNote(
        'Learning/Practice/System-Design/Solutions/earlier-evidence/progress.md',
        '---\n' + stringify({ topic: 'Earlier evidence', tags: ['system-design/wip'], round_completed_on: '2026-10-01' }) +
        '---\n```practice-observations\n' + stringify([{ observation_id: 'sample-cache', attempt_id: 'earlier',
          concept_id: 'cache.expiry', performance: 'weak', summary: 'Left the cache unbounded.', anchor: 'Assessment',
          date: '2026-10-01', learner: true }]) + '```\n');
      const args = name === 'practice_finish_round' ? { topic: designRequest, attempt, progress_path } :
        { ...attempt, id: designRequest.id, revision: review.revision };
      const results = await Promise.all([client.callTool({ name, arguments: args }), client.callTool({ name, arguments: args })]);
      expect(results.some(result => !result.isError)).toBe(true);
      count++;
      expect(parseFrontmatter(store.files.get(items + designRequest.id + '.md')!)!.metadata).toMatchObject({
        review_count: count, completed_design_rounds: step.completed_design_rounds,
        stage: step.stage, next_review: step.next_review, status: step.status,
      });
      if (name === 'practice_finish_round' && step.attempt_id === 'r6') {
        const profile = store.files.get(root + 'Learning/Practice/System-Design/Profile.md')!;
        expect(parseObservations(profile).map(row => row.observation_id)).toEqual(['sample-cache']);
        const finalHistory = parseFrontmatter(store.files.get(items + designRequest.id + '.md')!)!.body;
        expect(finalHistory).toContain('citing sample-cache from round r1');
        expect(parseFrontmatter(store.files.get(root + progress_path)!)!.metadata.tags).toEqual(['system-design/done']);
      }
      const retry = await client.callTool({ name, arguments: args });
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent).toMatchObject({ review_count: count, completed_design_rounds: step.completed_design_rounds });
    }
    expect(await practice.reviews({ domain: 'system-design' })).toMatchObject({ overdue: [], today: [], upcoming: [], unstarted: [] });
    await expect(practice.review(designRequest.id)).rejects.toThrow('review_archived');
  } finally { await client.close(); }
});

it.each(['practice_record_review', 'practice_finish_round'])('keeps round six unwritten until the summary cites stored evidence through %s', async name => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, practice, index } = setup(), options = settings();
  await practice.add(designRequest);
  await practice.createNote('Learning/Practice/System-Design/Solutions/earlier-evidence/progress.md',
    '---\n' + stringify({ topic: 'Earlier evidence', tags: ['system-design/wip'], round_completed_on: '2026-10-01' }) +
    '---\n```practice-observations\n' + stringify([{ observation_id: 'sample-cache', attempt_id: 'earlier',
      concept_id: 'cache.expiry', performance: 'weak', summary: 'Left the cache unbounded.', anchor: 'Assessment',
      date: '2026-10-01', learner: true }]) + '```\n');
  const progress = 'Learning/Practice/System-Design/Solutions/final-round/progress.md';
  const retryProgress = 'Learning/Practice/System-Design/Solutions/retry-round/progress.md';
  const session = '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n';
  await practice.createNote(progress, session);
  await practice.createNote(retryProgress, session);
  for (let number = 1; number <= 5; number += 1) {
    const review = await practice.review(designRequest.id);
    await practice.record({ id: designRequest.id, revision: review.revision, attempt_id: `r${number}`, outcome: 'assisted',
      reflection: 'Completed the round.', completed_on: `2026-11-0${number}` });
  }
  const cited = '## Summary\nCache expiry needs work, citing sample-cache from the earlier round.';
  const fresh = { observation_id: 'new-cache', concept_id: 'cache.expiry', performance: 'weak' as const, learner: true,
    summary: 'A new final-round claim.', anchor: 'Assessment' };
  const handler = createFetchHandler(options, { store, writer: store, verify: async () => owner,
    verifyScope: async () => owner, skills: [practiceSkill(options, index)] });
  const client = new Client({ name: 'final-summary', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    const call = async (attempt: Record<string, unknown>, revision?: string, progressPath = progress) => {
      const arguments_ = name === 'practice_finish_round' ? { topic: designRequest, attempt, progress_path: progressPath } :
        { ...attempt, id: designRequest.id, revision: revision ?? (await practice.review(designRequest.id)).revision };
      return client.callTool({ name, arguments: arguments_ });
    };
    const unchanged = async (attempt: Record<string, unknown>) => {
      const before = new Map(store.files), writes = [...store.writes];
      expect((await call(attempt)).isError).toBe(true);
      expect(store.files).toEqual(before);
      expect(store.writes).toEqual(writes);
    };
    await unchanged({ attempt_id: 'r6-missing', reflection: 'Final mock.', completed_on: '2026-11-06' });
    await unchanged({ attempt_id: 'r6-uncited', reflection: 'Final mock.', completed_on: '2026-11-06', submission: '## Summary\nNo stored evidence.' });
    await unchanged({ attempt_id: 'r6-new', reflection: 'Final mock.', completed_on: '2026-11-06', submission: cited, concept_observations: [fresh] });
    const retry = await call({ attempt_id: 'r6-retry', outcome: 'incomplete', reflection: 'Not ready.', completed_on: '2026-11-06' }, undefined, retryProgress);
    expect(retry.isError).not.toBe(true);
    expect(retry.structuredContent).toMatchObject({ status: 'active', completed_design_rounds: 5, review_count: 6 });
    const closed = await call({ attempt_id: 'r6', reflection: 'Final mock.', completed_on: '2026-11-07', submission: cited });
    expect(closed.isError).not.toBe(true);
    expect(closed.structuredContent).toMatchObject({ status: 'archived', completed_design_rounds: 6, next_review: null });
    expect(store.files.get(root + progress)).not.toContain('new-cache');
    const again = await call({ attempt_id: 'r6', reflection: 'Final mock.', completed_on: '2026-11-07', submission: cited }, 'stale');
    expect(again.isError).not.toBe(true);
    expect(again.structuredContent).toMatchObject({ status: 'archived', completed_design_rounds: 6, review_count: 7 });
  } finally { await client.close(); }
});

it.each(['practice_record_review', 'practice_finish_round'])('rejects extra public outcome spellings but accepts omission through %s', async name => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, practice, index } = setup(), options = settings();
  await practice.add(designRequest);
  const progress_path = 'Learning/Practice/System-Design/Solutions/omitted/progress.md';
  await practice.createNote(progress_path, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
  const review = await practice.review(designRequest.id);
  const attempt = { attempt_id: 'omitted-outcome', reflection: 'My actual answer.', completed_on: '2026-11-14' };
  const payload = (outcome?: string) => name === 'practice_finish_round' ?
    { topic: designRequest, attempt: { ...attempt, ...(outcome ? { outcome } : {}) }, progress_path } :
    { ...attempt, ...(outcome ? { outcome } : {}), id: designRequest.id, revision: review.revision };
  const handler = createFetchHandler(options, { store, writer: store, verify: async () => owner,
    verifyScope: async () => owner, skills: [practiceSkill(options, index)] });
  const client = new Client({ name: 'public-outcome-contract', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    const before = new Map(store.files), writes = [...store.writes];
    for (const outcome of ['completed', '已完成']) {
      expect((await client.callTool({ name, arguments: payload(outcome) })).isError).toBe(true);
      expect(store.files).toEqual(before);
      expect(store.writes).toEqual(writes);
    }
    const registered = await client.callTool({ name, arguments: payload() });
    expect(registered.isError).not.toBe(true);
    expect(registered.structuredContent).toMatchObject({ completed_design_rounds: 1, review_count: 1, next_review: '2026-11-15' });
    const history = await practice.review(designRequest.id, true);
    expect(history.history).toContain('**completed** · Next review 2026-11-15');
    expect((await client.callTool({ name, arguments: payload() })).structuredContent).toMatchObject({ review_count: 1 });
  } finally { await client.close(); }
});

it('persists assessment observations and replaces Profile.md from a normal finish', async () => {
  const { store, practice } = setup();
  const progress = 'Learning/Practice/System-Design/Solutions/profile-round/progress.md';
  await practice.createNote(progress, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
  const observation = { observation_id: 'cache-expiry-01', concept_id: 'cache.expiry', performance: 'partial' as const, learner: true,
    summary: 'Bounded cache lifetime by the link expiry.', anchor: 'Assessment', evidence_order: 1 };
  const finished = await practice.finishRound({ topic: designRequest, progress_path: progress, attempt: {
    attempt_id: 'profile-r1', reflection: 'My actual answer.', completed_on: '2026-11-14', concept_observations: [observation] } });
  expect(finished).toMatchObject({ verified: true, review_count: 1, completed_design_rounds: 1 });
  expect(store.files.get(root + progress)).toContain('observation_id: cache-expiry-01');
  const profile = 'Learning/Practice/System-Design/Profile.md';
  expect(store.files.get(root + profile)).toContain('Current: partial');
  const later = 'Learning/Practice/System-Design/Solutions/profile-round-2/progress.md';
  await practice.createNote(later, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
  await practice.finishRound({ topic: designRequest, progress_path: later, attempt: {
    attempt_id: 'profile-r2', reflection: 'A later answer.', completed_on: '2026-11-14', concept_observations: [{
      ...observation, observation_id: 'cache-expiry-02', evidence_order: 2, performance: 'weak', summary: 'Left the cache unbounded.' }] } });
  const text = store.files.get(root + profile)!;
  expect(text).toContain('Current: weak');
  expect(text).toContain('Contrary evidence: 2026-11-14 cache-expiry-01 partial');
  expect(() => validatePracticeWritePath(profile)).toThrow('invalid_path');
  expect(() => validatePracticeWritePath('Learning/Practice/System-Design/AGENTS.md')).toThrow('invalid_path');
});

it.each(['assessment', 'profile'])('keeps %s write failures pending and retries without advancing twice', async failure => {
  const { store, practice } = setup();
  const progress = 'Learning/Practice/System-Design/Solutions/recovery/progress.md';
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  await practice.createNote(progress, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
  store.files.set(profile, 'Existing profile');
  const payload = { topic: designRequest, progress_path: progress, attempt: {
    attempt_id: 'recovery', reflection: 'Actual answer.', completed_on: '2026-11-14', concept_observations: [{
      observation_id: 'recovery-evidence', concept_id: 'cache.expiry', performance: 'weak' as const, learner: true,
      summary: 'Left the cache unbounded.', anchor: 'Assessment' }] } };
  store.beforePut = key => {
    if (key === profile && failure === 'profile' || key === root + progress && failure === 'assessment' &&
      parseFrontmatter(store.files.get(items + designRequest.id + '.md') ?? '')?.metadata.review_count === 1) throw new NoteError('note_unavailable');
  };
  await expect(practice.finishRound(payload)).rejects.toThrow('note_unavailable');
  const pending = parseFrontmatter(store.files.get(root + progress)!)!.metadata;
  expect(pending).toMatchObject({ tags: ['system-design/wip'], confirmed_registration: { topic: payload.topic, attempt: payload.attempt } });
  expect(store.files.get(profile)).toBe('Existing profile');
  delete store.beforePut;
  expect(await practice.finishRound(payload)).toMatchObject({ verified: true, completed_design_rounds: 1, review_count: 1 });
  const done = parseFrontmatter(store.files.get(root + progress)!)!.metadata;
  expect(done.tags).toEqual(['system-design/done']);
  expect(done).not.toHaveProperty('confirmed_registration');
  expect(parseObservations(store.files.get(profile)!)).toHaveLength(1);
});

it('rejects standalone evidence before recording any state', async () => {
  const { practice, store } = setup();
  await practice.add(designRequest);
  const before = new Map(store.files);
  await expect(practice.record({ id: designRequest.id, revision: (await practice.review(designRequest.id)).revision,
    attempt_id: 'unsupported', completed_on: '2026-11-14', reflection: 'Actual answer.', concept_observations: [{
      observation_id: 'unsupported', concept_id: 'cache.expiry', performance: 'weak', learner: true,
      summary: 'No expiry.', anchor: 'Assessment' }] })).rejects.toThrow('use_practice_finish_round_for_evidence');
  expect(store.files).toEqual(before);
});

it('rebuilds lost profiles and corrected old assessments with date ordering and distinct-attempt repetition', async () => {
  const { practice, store } = setup();
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const observation: StoredObservation = { observation_id: 'newer', attempt_id: 'a2', date: '2026-11-14',
    concept_id: 'cache.expiry', performance: 'mastered', summary: 'Bounded lifetime.', anchor: 'Assessment', learner: true };
  const save = (folder: string, rows: StoredObservation[]) => store.files.set(root + `Learning/Practice/System-Design/Solutions/${folder}/progress.md`,
    '---\ntopic: Cache\n---\n## Assessment\n\n```practice-observations\n' + stringify(rows) + '```\n');
  const old = { ...observation, observation_id: 'older', attempt_id: 'a1', date: '2026-11-10', performance: 'weak' as const, error_id: 'cache.no-expiry', summary: 'No expiry.' };
  save('A-newer', [observation]); save('Z-older', [old, { ...old, observation_id: 'older-duplicate' }]);
  await practice.rebuildDesignProfile();
  const original = store.files.get(profile)!;
  expect(original).toContain('Current: mastered. Bounded lifetime.');
  expect(original).toContain('Contrary evidence: 2026-11-10');
  expect(original).not.toContain('Repeated error:');
  store.files.delete(profile);
  await practice.rebuildDesignProfile();
  expect(store.files.get(profile)).toBe(original);
  save('Z-older', [{ ...old, summary: 'Corrected assessment.' }]);
  await practice.rebuildDesignProfile();
  expect(parseObservations(store.files.get(profile)!).find(row => row.observation_id === 'older')?.summary).toBe('Corrected assessment.');
  save('B-repeated', [{ ...old, observation_id: 'repeated', attempt_id: 'a3', date: '2026-11-12', summary: 'Corrected assessment.' }]);
  await practice.rebuildDesignProfile();
  expect(store.files.get(profile)).toContain('Repeated error: cache.no-expiry. Corrected assessment.');
  expect(store.files.get(profile)).toContain('Current: mastered. Bounded lifetime.');
  expect(renderProfile([old, observation])).toBe(renderProfile([observation, old]));
  expect(parseObservations(renderProfile([{ ...old, date: observation.date }, observation])).map(row => row.observation_id)).toEqual(['older', 'newer']);
});

it('preserves a concurrent profile replacement during assessment rebuilding', async () => {
  const { practice, store } = setup();
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  store.files.set(profile, 'Original');
  store.beforePut = key => {
    if (key === profile) { store.files.set(profile, 'Concurrent profile'); delete store.beforePut; }
  };
  await expect(practice.rebuildDesignProfile()).rejects.toThrow('revision_conflict');
  expect(store.files.get(profile)).toBe('Concurrent profile');
});

it('registers question concepts and delivers an in-scope evidence-backed outline through MCP', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, index } = setup(), options = settings();
  const observation: StoredObservation = { observation_id: 'cache-answer', attempt_id: 'prior-round', date: '2026-11-10',
    concept_id: 'cache.expiry', performance: 'mastered', summary: 'Bounded cache lifetime.', anchor: 'Answer-1', learner: true };
  store.files.set(root + 'Learning/Practice/System-Design/Solutions/prior/progress.md',
    '---\ntopic: Prior\n---\n## Assessment\n```practice-observations\n' + stringify([observation,
      { ...observation, observation_id: 'out-of-scope', concept_id: 'stream.order', performance: 'weak' }]) + '```\n');
  const handler = createFetchHandler(options, { store, writer: store, verify: async () => owner,
    verifyScope: async () => owner, skills: [practiceSkill(options, index)] });
  const client = new Client({ name: 'outline-contract', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    const concepts = ['cache.expiry', 'cache.eviction'];
    const added = await client.callTool({ name: 'practice_add_review', arguments: { ...designRequest, concept_ids: concepts } });
    expect(added.structuredContent).toMatchObject({ concept_ids: concepts });
    const review = await client.callTool({ name: 'practice_review', arguments: { id: designRequest.id } });
    expect(review.structuredContent).toMatchObject({ concept_ids: concepts });
    const outline = await client.callTool({ name: 'practice_design_outline', arguments: { id: designRequest.id } });
    expect(outline.structuredContent).toMatchObject({ problem_concepts: concepts, follow_ups: [
      { concept_id: 'cache.eviction', kind: 'probe', performance: 'uncovered', evidence: [] },
      { concept_id: 'cache.expiry', kind: 'variant', performance: 'mastered', evidence: [observation] },
    ] });
    expect((await client.callTool({ name: 'practice_design_outline', arguments: { concept_ids: concepts } })).structuredContent).toEqual(outline.structuredContent);
  } finally { await client.close(); }
});

it('recovers and retries MCP closeout while preserving canonical ordering, corrections and legacy concepts', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createFetchHandler } = await import('../src/handler.js');
  const { store, index } = setup(), options = settings();
  const handler = createFetchHandler(options, { store, writer: store, verify: async () => owner,
    verifyScope: async () => owner, skills: [practiceSkill(options, index)] });
  const client = new Client({ name: 'canonical-closeout', version: '1' });
  const profile = 'Learning/Practice/System-Design/Profile.md';
  const concepts = ['cache.expiry'];
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const evidence = (observation_id: string, evidence_order: number, performance: 'weak' | 'mastered') => ({
    observation_id, evidence_order, concept_id: concepts[0]!, error_id: 'cache.no-expiry', performance,
    summary: performance === 'weak' ? 'No expiry.' : 'Bounded cache lifetime.', anchor: 'Assessment', learner: true,
  });
  const earlier = evidence('earlier-answer', 1, 'weak');
  const later = evidence('later-answer', 2, 'mastered');
  const progress = 'Learning/Practice/System-Design/Solutions/A-newer/progress.md';
  const prior = 'Learning/Practice/System-Design/Solutions/Z-older/progress.md';
  const finish = { topic: { ...designRequest, concept_ids: concepts }, progress_path: progress, attempt: {
    attempt_id: 'a-later', completed_on: '2026-11-14', reflection: 'Actual answer.', concept_observations: [later],
  } };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), { fetch: (input, init) => handler(new Request(input, init)) }));
    expect((await call('practice_add_review', designRequest)).isError).not.toBe(true);
    const key = items + designRequest.id + '.md';
    const legacy = parseFrontmatter(store.files.get(key)!)!;
    delete legacy.metadata.concept_ids;
    store.files.set(key, '---\n' + stringify({ ...legacy.metadata, custom_field: 'retained' }) + '---\n' + legacy.body);
    const review = await call('practice_review', { id: designRequest.id });
    const revision = z.object({ revision: z.string() }).parse(review.structuredContent).revision;
    const beforeRecord = new Map(store.files);
    expect((await call('practice_record_review', { ...finish.attempt, id: designRequest.id, revision })).isError).toBe(true);
    expect(store.files).toEqual(beforeRecord);
    for (const path of [prior, progress]) expect((await call('practice_create_note', { path,
      content: '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n',
    })).isError).not.toBe(true);
    expect((await call('practice_finish_round', { topic: designRequest, progress_path: prior, attempt: {
      ...finish.attempt, attempt_id: 'z-earlier', concept_observations: [earlier],
    } })).isError).not.toBe(true);
    const existingProfile = store.files.get(root + profile);
    store.beforePut = path => { if (path === root + profile) throw new NoteError('note_unavailable'); };
    expect((await call('practice_finish_round', finish)).isError).toBe(true);
    expect(parseFrontmatter(store.files.get(root + progress)!)!.metadata).toMatchObject({ tags: ['system-design/wip'], confirmed_registration: { topic: finish.topic, attempt: finish.attempt } });
    expect(store.files.get(root + profile)).toBe(existingProfile);
    delete store.beforePut;
    expect((await call('practice_finish_round', finish)).structuredContent).toMatchObject({ verified: true, completed_design_rounds: 2 });
    expect(parseFrontmatter(store.files.get(key)!)!.metadata).toMatchObject({ concept_ids: concepts, custom_field: 'retained' });
    const snapshot = store.files.get(root + profile)!;
    expect(snapshot).toContain('Current: mastered. Bounded cache lifetime.');
    expect(parseObservations(snapshot).map(row => [row.observation_id, row.evidence_order])).toEqual([['earlier-answer', 1], ['later-answer', 2]]);
    expect(snapshot).toContain('Contrary evidence:');
    expect((await call('practice_design_outline', { id: designRequest.id })).structuredContent).toMatchObject({
      problem_concepts: concepts, follow_ups: [{ concept_id: concepts[0], performance: 'mastered', kind: 'variant' }],
    });
    store.files.delete(root + profile);
    expect((await call('practice_rebuild_design_profile', {})).isError).not.toBe(true);
    expect(store.files.get(root + profile)).toBe(snapshot);
    store.files.set(root + profile, 'Stale profile');
    expect((await call('practice_rebuild_design_profile', {})).isError).not.toBe(true);
    expect(store.files.get(root + profile)).toBe(snapshot);
    const read = await call('practice_read_note', { path: progress });
    const correctedRevision = z.object({ revision: z.string() }).parse(read.structuredContent).revision;
    expect((await call('practice_update_note', { path: progress, revision: correctedRevision, edits: [
      { old: 'performance: mastered', replacement: 'performance: weak' },
      { old: 'summary: Bounded cache lifetime.', replacement: 'summary: No expiry.' },
    ] })).isError).not.toBe(true);
    expect((await call('practice_rebuild_design_profile', {})).isError).not.toBe(true);
    const corrected = new Map(store.files);
    expect(store.files.get(root + profile)).toContain('Repeated error: cache.no-expiry. No expiry.');
    expect((await call('practice_finish_round', finish)).structuredContent).toMatchObject({ verified: true, completed_design_rounds: 2 });
    expect(store.files).toEqual(corrected);
    expect((await call('practice_design_outline', { id: designRequest.id })).structuredContent).toMatchObject({
      follow_ups: [{ performance: 'weak', kind: 'probe' }],
    });
  } finally { await client.close(); }
});


it('retains legacy same-day session and saved observation order without ordering by attempt IDs', async () => {
  const { practice, store } = setup();
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const observation: StoredObservation = { observation_id: 'first', attempt_id: 'z-first', date: '2026-11-14',
    concept_id: 'cache.expiry', performance: 'weak', error_id: 'cache.no-expiry', summary: 'No expiry.', anchor: 'Assessment', learner: true };
  const save = (folder: string, rows: StoredObservation[]) => store.files.set(root + `Learning/Practice/System-Design/Solutions/${folder}/progress.md`,
    '---\ntopic: Cache\n---\n## Assessment\n```practice-observations\n' + stringify(rows) + '```\n');
  save('Z-last', [{ ...observation, observation_id: 'last', attempt_id: 'a-last', performance: 'mastered', summary: 'Bounded lifetime.' }]);
  save('A-first', [observation, { ...observation, observation_id: 'second', attempt_id: 'b-second' }]);
  await practice.rebuildDesignProfile();
  const snapshot = store.files.get(profile)!;
  expect(parseObservations(snapshot).map(row => row.observation_id)).toEqual(['first', 'second', 'last']);
  expect(snapshot).toContain('Current: mastered. Bounded lifetime.');
  expect(snapshot).toContain('Repeated error: cache.no-expiry. No expiry.');
  const outline = await practice.outline({ concept_ids: ['cache.expiry'] });
  expect(outline.follow_ups[0]).toMatchObject({ performance: 'mastered', kind: 'variant' });
  expect(outline.follow_ups[0]!.evidence.map(row => row.observation_id)).toEqual(['first', 'second', 'last']);
});

it('identifies repeated error IDs across distinct finishes with different summaries', async () => {
  const { practice, store } = setup();
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const base = { concept_id: 'cache.expiry', error_id: 'cache.no-expiry', performance: 'weak', anchor: 'Assessment' };
  const finish = async (id: string, observations: object[]) => {
    const progress_path = `Learning/Practice/System-Design/Solutions/${id}/progress.md`;
    await practice.createNote(progress_path, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
    return practice.finishRound(finishRoundSchema.parse({ topic: designRequest, progress_path, attempt: {
      attempt_id: id, completed_on: '2026-11-14', reflection: 'Actual learner answer.', concept_observations: observations,
    } }));
  };
  await finish('error-first', [
    { ...base, observation_id: 'error-1a', summary: 'Left the redirect cache unbounded.', evidence_order: 1 },
    { ...base, observation_id: 'error-1b', summary: 'No expiration for stale links.', evidence_order: 2 },
  ]);
  expect(store.files.get(profile)).not.toContain('Repeated error:');
  await finish('error-second', [
    { ...base, observation_id: 'error-2', performance: 'partial', summary: 'Kept expired destinations in the cache.', evidence_order: 3 },
  ]);
  const repeated = store.files.get(profile)!;
  expect(repeated).toContain('Repeated error: cache.no-expiry.');
  expect(repeated).toContain('Evidence: error-1a, error-1b, error-2.');
  expect(repeated).toContain('Current: partial. Kept expired destinations in the cache.');
  expect(repeated).toContain('Contrary evidence:');
  expect(parseObservations(repeated).map(row => row.error_id)).toEqual(['cache.no-expiry', 'cache.no-expiry', 'cache.no-expiry']);
  await finish('error-third', [{ ...base, observation_id: 'error-3', performance: 'mastered', summary: 'Bounded cache lifetime.', evidence_order: 4 }]);
  expect(store.files.get(profile)).toContain('Current: mastered. Bounded cache lifetime.');
  expect(store.files.get(profile)).toContain('Repeated error: cache.no-expiry.');
  expect(store.files.get(profile)).toContain('Contrary evidence:');
});

it('preserves answer dates and same-day evidence order through late finish and canonical rebuild', async () => {
  const { store, index } = setup();
  const practice = new Practice(store, index, settings(), AbortSignal.timeout(10000),
    { writer: store, now: () => new Date('2026-11-30T02:00:00Z') });
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const base = { concept_id: 'cache.expiry', performance: 'weak', summary: 'No expiry.', anchor: 'Assessment' };
  const finish = async (id: string, attempt_id: string, completed_on: string, observations: object[], saved: object[] = []) => {
    const progress_path = `Learning/Practice/System-Design/Solutions/${id}/progress.md`;
    await practice.createNote(progress_path, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n' +
      (saved.length ? '```practice-observations\n' + stringify(saved) + '```\n' : ''));
    return practice.finishRound(finishRoundSchema.parse({ topic: { ...designRequest, id }, progress_path, attempt: {
      attempt_id, completed_on, reflection: 'Actual learner answer.', concept_observations: observations,
    } }));
  };
  await finish('recent-question', 'z-earlier-order', '2026-11-25', [
    { ...base, observation_id: 'recent', date: '2026-11-25', performance: 'mastered', summary: 'Recent bounded cache answer.' },
    { ...base, concept_id: 'shard.routing', observation_id: 'order-1', date: '2026-11-24', evidence_order: 1 },
  ]);
  await finish('late-question', 'a-later-order', '2026-11-26', [
    { ...base, observation_id: 'late', date: '2026-11-20' },
    { ...base, concept_id: 'shard.routing', observation_id: 'order-2', date: '2026-11-24', evidence_order: 2,
      performance: 'mastered', summary: 'Later same-day routing answer.' },
    { ...base, concept_id: 'answer.citation', observation_id: 'dated-answer', date: '2026-11-21', summary: 'Answer day differs from completion.' },
    { ...base, concept_id: 'canonical.date', observation_id: 'canonical-answer', summary: 'Preserved canonical answer date.' },
  ], [
    { ...base, concept_id: 'legacy.order', observation_id: 'z-legacy-first', attempt_id: 'a-later-order' },
    { ...base, concept_id: 'legacy.order', observation_id: 'a-legacy-second', attempt_id: 'a-later-order', performance: 'partial' },
    { ...base, concept_id: 'canonical.date', observation_id: 'canonical-answer', attempt_id: 'a-later-order', date: '2026-11-19' },
  ]);
  const snapshot = store.files.get(profile)!;
  expect(snapshot).toContain('Current: mastered. Recent bounded cache answer.');
  expect(snapshot).toContain('Evidence: 2026-11-25 recent.');
  expect(snapshot).toContain('Current: mastered. Later same-day routing answer.');
  expect(snapshot).toContain('Evidence: 2026-11-21 dated-answer.');
  expect(snapshot).toContain('Evidence: 2026-11-19 canonical-answer.');
  const rows = parseObservations(snapshot);
  expect(rows.find(row => row.observation_id === 'late')?.date).toBe('2026-11-20');
  expect(rows.filter(row => row.concept_id === 'shard.routing').map(row => row.observation_id)).toEqual(['order-1', 'order-2']);
  const historical = rows.filter(row => row.concept_id === 'legacy.order');
  expect(historical.map(row => row.observation_id)).toEqual(['z-legacy-first', 'a-legacy-second']);
  for (const row of historical) {
    expect(row.date).toBe('2026-11-26');
    expect(row).not.toHaveProperty('evidence_order');
  }
  const outline = await practice.outline({ concept_ids: ['cache.expiry', 'shard.routing'] });
  expect(outline.follow_ups.map(row => row.performance)).toEqual(['mastered', 'mastered']);
  await practice.rebuildDesignProfile();
  expect(store.files.get(profile)).toBe(snapshot);
});

it('rejects generic profile writes while retaining dedicated rebuild ownership', async () => {
  const { practice, store } = setup();
  const profile = 'Learning/Practice/System-Design/Profile.md';
  await expect(practice.createNote(profile, 'Manual profile')).rejects.toThrow('invalid_path');
  expect(store.files.has(root + profile)).toBe(false);
  await practice.rebuildDesignProfile();
  const before = store.files.get(root + profile)!;
  await expect(practice.updateNote(profile, store.tag(root + profile), [
    { old: '# System Design profile', replacement: '# Manual profile' },
  ])).rejects.toThrow('invalid_path');
  expect(store.files.get(root + profile)).toBe(before);
  await expect(practice.createNote('Learning/Practice/System-Design/AGENTS.md', 'Guide')).rejects.toThrow('invalid_path');
});

it.each([
  { date: '2026-02-30' },
  { performance: 'excellent' },
])('rejects malformed canonical evidence %j before rebuild or pending finish writes', async invalid => {
  const { practice, store } = setup();
  const progress = 'Learning/Practice/System-Design/Solutions/invalid-evidence/progress.md';
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  await practice.createNote(progress, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
  const observation = { observation_id: 'invalid-evidence', concept_id: 'cache.expiry', performance: 'weak' as const,
    summary: 'No expiration.', anchor: 'Assessment' };
  const payload = finishRoundSchema.parse({ topic: designRequest, progress_path: progress, attempt: {
    attempt_id: 'invalid-evidence', completed_on: '2026-11-14', reflection: 'Actual answer.', concept_observations: [observation],
  } });
  store.files.set(profile, 'Existing profile');
  store.beforePut = key => { if (key === profile) throw new NoteError('note_unavailable'); };
  await expect(practice.finishRound(payload)).rejects.toThrow('note_unavailable');
  delete store.beforePut;
  const pending = parseFrontmatter(store.files.get(root + progress)!)!;
  const malformed = { ...observation, attempt_id: payload.attempt.attempt_id, date: '2026-11-14', ...invalid };
  store.files.set(root + progress, '---\n' + stringify(pending.metadata) + '---\n## Assessment\n```practice-observations\n' +
    stringify([malformed]) + '```\n');
  const before = new Map(store.files);
  const writeCount = store.writes.length;
  await expect(practice.rebuildDesignProfile()).rejects.toThrow();
  expect(store.files).toEqual(before);
  await expect(practice.finishRound(payload)).rejects.toThrow();
  expect(store.files).toEqual(before);
  expect(store.writes).toHaveLength(writeCount);
  expect(parseFrontmatter(store.files.get(items + designRequest.id + '.md')!)!.metadata.review_count).toBe(1);
});

it('repeats error IDs across concepts and distinct attempts without mixing conclusions', async () => {
  const { practice, store } = setup();
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const base = { error_id: 'missing-failure-recovery', performance: 'weak', anchor: 'Assessment' };
  const finish = async (id: string, observations: object[]) => {
    const progress_path = `Learning/Practice/System-Design/Solutions/${id}/progress.md`;
    await practice.createNote(progress_path, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) + '---\n## Assessment\n');
    await practice.finishRound(finishRoundSchema.parse({ topic: designRequest, progress_path, attempt: {
      attempt_id: id, completed_on: '2026-11-14', reflection: 'Actual learner answer.', concept_observations: observations,
    } }));
  };
  await finish('routing-errors', [
    { ...base, observation_id: 'routing-error', evidence_order: 1, concept_id: 'shard.routing', summary: 'Lost routing after a shard failure.' },
    { ...base, observation_id: 'queue-first', evidence_order: 2, concept_id: 'queue.delivery', summary: 'No recovery after delivery failure.' },
  ]);
  expect(store.files.get(profile)).not.toContain('Repeated error:');
  await finish('queue-errors', [
    { ...base, observation_id: 'queue-error', evidence_order: 3, concept_id: 'queue.delivery', summary: 'Dropped messages on consumer failure.' },
  ]);
  const text = store.files.get(profile)!;
  expect(text).toContain('Repeated error: missing-failure-recovery.');
  expect(text).toContain('Evidence: routing-error, queue-first, queue-error.');
  expect(text).toContain('## shard.routing\n\nCurrent: weak. Lost routing after a shard failure.');
  expect(text).toContain('## queue.delivery\n\nCurrent: weak. Dropped messages on consumer failure.');
});

it.each([
  { label: 'undated valid evidence', overrides: {}, valid: true },
  { label: 'invalid answer date', overrides: { date: '2026-02-30' }, valid: false },
  { label: 'invalid performance', overrides: { performance: 'excellent' }, valid: false },
])('handles $label on first finish before writing state', async ({ overrides, valid }) => {
  const { practice, store } = setup();
  const progress_path = 'Learning/Practice/System-Design/Solutions/first-evidence/progress.md';
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const observation = { observation_id: 'first-evidence', attempt_id: 'first-evidence', concept_id: 'cache.expiry',
    performance: 'weak', summary: 'No expiration.', anchor: 'Assessment', ...overrides };
  await practice.createNote(progress_path, '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) +
    '---\n## Assessment\n```practice-observations\n' + stringify([observation]) + '```\n');
  store.files.set(profile, 'Existing profile');
  const payload = finishRoundSchema.parse({ topic: designRequest, progress_path, attempt: {
    attempt_id: 'first-evidence', completed_on: '2026-11-14', reflection: 'Actual answer.',
  } });
  const before = new Map(store.files);
  const writeCount = store.writes.length;
  if (!valid) {
    await expect(practice.finishRound(payload)).rejects.toThrow();
    expect(store.files).toEqual(before);
    expect(store.writes).toHaveLength(writeCount);
    return;
  }
  await expect(practice.finishRound(payload)).resolves.toMatchObject({ verified: true, review_count: 1 });
  const saved = parseFrontmatter(store.files.get(root + progress_path)!)!;
  expect(saved.metadata).toMatchObject({ round_completed_on: '2026-11-14', tags: ['system-design/done'] });
  expect(parseObservations(saved.body)).toMatchObject([{ observation_id: 'first-evidence', date: '2026-11-14' }]);
  expect(parseObservations(store.files.get(profile)!)).toMatchObject([{ observation_id: 'first-evidence', date: '2026-11-14' }]);
});

it.each([
  { label: 'valid undated evidence', overrides: {}, valid: true },
  { label: 'explicit invalid date', overrides: { date: '2026-02-30' }, valid: false },
  { label: 'explicit invalid performance', overrides: { performance: 'excellent' }, valid: false },
])('handles another unfinished session with $label', async ({ overrides, valid }) => {
  const { practice, store } = setup();
  const profile = root + 'Learning/Practice/System-Design/Profile.md';
  const progress_path = 'Learning/Practice/System-Design/Solutions/current-session/progress.md';
  const otherPath = 'Learning/Practice/System-Design/Solutions/other-session/progress.md';
  const observation = { observation_id: 'current-answer', attempt_id: 'current-session', concept_id: 'cache.expiry',
    performance: 'weak', summary: 'No expiration.', anchor: 'Assessment' };
  const assessment = (rows: object[]) => '---\n' + stringify({ topic: designRequest.title, tags: ['system-design/wip'] }) +
    '---\n## Assessment\n```practice-observations\n' + stringify(rows) + '```\n';
  await practice.createNote(progress_path, assessment([observation]));
  await practice.createNote(otherPath, assessment([{ ...observation, observation_id: 'other-answer', attempt_id: 'other-session', ...overrides }]));
  store.files.set(profile, 'Existing profile');
  const before = new Map(store.files);
  const writeCount = store.writes.length;
  const payload = finishRoundSchema.parse({ topic: designRequest, progress_path, attempt: {
    attempt_id: 'current-session', completed_on: '2026-11-14', reflection: 'Actual answer.',
  } });
  if (!valid) {
    await expect(practice.finishRound(payload)).rejects.toThrow();
    await expect(practice.outline({ concept_ids: ['cache.expiry'] })).rejects.toThrow();
    await expect(practice.rebuildDesignProfile()).rejects.toThrow();
    expect(store.files).toEqual(before);
    expect(store.writes).toHaveLength(writeCount);
    return;
  }
  expect(await practice.rebuildDesignProfile()).toMatchObject({ rebuilt: true, observations: 0 });
  expect((await practice.outline({ concept_ids: ['cache.expiry'] })).follow_ups[0]).toMatchObject({ performance: 'uncovered', evidence: [] });
  expect(await practice.finishRound(payload)).toMatchObject({ verified: true, review_count: 1 });
  const saved = parseFrontmatter(store.files.get(root + progress_path)!)!;
  expect(saved.metadata).toMatchObject({ round_completed_on: '2026-11-14', tags: ['system-design/done'] });
  expect(parseObservations(saved.body)).toMatchObject([{ observation_id: 'current-answer', date: '2026-11-14' }]);
  const outline = await practice.outline({ concept_ids: ['cache.expiry'] });
  expect(outline.follow_ups[0]).toMatchObject({ performance: 'weak', evidence: [{ observation_id: 'current-answer', date: '2026-11-14' }] });
  expect(await practice.rebuildDesignProfile()).toMatchObject({ rebuilt: true, observations: 1 });
  expect(parseObservations(store.files.get(profile)!)).toMatchObject([{ observation_id: 'current-answer', date: '2026-11-14' }]);
  expect(store.files.get(root + otherPath)).toBe(before.get(root + otherPath));
});
