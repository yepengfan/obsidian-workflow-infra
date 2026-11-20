import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { DynamoIndexTable, S3IndexSource, SqsIndexQueue } from '../src/index-store.js';
import { practiceReviewIndex } from '../src/index-modules/practice-review.js';

const client = <T>(send: (command: { input: unknown; constructor: { name: string } }) => unknown) => {
  const fn = vi.fn(async (command: { input: unknown; constructor: { name: string } }) => send(command));
  return { client: { send: fn } as unknown as T, send: fn };
};
const body = (text: string) => ({ transformToString: async () => text, transformToWebStream: () => new ReadableStream() });

describe('S3IndexSource', () => {
  it('returns the current text and ETag, undefined when missing, and refuses large notes', async () => {
    const objects: Record<string, unknown> = { a: { Body: body('note'), ETag: '"e"', ContentLength: 4 }, big: { Body: body(''), ETag: '"b"', ContentLength: 262145 } };
    const { client: s3 } = client<S3Client>(command => {
      const key = (command.input as { Key: string }).Key;
      if (!(key in objects)) throw new NoSuchKey({ message: 'missing', $metadata: {} });
      return objects[key];
    });
    const source = new S3IndexSource(s3, 'vault');
    expect(await source.get('a')).toEqual({ text: 'note', etag: '"e"' });
    expect(await source.get('big')).toBe('too_large');
    expect(await source.get('gone')).toBeUndefined();
  });
  it('lists one folder level with continuation and propagates other errors', async () => {
    const { client: s3, send } = client<S3Client>(() => ({ Contents: [{ Key: 'p/a.md', ETag: '"a"' }, { Key: 'p/b.md' }], IsTruncated: true, NextContinuationToken: 't' }));
    expect(await new S3IndexSource(s3, 'vault').list('p/')).toEqual({ objects: [{ key: 'p/a.md', etag: '"a"' }], next: 't' });
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: 'vault', Prefix: 'p/', Delimiter: '/', MaxKeys: 1000, ContinuationToken: undefined });
    const { client: failing } = client<S3Client>(() => { throw Error('throttled'); });
    await expect(new S3IndexSource(failing, 'vault').get('a')).rejects.toThrow('throttled');
  });
});

describe('DynamoIndexTable', () => {
  it('writes typed attributes, deletes by item_id and pages scans', async () => {
    const { client: dynamo, send } = client<DynamoDBClient>(command => command.constructor.name === 'ScanCommand'
      ? { Items: [{ item_id: { S: 'a' }, source_key: { S: 'p/a.md' }, source_etag: { S: '"e"' } }], LastEvaluatedKey: { item_id: { S: 'a' } } } : {});
    const table = new DynamoIndexTable(dynamo);
    await table.put(practiceReviewIndex, { item_id: 'a', stage: 2, next_review: null, active: true });
    expect(send.mock.calls[0]![0].input).toEqual({ TableName: 'obsidian-mcp-index-practice-review',
      Item: { item_id: { S: 'a' }, stage: { N: '2' }, next_review: { NULL: true }, active: { BOOL: true } } });
    await table.remove(practiceReviewIndex, 'a');
    expect(send.mock.calls[1]![0].input).toEqual({ TableName: 'obsidian-mcp-index-practice-review', Key: { item_id: { S: 'a' } } });
    expect(await table.scan(practiceReviewIndex, 'z')).toEqual({ rows: [{ id: 'a', key: 'p/a.md', etag: '"e"' }], next: 'a' });
    expect(send.mock.calls[2]![0].input).toMatchObject({ ExclusiveStartKey: { item_id: { S: 'z' } } });
  });
});

describe('SqsIndexQueue', () => {
  it('sends keys in order across SQS batches of at most ten', async () => {
    const keys = Array.from({ length: 23 }, (_, index) => `${index}.md`);
    const { client: sqs, send } = client<SQSClient>(() => ({}));
    await new SqsIndexQueue(sqs, 'url').send(keys);
    const batches = send.mock.calls.map(([command]) =>
      (command.input as { Entries: { MessageBody: string }[] }).Entries);
    expect(batches.map(batch => batch.length)).toEqual([10, 10, 3]);
    expect(batches.flat().map(entry => JSON.parse(entry.MessageBody).key)).toEqual(keys);
  });

  it('sends one FIFO group with unique deduplication IDs and fails on partial failure', async () => {
    const { client: sqs, send } = client<SQSClient>(() => ({ Failed: [] }));
    await new SqsIndexQueue(sqs, 'url').send(['a.md', 'b.md']);
    const entries = (send.mock.calls[0]![0].input as { Entries: { MessageGroupId: string; MessageDeduplicationId: string; MessageBody: string }[] }).Entries;
    expect(entries.map(entry => entry.MessageGroupId)).toEqual(['index', 'index']);
    expect(new Set(entries.map(entry => entry.MessageDeduplicationId)).size).toBe(2);
    expect(JSON.parse(entries[0]!.MessageBody)).toMatchObject({ key: 'a.md' });
    const { client: partial } = client<SQSClient>(() => ({ Failed: [{ Id: '0' }] }));
    await expect(new SqsIndexQueue(partial, 'url').send(['a.md'])).rejects.toThrow('Failed to queue 1');
  });
});
