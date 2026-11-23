import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoReviewIndex } from '../src/dynamo-review-index.js';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ item_id: { S: id }, id: { S: id }, domain: { S: 'algorithm' }, title: { S: `Title ${id}` },
  status: { S: 'active' }, review_count: { N: '2' }, stage: { N: '1' }, last_review: { S: '2026-11-17' }, next_review: { NULL: true },
  archived_on: { NULL: true }, queue_pk: { S: 'algorithm#active' }, queue_sk: { S: '0000-00-00' }, source_key: { S: `k/${id}.md` },
  source_etag: { S: `"${id}"` }, indexed_at: { S: 'now' }, ...extra });

function fixture(pages: Record<string, unknown>[]) {
  const send = vi.fn(async () => pages.shift());
  return { index: new DynamoReviewIndex({ send } as unknown as DynamoDBClient), send };
}

describe('DynamoReviewIndex', () => {
  it('queries one domain partition of the queue GSI and follows every page', async () => {
    const { index, send } = fixture([{ Items: [row('a')], LastEvaluatedKey: { item_id: { S: 'a' } } }, { Items: [row('b')] }]);
    const signal = AbortSignal.timeout(1000);
    expect(await index.activeReviews('algorithm', signal)).toEqual(['a', 'b'].map(id => ({ id, domain: 'algorithm', title: `Title ${id}`,
      status: 'active', review_count: 2, stage: 1, last_review: '2026-11-17', next_review: null, revision: `"${id}"` })));
    const calls = send.mock.calls as unknown as [{ input: Record<string, unknown> }, { abortSignal: AbortSignal }][];
    expect(calls[0]![0].input).toEqual({ TableName: 'obsidian-mcp-index-practice-review', IndexName: 'queue',
      KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'queue_pk' },
      ExpressionAttributeValues: { ':pk': { S: 'algorithm#active' } }, ExclusiveStartKey: undefined });
    expect(calls[1]![0].input.ExclusiveStartKey).toEqual({ item_id: { S: 'a' } });
    expect(calls[0]![1].abortSignal).toBe(signal);
  });
  it('queries only unfinished sessions and follows the status index cursor', async () => {
    const saved = (id: string) => ({ item_id: { S: id }, topic: { S: id }, current_step: { S: 'Data Flow' } });
    const cursor = { item_id: { S: 'Bitly' } };
    const { index, send } = fixture([{ Items: [saved('Bitly')], LastEvaluatedKey: cursor }, { Items: [saved('Cache')] }]);
    expect(await index.unfinishedSessions(AbortSignal.timeout(1000))).toEqual(['Bitly', 'Cache'].map(topic => ({
      folder: `Learning/Practice/System-Design/Solutions/${topic}/`, topic, current_step: 'Data Flow',
    })));
    expect(send.mock.calls).toMatchObject([
      [{ input: { IndexName: 'status', ExpressionAttributeValues: { ':wip': { S: 'wip' } } } }, {}],
      [{ input: { ExclusiveStartKey: cursor } }, {}],
    ]);
  });
  it('discovers legacy ended WIP after an empty filtered page', async () => {
    const cursor = { item_id: { S: 'older' } };
    const { index, send } = fixture([{ Items: [], LastEvaluatedKey: cursor }, { Items: [
      { item_id: { S: 'Dropbox-2026-11-23' }, topic: { S: 'Dropbox' }, round_completed_on: { S: '2026-11-23' } },
    ] }]);
    expect(await index.pendingFinalizations(AbortSignal.timeout(1000))).toEqual([{
      topic: 'Dropbox', folder: 'Learning/Practice/System-Design/Solutions/Dropbox-2026-11-23/', round_completed_on: '2026-11-23',
    }]);
    expect(send.mock.calls).toMatchObject([
      [{ input: { FilterExpression: '#status = :wip', ExpressionAttributeValues: { ':done': { S: 'done' }, ':wip': { S: 'wip' } } } }, {}],
      [{ input: { ExclusiveStartKey: cursor } }, {}],
    ]);
  });
  it.each([['without a source revision', { source_etag: { NULL: true } }], ['with an invalid summary', { status: { S: 'paused' } }]])('rejects a row %s', async (_name, extra) => {
    const { index } = fixture([{ Items: [row('a', extra)] }]);
    await expect(index.activeReviews('algorithm', AbortSignal.timeout(1000))).rejects.toThrow();
  });
});
