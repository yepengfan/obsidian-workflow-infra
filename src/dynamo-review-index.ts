import { DynamoDBClient, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { practiceSessionIndex, solutions } from './index-modules/practice-session.js';
import { practiceReviewIndex } from './index-modules/practice-review.js';
import { indexAttributes, indexTableName } from './index-modules/types.js';
import type { PracticeDomain } from './practice-domains.js';
import { reviewSummarySchema } from './practice-schema.js';
import type { IndexedReview, ReviewIndex, SessionIndex } from './review-index.js';

const scalar = (value: AttributeValue | undefined) => value === undefined || value.NULL ? null
  : value.S ?? (value.N !== undefined ? Number(value.N) : value.BOOL ?? null);

export class DynamoReviewIndex implements ReviewIndex, SessionIndex {
  private readonly table = indexTableName(practiceReviewIndex.id);
  private readonly queue = indexAttributes('queue');
  constructor(private readonly client: DynamoDBClient) {}
  async unfinishedSessions(signal: AbortSignal) {
    const sessions = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({ TableName: indexTableName(practiceSessionIndex.id), IndexName: 'status',
        KeyConditionExpression: 'status_pk = :wip', ExpressionAttributeValues: { ':wip': { S: 'wip' } },
        ScanIndexForward: false, ExclusiveStartKey: start }), { abortSignal: signal });
      for (const row of page.Items ?? []) {
        const id = row.item_id?.S;
        if (!id || !row.topic?.S || practiceSessionIndex.matches(id + '/progress.md') !== id) throw Error('Invalid session index row');
        sessions.push({ folder: solutions + id + '/', topic: row.topic.S, current_step: row.current_step?.S ?? null });
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return sessions;
  }
  async finishedSessions(signal: AbortSignal) {
    const sessions = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      // The done partition holds every ended round, including legacy and still-WIP ones.
      const page = await this.client.send(new QueryCommand({ TableName: indexTableName(practiceSessionIndex.id), IndexName: 'status',
        KeyConditionExpression: 'status_pk = :done', ExpressionAttributeValues: { ':done': { S: 'done' } }, ExclusiveStartKey: start }), { abortSignal: signal });
      for (const row of page.Items ?? []) {
        const id = row.item_id?.S;
        if (!id || practiceSessionIndex.matches(id + '/progress.md') !== id || !row.topic?.S) throw Error('Invalid ended session');
        sessions.push({ folder: solutions + id + '/', topic: row.topic.S });
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return sessions;
  }
  async pendingFinalizations(signal: AbortSignal) {
    const sessions = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      // Ended WIP rows already reside in the done partition, including legacy rounds.
      const page = await this.client.send(new QueryCommand({ TableName: indexTableName(practiceSessionIndex.id), IndexName: 'status',
        KeyConditionExpression: 'status_pk = :done', FilterExpression: '#status = :wip',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':done': { S: 'done' }, ':wip': { S: 'wip' } },
        ExclusiveStartKey: start }), { abortSignal: signal });
      for (const row of page.Items ?? []) {
        const id = row.item_id?.S;
        if (!id || practiceSessionIndex.matches(id + '/progress.md') !== id || !row.topic?.S || !row.round_completed_on?.S) throw Error('Invalid ended session');
        sessions.push({ folder: solutions + id + '/', topic: row.topic.S, round_completed_on: row.round_completed_on.S });
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return sessions;
  }
  async activeReviews(domain: PracticeDomain, signal: AbortSignal): Promise<IndexedReview[]> {
    const rows: IndexedReview[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({ TableName: this.table, IndexName: 'queue',
        KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': this.queue.partition },
        ExpressionAttributeValues: { ':pk': { S: `${domain}#active` } }, ExclusiveStartKey: start }), { abortSignal: signal });
      for (const item of result.Items ?? []) {
        const values = Object.fromEntries(Object.entries(item).map(([name, value]) => [name, scalar(value)]));
        const revision = values.source_etag;
        if (typeof revision !== 'string' || !revision) throw Error('Index row without a source revision');
        rows.push({ ...reviewSummarySchema.parse(values), revision });
      }
      start = result.LastEvaluatedKey;
    } while (start);
    return rows;
  }
}

export const createReviewIndex = (region: string): ReviewIndex & SessionIndex => new DynamoReviewIndex(new DynamoDBClient({ region, maxAttempts: 2 }));
