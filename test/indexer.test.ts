import { describe, expect, it } from 'vitest';
import { buildRow, handleIndexerEvent, indexKey, messageKey, reconcile, type IndexerDependencies } from '../src/indexer.js';
import { practiceReviewIndex, UNSTARTED_SORT } from '../src/index-modules/practice-review.js';
import { resolveIndexedKey } from '../src/index-modules/index.js';
import type { IndexValue } from '../src/index-modules/types.js';

const items = 'Learning/Practice/Review/Items/';
const note = (fields: Record<string, string>) => `---\n${Object.entries({
  id: 'lc-1', domain: 'algorithm', title: 'LC 1 - Two Sum', status: 'active', prompt: 'Find two numbers.',
  review_count: '2', stage: '1', last_review: '2026-11-17', next_review: '2026-11-20', ...fields,
}).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n# LC 1\n`;

function fixture(prefix = '') {
  const objects = new Map<string, { text: string; etag: string } | 'too_large'>();
  const rows = new Map<string, Record<string, IndexValue>>();
  const queued: string[][] = [], logs: Record<string, unknown>[] = [];
  let failGet: string | undefined;
  const deps: IndexerDependencies = {
    bucket: 'vault', prefix, now: () => new Date('2026-11-20T00:00:00Z'), log: record => logs.push(record),
    source: { get: async key => { if (key === failGet) throw Error('throttled'); return objects.get(key); } },
    sources: {
      list: async (listPrefix, cursor) => {
        const all = [...objects].filter(([key]) => key.startsWith(listPrefix)).map(([key, value]) => ({ key, etag: value === 'too_large' ? '"big"' : value.etag }));
        // Two objects per page exercises pagination.
        const start = cursor ? Number(cursor) : 0;
        return { objects: all.slice(start, start + 2), ...(start + 2 < all.length ? { next: String(start + 2) } : {}) };
      },
    },
    rows: {
      put: async (module, item) => { expect(resolveIndexedKey(String(item.source_key).slice(prefix.length))?.module.id).toBe(module.id); rows.set(item.item_id as string, item); },
      remove: async (_module, id) => { rows.delete(id); },
    },
    index: {
      scan: async (module, cursor) => {
        const all = [...rows.values()].filter(row => resolveIndexedKey(String(row.source_key).slice(prefix.length))?.module.id === module.id).map(row => ({ id: row.item_id as string, key: row.source_key as string, etag: row.source_etag as string }));
        const start = cursor ? Number(cursor) : 0;
        return { rows: all.slice(start, start + 2), ...(start + 2 < all.length ? { next: String(start + 2) } : {}) };
      },
    },
    queue: { send: async keys => { queued.push(keys); } },
  };
  return { deps, objects, rows, queued, logs, failOn: (key: string) => { failGet = key; } };
}

describe('practice-review declaration', () => {
  it('matches only flat item notes', () => {
    expect(resolveIndexedKey(`${items}lc-1.md`)).toMatchObject({ id: 'lc-1' });
    for (const key of [`${items}nested/lc-1.md`, `${items}LC-1.md`, `${items}lc-1.txt`, `${items}lc 1.md`, 'Learning/Practice/Review/AGENTS.md']) {
      expect(resolveIndexedKey(key)).toBeUndefined();
    }
  });
  it('projects queue keys, including unstarted and archived items', () => {
    const row = (fields: Record<string, string>) => buildRow(practiceReviewIndex, 'lc-1', `${items}lc-1.md`, '"e1"', note(fields), 'now');
    expect(row({})).toEqual({ id: 'lc-1', domain: 'algorithm', title: 'LC 1 - Two Sum', status: 'active', review_count: 2, stage: 1,
      last_review: '2026-11-17', next_review: '2026-11-20', archived_on: null, queue_pk: 'algorithm#active', queue_sk: '2026-11-20',
      item_id: 'lc-1', source_key: `${items}lc-1.md`, source_etag: '"e1"', indexed_at: 'now' });
    expect(row({ stage: '0', review_count: '0', last_review: 'null', next_review: 'null' })).toMatchObject({ queue_sk: UNSTARTED_SORT });
    expect(row({ status: 'archived', next_review: 'null', archived_on: '2026-11-20' }))
      .toMatchObject({ queue_pk: 'algorithm#archived', archived_on: '2026-11-20', queue_sk: UNSTARTED_SORT });
    // Note-only fields such as the prompt never reach the index.
    expect(row({})).not.toHaveProperty('prompt');
  });
  it.each([['mismatched id', { id: 'lc-2' }], ['unknown status', { status: 'paused' }], ['bad date', { next_review: 'soon' }]])('rejects %s', (_name, fields) => {
    expect(buildRow(practiceReviewIndex, 'lc-1', `${items}lc-1.md`, '"e1"', note(fields), 'now')).toBeUndefined();
  });
  it('rejects notes without frontmatter', () => {
    expect(buildRow(practiceReviewIndex, 'lc-1', `${items}lc-1.md`, '"e1"', '# LC 1\n', 'now')).toBeUndefined();
  });
});

describe('indexKey', () => {
  it.each(['', 'Knowledge/'])('indexes, replaces and removes a note under prefix %j', async prefix => {
    const { deps, objects, rows } = fixture(prefix), key = `${prefix}${items}lc-1.md`;
    objects.set(key, { text: note({}), etag: '"e1"' });
    expect(await indexKey(deps, key)).toBe('indexed');
    objects.set(key, { text: note({ stage: '2', next_review: '2026-11-27' }), etag: '"e2"' });
    expect(await indexKey(deps, key)).toBe('indexed');
    expect(rows.get('lc-1')).toMatchObject({ stage: 2, queue_sk: '2026-11-27', source_etag: '"e2"' });
    objects.delete(key);
    expect(await indexKey(deps, key)).toBe('removed');
    expect(rows.size).toBe(0);
  });
  it('discovers a saved solution and updates the same session through completion', async () => {
    const { deps, objects, rows, queued } = fixture();
    const folder = 'Learning/Practice/System-Design/Solutions/Bitly-2026-11-21/';
    const key = folder + 'progress.md';
    deps.sources.list = async prefix => prefix === folder.slice(0, -'Bitly-2026-11-21/'.length)
      ? { folders: [folder], objects: [] } : { objects: prefix === key ? [{ key, etag: 'initial' }] : [] };
    await reconcile(deps);
    expect(queued.flat()).toEqual([key]);
    for (const [step, state] of [['Requirements', 'wip'], ['Data Flow', 'wip'], ['Deep Dives', 'done']]) {
      objects.set(key, { etag: String(step), text: `---\ntopic: Bitly\nstarted: 2026-11-21\ntags: [system-design/${state}]\n---\n| ${step} | 🔄 |` });
      expect(await indexKey(deps, key)).toBe('indexed');
      expect(rows.size).toBe(1);
      expect(rows.get('Bitly-2026-11-21')).toMatchObject({ topic: 'Bitly', current_step: step, status_pk: state });
    }
  });
  it('removes the previous row when a note becomes invalid or too large', async () => {
    const { deps, objects, rows, logs } = fixture(), key = `${items}lc-1.md`;
    objects.set(key, { text: note({}), etag: '"e1"' });
    await indexKey(deps, key);
    objects.set(key, { text: note({ status: 'paused' }), etag: '"e2"' });
    expect(await indexKey(deps, key)).toBe('invalid_source');
    expect(rows.size).toBe(0);
    objects.set(key, 'too_large');
    expect(await indexKey(deps, key)).toBe('invalid_source');
    expect(logs.at(-1)).toEqual({ event: 'invalid_source', module: 'practice-review', id: 'lc-1', reason: 'too_large' });
  });
  it('ignores keys outside the prefix and unindexed notes', async () => {
    const { deps, rows } = fixture('Knowledge/');
    for (const key of [`${items}lc-1.md`, 'Knowledge/Journal/today.md']) expect(await indexKey(deps, key)).toBe('ignored');
    expect(rows.size).toBe(0);
  });
});

describe('queue messages', () => {
  const s3 = (bucket: string, key: string) => JSON.stringify({ source: 'aws.s3', 'detail-type': 'Object Created', detail: { bucket: { name: bucket }, object: { key, etag: 'x' } } });
  it('reads keys from S3 events and reconcile requests', () => {
    expect(messageKey(s3('vault', `${items}lc-1.md`), 'vault')).toBe(`${items}lc-1.md`);
    expect(messageKey(s3('other', `${items}lc-1.md`), 'vault')).toBeUndefined();
    expect(messageKey(JSON.stringify({ key: `${items}lc-1.md`, requested_at: 'now' }), 'vault')).toBe(`${items}lc-1.md`);
    expect(() => messageKey('{"unexpected":true}', 'vault')).toThrow();
  });
  it('retries the failed message and every later message in FIFO order', async () => {
    const { deps, objects, rows, failOn } = fixture();
    for (const id of ['a', 'b', 'c']) objects.set(`${items}${id}.md`, { text: note({ id }), etag: `"${id}"` });
    failOn(`${items}b.md`);
    const records = ['a', 'b', 'c'].map(id => ({ messageId: `m-${id}`, body: s3('vault', `${items}${id}.md`) }));
    expect(await handleIndexerEvent(deps, { Records: records })).toEqual({ batchItemFailures: [{ itemIdentifier: 'm-b' }, { itemIdentifier: 'm-c' }] });
    expect([...rows.keys()]).toEqual(['a']);
  });
  it('rejects unknown direct invocations', async () => {
    const { deps } = fixture();
    await expect(handleIndexerEvent(deps, { action: 'drop' })).rejects.toThrow();
    await expect(handleIndexerEvent(deps, {})).rejects.toThrow();
    await expect(handleIndexerEvent(deps, { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} })).rejects.toThrow();
  });
});

describe('reconcile', () => {
  it('queues changed, missing and orphaned rows, then converges', async () => {
    const { deps, objects, rows, queued } = fixture();
    for (const id of ['a', 'b', 'c', 'd']) objects.set(`${items}${id}.md`, { text: note({ id }), etag: `"${id}1"` });
    objects.set(`${items}README.txt`, { text: '', etag: '"r"' });
    for (const id of ['a', 'b', 'c', 'd']) await indexKey(deps, `${items}${id}.md`);
    objects.set(`${items}b.md`, { text: note({ id: 'b', stage: '2' }), etag: '"b2"' });
    objects.delete(`${items}c.md`);
    objects.set(`${items}e.md`, { text: note({ id: 'e' }), etag: '"e1"' });
    const summary = await reconcile(deps);
    expect(queued.flat().sort()).toEqual([`${items}b.md`, `${items}c.md`, `${items}e.md`]);
    expect(summary).toEqual([{ module: 'practice-review', sources: 4, rows: 4, queued: 3, orphaned: 1 },
      { module: 'practice-session', sources: 0, rows: 0, queued: 0, orphaned: 0 }]);
    // Reconcile only queues. Applying the queue is the consumer's job.
    expect(rows.get('b')).toMatchObject({ stage: 1 });
    await handleIndexerEvent(deps, { Records: queued.flat().map((key, index) => ({ messageId: String(index), body: JSON.stringify({ key, requested_at: 'now' }) })) });
    expect([...rows.keys()].sort()).toEqual(['a', 'b', 'd', 'e']);
    queued.length = 0;
    await handleIndexerEvent(deps, { action: 'reconcile' });
    expect(queued).toEqual([]);
  });
  it('rebuild queues every source', async () => {
    const { deps, objects, queued } = fixture();
    for (let index = 0; index < 23; index += 1) objects.set(`${items}item-${index}.md`, { text: note({ id: `item-${index}` }), etag: '"e"' });
    await handleIndexerEvent(deps, { action: 'rebuild' });
    expect(queued.flat()).toEqual([...objects.keys()]);
  });
});
