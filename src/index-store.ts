import { DeleteItemCommand, PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { INDEX_MESSAGE_GROUP, MAX_SOURCE_BYTES, type IndexCatalog, type IndexQueue, type IndexWriter, type SourceCatalog, type SourceReader } from './indexer.js';
import { indexTableName, type IndexValue } from './index-modules/types.js';

export class S3IndexSource implements SourceReader, SourceCatalog {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}
  async get(key: string) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body || !result.ETag) throw Error('Incomplete S3 response');
      if ((result.ContentLength ?? Infinity) > MAX_SOURCE_BYTES) {
        await result.Body.transformToWebStream().cancel();
        return 'too_large' as const;
      }
      return { text: await result.Body.transformToString('utf-8'), etag: result.ETag };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }
  async list(prefix: string, cursor?: string) {
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000, ContinuationToken: cursor }));
    if (result.IsTruncated && !result.NextContinuationToken) throw Error('Truncated listing without a continuation token');
    return { folders: (result.CommonPrefixes ?? []).flatMap(item => item.Prefix ? [item.Prefix] : []),
      objects: (result.Contents ?? []).flatMap(item => item.Key && item.ETag ? [{ key: item.Key, etag: item.ETag }] : []),
      ...(result.IsTruncated ? { next: result.NextContinuationToken! } : {}) };
  }
}

const attribute = (item: IndexValue): AttributeValue => item === null ? { NULL: true }
  : typeof item === 'string' ? { S: item } : typeof item === 'number' ? { N: String(item) } : { BOOL: item };

export class DynamoIndexTable implements IndexWriter, IndexCatalog {
  constructor(private readonly client: DynamoDBClient) {}
  async put(module: { id: string }, item: Record<string, IndexValue>) {
    await this.client.send(new PutItemCommand({ TableName: indexTableName(module.id),
      Item: Object.fromEntries(Object.entries(item).map(([name, field]) => [name, attribute(field)])) }));
  }
  async remove(module: { id: string }, id: string) {
    await this.client.send(new DeleteItemCommand({ TableName: indexTableName(module.id), Key: { item_id: { S: id } } }));
  }
  async scan(module: { id: string }, cursor?: string) {
    const result = await this.client.send(new ScanCommand({ TableName: indexTableName(module.id),
      ProjectionExpression: 'item_id, source_key, source_etag', ...(cursor ? { ExclusiveStartKey: { item_id: { S: cursor } } } : {}) }));
    return { rows: (result.Items ?? []).map(item => ({ id: item.item_id?.S ?? '', key: item.source_key?.S ?? '', etag: item.source_etag?.S ?? '' })),
      ...(result.LastEvaluatedKey?.item_id?.S ? { next: result.LastEvaluatedKey.item_id.S } : {}) };
  }
}

const SQS_BATCH_SIZE = 10;

export class SqsIndexQueue implements IndexQueue {
  constructor(private readonly client: SQSClient, private readonly url: string) {}
  async send(keys: string[]) {
    for (let start = 0; start < keys.length; start += SQS_BATCH_SIZE) {
      await this.sendBatch(keys.slice(start, start + SQS_BATCH_SIZE));
    }
  }

  private async sendBatch(keys: string[]) {
    const requestedAt = new Date().toISOString();
    const result = await this.client.send(new SendMessageBatchCommand({ QueueUrl: this.url,
      Entries: keys.map((key, index) => ({ Id: String(index), MessageGroupId: INDEX_MESSAGE_GROUP, MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({ key, requested_at: requestedAt }) })) }));
    if (result.Failed?.length) throw Error(`Failed to queue ${result.Failed.length} index requests`);
  }
}
