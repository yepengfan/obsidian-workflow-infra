import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { handleIndexerEvent, type IndexerDependencies } from './indexer.js';
import { DynamoIndexTable, S3IndexSource, SqsIndexQueue } from './index-store.js';

/** Composition root for the indexer Lambda. */
export function indexerDependencies(env: NodeJS.ProcessEnv): IndexerDependencies {
  const required = (name: string) => { const setting = env[name]; if (!setting) throw Error(`Missing ${name}`); return setting; };
  const bucket = required('NOTE_BUCKET'), region = required('AWS_REGION');
  const source = new S3IndexSource(new S3Client({ region, maxAttempts: 3 }), bucket);
  const table = new DynamoIndexTable(new DynamoDBClient({ region, maxAttempts: 3 }));
  return { bucket, prefix: env.NOTE_PREFIX ?? '', source, sources: source, rows: table, index: table,
    queue: new SqsIndexQueue(new SQSClient({ region, maxAttempts: 3 }), required('INDEX_QUEUE_URL')),
    now: () => new Date(), log: record => console.info(JSON.stringify(record)) };
}

let warm: IndexerDependencies | undefined;
export async function handler(event: unknown) {
  warm ??= indexerDependencies(process.env);
  return handleIndexerEvent(warm, event);
}
