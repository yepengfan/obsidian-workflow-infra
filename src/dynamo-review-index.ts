import { DynamoDBClient, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { practiceReviewIndex } from './index-modules/practice-review.js';
import { indexAttributes, indexTableName } from './index-modules/types.js';
import type { PracticeDomain } from './practice-domains.js';
import { reviewSummarySchema } from './practice-schema.js';
import type { IndexedReview, ReviewIndex } from './review-index.js';

const scalar = (value: AttributeValue | undefined) => value === undefined || value.NULL ? null
  : value.S ?? (value.N !== undefined ? Number(value.N) : value.BOOL ?? null);

/** Queries the practice-review table's queue GSI for one domain's active rows. */
export class DynamoReviewIndex implements ReviewIndex {
  private readonly table = indexTableName(practiceReviewIndex.id);
  private readonly queue = indexAttributes('queue');
  constructor(private readonly client: DynamoDBClient) {}
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

export const createReviewIndex = (region: string): ReviewIndex => new DynamoReviewIndex(new DynamoDBClient({ region, maxAttempts: 2 }));
