import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { githubSchema } from '../infra/github-stack.js';
import { mcpResources } from '../infra/mcp-resources.js';
import { mcpAppSchema } from '../infra/mcp-runtime.js';
import { INDEX_RESOURCES } from '../infra/practice-index-resources.js';
import { RECONCILE_SCHEDULE } from '../infra/practice-index.js';
import { storageSchema } from '../infra/storage-config.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const cognito = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));
const code = { schemaVersion: 1 as const, sourceSha: 'local', sha256: 'a'.repeat(64), sha256Base64: 'a'.repeat(43) + '=', key: 'releases/' + 'a'.repeat(64) + '.zip', bytes: 100 };
function synth(notePrefix = '') {
  const options = mcpAppSchema.parse({ notePrefix, callbackUrls: [] });
  const stack = new CognitoStack(new App(), 'ObsidianMcp', aws, cognito, { ...mcpResources(aws, github.runtimeRoleName), notePrefix },
    { options, code, noteBucket: aws.buckets.vault.name });
  return Template.fromStack(stack).toJSON().Resources;
}

it('creates one on-demand table with the queue index and default encryption', () => {
  const resources = synth();
  expect(resources.IndexTablePracticeReview).toMatchObject({ Type: 'AWS::DynamoDB::Table', DeletionPolicy: 'Delete', Properties: {
    TableName: 'obsidian-mcp-index-practice-review', BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'item_id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [{ IndexName: 'queue', Projection: { ProjectionType: 'ALL' },
      KeySchema: [{ AttributeName: 'queue_pk', KeyType: 'HASH' }, { AttributeName: 'queue_sk', KeyType: 'RANGE' }] }] } });
  // AWS owned key: no CMK and no key policy to manage.
  expect(resources.IndexTablePracticeReview.Properties).not.toHaveProperty('SSESpecification');
});

it.each(['', 'Knowledge/'])('routes only review item changes under %j to one FIFO message group', prefix => {
  const resources = synth(prefix);
  expect(resources.IndexChangeRule.Properties).toMatchObject({ Name: INDEX_RESOURCES.changeRuleName, State: 'ENABLED', EventPattern: {
    source: ['aws.s3'], 'detail-type': ['Object Created', 'Object Deleted'],
    detail: { bucket: { name: [aws.buckets.vault.name] }, object: { key: [{ prefix: `${prefix}Learning/Practice/Review/Items/` }] } } },
  Targets: [{ Id: 'IndexQueue', Arn: { 'Fn::GetAtt': ['IndexQueue', 'Arn'] }, SqsParameters: { MessageGroupId: 'index' } }] });
  expect(resources.IndexQueuePolicy.Properties.PolicyDocument.Statement).toEqual([{ Sid: 'IndexChangeRule', Effect: 'Allow',
    Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: { 'Fn::GetAtt': ['IndexQueue', 'Arn'] },
    Condition: { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': ['IndexChangeRule', 'Arn'] } } } }]);
  expect(resources.IndexerFunction.Properties.Environment.Variables).toEqual({ NOTE_BUCKET: aws.buckets.vault.name, NOTE_PREFIX: prefix, INDEX_QUEUE_URL: { Ref: 'IndexQueue' } });
});

it('retries through a dead-letter queue with SQS-managed encryption', () => {
  const resources = synth();
  expect(resources.IndexQueue.Properties).toMatchObject({ QueueName: INDEX_RESOURCES.queueName, FifoQueue: true, ContentBasedDeduplication: true,
    SqsManagedSseEnabled: true, VisibilityTimeout: 720,
    RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': ['IndexDeadLetterQueue', 'Arn'] }, maxReceiveCount: 5 } });
  expect(resources.IndexDeadLetterQueue.Properties).toMatchObject({ QueueName: INDEX_RESOURCES.deadLetterQueueName, FifoQueue: true,
    SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 });
  expect(resources.IndexQueueMapping.Properties).toMatchObject({ EventSourceArn: { 'Fn::GetAtt': ['IndexQueue', 'Arn'] },
    FunctionName: { Ref: 'IndexerFunction' }, BatchSize: 10, FunctionResponseTypes: ['ReportBatchItemFailures'] });
});

it('runs the shared code artifact as the indexer with its own role and 30-day logs', () => {
  const resources = synth();
  expect(resources.IndexerFunction.Properties).toMatchObject({ FunctionName: INDEX_RESOURCES.functionName, Handler: 'indexer.handler',
    Runtime: 'nodejs22.x', Timeout: 120, Code: { S3Bucket: { Ref: 'CodeArtifacts' }, S3Key: code.key },
    Role: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::${aws.account}:role/obsidian-mcp-indexer`]] } });
  expect(resources.IndexerFunction.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
  expect(resources.IndexerLogs.Properties).toEqual({ LogGroupName: '/aws/lambda/obsidian-mcp-indexer', RetentionInDays: 30 });
  expect(resources.IndexerFunction.DependsOn).toContain('IndexerLogs');
});

it('reconciles daily at 03:00 Brisbane and only the schedule may invoke the indexer', () => {
  const resources = synth();
  expect(RECONCILE_SCHEDULE).toBe('cron(0 17 * * ? *)');
  const arn = (service: string, resource: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:${service}:${aws.region}:${aws.account}:${resource}`]] });
  expect(resources.IndexReconcileRule).toMatchObject({ DependsOn: expect.arrayContaining(['IndexerFunction']), Properties: { ScheduleExpression: RECONCILE_SCHEDULE,
    Targets: [{ Id: 'Indexer', Arn: arn('lambda', `function:${INDEX_RESOURCES.functionName}`), Input: '{"action":"reconcile"}' }] } });
  expect(resources.IndexReconcilePermission).toMatchObject({ DependsOn: expect.arrayContaining(['IndexReconcileRule']), Properties: {
    Principal: 'events.amazonaws.com', SourceArn: arn('events', `rule/${INDEX_RESOURCES.reconcileRuleName}`) } });
});

it('keeps an indexer code update from cascading into a conditional replacement', () => {
  // The apply gate rejects Conditional replacement. GetAtt on the function or
  // rule ARN would make every code deploy re-evaluate the rule and its permission.
  const resources = synth();
  for (const id of ['IndexReconcileRule', 'IndexReconcilePermission']) {
    expect(JSON.stringify(resources[id].Properties)).not.toMatch(/"Fn::GetAtt":\["(?:IndexerFunction|IndexReconcileRule)","Arn"\]/u);
  }
});

it('alarms in the console without notification actions', () => {
  const alarms = Object.values(synth() as Record<string, { Type: string; Properties: Record<string, unknown> }>).filter(resource => resource.Type === 'AWS::CloudWatch::Alarm');
  expect(alarms.map(alarm => alarm.Properties.AlarmName)).toEqual(INDEX_RESOURCES.alarmNames);
  for (const alarm of alarms) {
    expect(alarm.Properties).not.toHaveProperty('AlarmActions');
    expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
  }
});
