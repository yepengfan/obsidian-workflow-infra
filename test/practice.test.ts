import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import bundle from '../workflows/practice.json' with { type: 'json' };
import { calendarDay, nextSchedule, Practice, recordReviewSchema, validatePracticeWritePath } from '../src/practice.js';
import { NoteError } from '../src/paths.js';
import type { NoteStore } from '../src/s3.js';
import { owner, runtimeSettings } from './runtime-fixtures.js';

const root = 'Vault/';
const items = root + 'Learning/Practice/Review/Items/';
const configPath = root + 'system/modules/practice-review/module.md';
const moduleText = bundle.documents['system/modules/practice-review/module.md'].text;
const now = () => new Date('2026-11-14T02:00:00Z');
const settings = (writesEnabled = true) => runtimeSettings({ practice: { enabled: true, writesEnabled, timeZone: 'Australia/Brisbane' } });
const item = { id: 'lc-1071', domain: 'algorithm' as const, title: 'GCD of strings', status: 'active' as const,
  review_count: 0, stage: 0, last_review: null as string | null, next_review: null as string | null };
class PracticeStore implements NoteStore {
  files = new Map<string, string>([[configPath, moduleText],
    [root + 'system/modules/algorithm/module.md', '---\nenabled: true\n---\n']]);
  writes: string[] = []; lists: { prefix: string; limit: number }[] = []; serial = 0;
  beforePut?: (key: string) => void;
  tag(key: string) { return '"' + createHash('sha256').update(this.files.get(key) ?? '').digest('hex') + '"'; }
  async list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted(); this.lists.push({ prefix, limit });
    const keys = [...this.files.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).sort();
    const start = Number(cursor ?? 0); const page = keys.slice(start, start + limit);
    return { folders: [], notes: page.map(key => ({ key, size: Buffer.byteLength(this.files.get(key)!) })), next: keys.length > start + limit ? String(start + limit) : undefined };
  }
  async read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.files.has(key) || (etag && etag !== this.tag(key))) throw new NoteError('note_unavailable');
    const data = Buffer.from(this.files.get(key)!); return { bytes: data.subarray(offset, offset + length), total: data.length, etag: this.tag(key) };
  }
  async put(key: string, text: string, revision: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted(); this.beforePut?.(key);
    if (revision ? !this.files.has(key) || this.tag(key) !== revision : this.files.has(key)) throw new NoteError('revision_conflict');
    this.files.set(key, text); this.writes.push(key); return this.tag(key);
  }
}
function setup(writes = true) {
  const store = new PracticeStore(); const practice = new Practice(store, settings(writes), owner, AbortSignal.timeout(10000), now);
  return { store, practice };
}
const request = { id: item.id, domain: item.domain, title: item.title, prompt: 'Given two strings, find their greatest common divisor.', review_focus: 'Private post-attempt cue' };
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
    { name: 'final stage stays capped', prior: { stage: 4, next_review: '2026-11-14' }, outcome: 'independent', date: '2026-11-14', stage: 4, due: '2026-12-14' },
    { name: 'month boundary', prior: {}, outcome: 'independent', date: '2026-12-31', stage: 0, due: '2027-01-01' },
  ])('$name', ({ prior, outcome, date, stage, due }) => {
    expect(nextSchedule({ ...item, ...prior }, outcome, date, [1, 3, 7, 14, 30], 1)).toEqual({ stage, next_review: due, last_review: date, review_count: 1 });
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
  it('returns canonical workflow definitions and honors live module guards', async () => {
    const { store, practice } = setup(); const result = await practice.workflow('algorithm');
    expect(result.domains).toEqual(['algorithm']); expect(result.selected_domain).toBe('algorithm');
    expect(result.source_commit).toBe(bundle.sourceCommit); expect(result.intervals).toEqual([1, 3, 7, 14, 30]);
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
  it('rejects stale writes and preserves a concurrent Obsidian edit', async () => {
    const { store, practice } = await seeded(); const prompt = await practice.review(item.id);
    store.beforePut = key => { store.files.set(key, store.files.get(key)! + '\nUser edit\n'); store.beforePut = undefined; };
    await expect(practice.record(attempt(prompt.revision))).rejects.toThrow('revision_conflict');
    expect(store.files.get(items + item.id + '.md')).toContain('User edit');
    expect((await practice.review(item.id)).review_count).toBe(0);
  });
  it('records the actual completion date on a later save and rejects future dates', async () => {
    const { practice } = await seeded(); const prompt = await practice.review(item.id);
    expect(await practice.record(attempt(prompt.revision, { completed_on: '2026-11-12' }))).toMatchObject({ last_review: '2026-11-12', next_review: '2026-11-13' });
    await expect(practice.record(attempt((await practice.review(item.id)).revision, { attempt_id: 'future', completed_on: '2026-11-15' }))).rejects.toThrow('future');
  });
  it('paginates only the review prefix and binds cursors to the calendar date', async () => {
    const { store, practice } = setup();
    for (let i = 0; i < 23; i++) await practice.add({ ...request, id: `lc-${i}` });
    const first = await practice.reviews({ domain: 'algorithm' });
    expect(first.complete).toBe(false); expect(first.unstarted).toHaveLength(20); expect(first.ordering).toBe('this_page_only');
    const second = await practice.reviews({ domain: 'algorithm', cursor: first.nextCursor });
    expect(second.complete).toBe(true); expect(second.unstarted).toHaveLength(3);
    expect(store.lists).toEqual([{ prefix: items, limit: 20 }, { prefix: items, limit: 20 }]);
    const tomorrow = new Practice(store, settings(), owner, AbortSignal.timeout(10000), () => new Date('2026-11-15T02:00:00Z'));
    await expect(tomorrow.reviews({ domain: 'algorithm', cursor: first.nextCursor })).rejects.toThrow('invalid_cursor');
  });
  it('skips other domains in a mixed queue and refuses to read or record their attempts', async () => {
    const { store, practice } = await seeded();
    const algorithmNote = store.files.get(items + item.id + '.md')!;
    for (const domain of ['system-design', 'behavioral']) {
      const id = `other-${domain}`;
      store.files.set(items + id + '.md', algorithmNote.replace('id: lc-1071', `id: ${id}`).replace('domain: algorithm', `domain: ${domain}`));
      await expect(practice.review(id)).rejects.toThrow('unsupported_practice_domain');
      await expect(practice.record(attempt(store.tag(items + id + '.md'), { id }))).rejects.toThrow('unsupported_practice_domain');
    }
    const queue = await practice.reviews({ domain: 'algorithm' });
    expect(queue.complete).toBe(true); expect(queue.unstarted.map(item => item.id)).toEqual([item.id]);
    expect(store.writes).toEqual([items + item.id + '.md']);
  });
  it('starts Algorithm directly and exposes only its instruction set and note scope', async () => {
    const { practice } = setup();
    expect(await practice.workflow()).toMatchObject({ domains: ['algorithm'], selected_domain: 'algorithm', time_limits: { algorithm: expect.any(Number) } });
    const workflow = await practice.workflow();
    expect(workflow.entry).toBe(bundle.entry);
    for (const path of ['.agents/skills/sysd-solve/SKILL.md', 'Learning/Practice/Review/Flows/behavioral.md']) {
      expect(workflow.documents).not.toContain(path);
      await expect(practice.instruction(path, 0)).rejects.toThrow('unknown_practice_instruction');
    }
    await expect(practice.readNote('Learning/Practice/System-Design/Patterns/test.md')).rejects.toThrow('invalid_path');
  });
  it('does not permit private record changes when writes are disabled', async () => {
    const { store, practice } = setup(false); await expect(practice.add(request)).rejects.toThrow('writes_disabled'); expect(store.writes).toHaveLength(0);
  });
  it.each(['system/modules/algorithm/module.md', 'WeRead/a.md', 'Learning/Practice/Algorithm/Patterns/AGENTS.md',
    'Learning/Practice/Algorithm/Patterns/../AGENTS.md', 'Learning/Practice/Review/Items/lc-1.md', 'Learning/Practice/System-Design/Patterns/queues.md', 'Learning/Practice/System-Design/Solutions/URL-Shortener/progress.md', 'Templates/SD Log.md'])('rejects ordinary edits to %s', path => {
    expect(() => validatePracticeWritePath(path)).toThrow();
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
    fetch: async (input, init) => createFetchHandler(options, { store,
      verify: async () => owner, verifyWrite: async () => { if (!writableToken) throw new AuthError(401); return owner; },
      log: event => logs.push(event),
    })(new Request(input, init)),
  });
  client.onerror = () => {};
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.some(tool => tool.name === 'practice')).toBe(true);
    expect(tools.map(tool => tool.name)).not.toContain('practice_create_design_session');
    for (const domain of ['system-design', 'behavioral']) {
      for (const name of ['practice', 'practice_reviews', 'practice_add_review']) {
        expect((await client.callTool({ name, arguments: { ...(name === 'practice_add_review' ? request : {}), domain } })).isError).toBe(true);
      }
    }
    expect(store.writes).toHaveLength(0);
    expect(tools.find(tool => tool.name === 'practice_record_review')?._meta?.securitySchemes)
      .toEqual([{ type: 'oauth2', scopes: [options.scope, `${options.resource}/write`] }]);
    const workflow = await client.callTool({ name: 'practice', arguments: {} });
    expect(workflow.structuredContent).toMatchObject({ selected_domain: 'algorithm', source_commit: bundle.sourceCommit });
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
      fetch: async (input, init) => createFetchHandler(options, { store, verify: async () => owner,
        verifyWrite: async () => owner })(new Request(input, init)),
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
      fetch: async (input, init) => createFetchHandler(options, { store, verify: async () => owner })(new Request(input, init)),
    }));
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(8); expect(tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    expect((await client.callTool({ name: 'practice_add_review', arguments: request })).isError).toBe(true); expect(store.writes).toHaveLength(0);
  } finally { await client.close(); }
});
