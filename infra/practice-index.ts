import { RemovalPolicy, Stack, type CfnResource } from 'aws-cdk-lib';
import { CfnAlarm } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnTable } from 'aws-cdk-lib/aws-dynamodb';
import { CfnRule } from 'aws-cdk-lib/aws-events';
import { CfnEventSourceMapping, CfnFunction, CfnPermission } from 'aws-cdk-lib/aws-lambda';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { CfnQueue, CfnQueuePolicy } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { INDEX_MESSAGE_GROUP } from '../src/indexer.js';
import { indexedModules } from '../src/index-modules/index.js';
import { indexAttributes, indexTableName } from '../src/index-modules/types.js';
import { INDEX_RESOURCES } from './practice-index-resources.js';

/** 03:00 Australia/Brisbane (UTC+10, no daylight saving). */
export const RECONCILE_SCHEDULE = 'cron(0 17 * * ? *)';
const tags = [{ key: 'Project', value: 'obsidian-mcp' }];
const timeoutSeconds = 120;

export interface IndexSource { noteBucket: string; notePrefix: string; codeBucket: string; codeKey: string }

/**
 * Event-driven note index. S3 changes reach EventBridge, then one FIFO message
 * group, so a single consumer applies them in order. A daily reconcile compares
 * ETags and queues any drift. Every table can be rebuilt from the notes.
 */
export function addPracticeIndex(scope: Construct, source: IndexSource) {
  const stack = Stack.of(scope);
  const tables = indexedModules.map(module => {
    const indexes = Object.keys(module.indexes).map(name => ({ name, ...indexAttributes(name) }));
    const table = new CfnTable(scope, `IndexTable${module.id.replace(/(?:^|-)([a-z])/gu, (_match, letter: string) => letter.toUpperCase())}`, {
      tableName: indexTableName(module.id), billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: [{ attributeName: 'item_id', attributeType: 'S' },
        ...indexes.flatMap(index => [{ attributeName: index.partition, attributeType: 'S' }, { attributeName: index.sort, attributeType: 'S' }])],
      keySchema: [{ attributeName: 'item_id', keyType: 'HASH' }],
      globalSecondaryIndexes: indexes.map(index => ({ indexName: index.name, projection: { projectionType: 'ALL' },
        keySchema: [{ attributeName: index.partition, keyType: 'HASH' }, { attributeName: index.sort, keyType: 'RANGE' }] })),
      // No SSESpecification: DynamoDB encrypts with an AWS owned key at no charge.
      tags,
    });
    return table;
  });
  const deadLetters = new CfnQueue(scope, 'IndexDeadLetterQueue', { queueName: INDEX_RESOURCES.deadLetterQueueName, fifoQueue: true,
    messageRetentionPeriod: 14 * 24 * 3600, sqsManagedSseEnabled: true, tags });
  const queue = new CfnQueue(scope, 'IndexQueue', { queueName: INDEX_RESOURCES.queueName, fifoQueue: true, contentBasedDeduplication: true,
    // Lambda's guidance for queue triggers: at least six times the function timeout.
    visibilityTimeout: 6 * timeoutSeconds, messageRetentionPeriod: 4 * 24 * 3600, sqsManagedSseEnabled: true,
    redrivePolicy: { deadLetterTargetArn: deadLetters.attrArn, maxReceiveCount: 5 }, tags });
  const changes = new CfnRule(scope, 'IndexChangeRule', { name: INDEX_RESOURCES.changeRuleName, state: 'ENABLED',
    description: 'Queue changed indexed notes for the note indexer',
    eventPattern: { source: ['aws.s3'], 'detail-type': ['Object Created', 'Object Deleted'], detail: {
      bucket: { name: [source.noteBucket] },
      object: { key: indexedModules.map(module => ({ prefix: `${source.notePrefix}${module.sourcePrefix}` })) } } },
    targets: [{ id: 'IndexQueue', arn: queue.attrArn, sqsParameters: { messageGroupId: INDEX_MESSAGE_GROUP } }], tags });
  const queuePolicy = new CfnQueuePolicy(scope, 'IndexQueuePolicy', { queues: [queue.ref], policyDocument: { Version: '2012-10-17', Statement: [{
    Sid: 'IndexChangeRule', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queue.attrArn,
    Condition: { ArnEquals: { 'aws:SourceArn': changes.attrArn } } }] } });
  const logs = new CfnLogGroup(scope, 'IndexerLogs', { logGroupName: `/aws/lambda/${INDEX_RESOURCES.functionName}`, retentionInDays: INDEX_RESOURCES.logDays });
  const indexer = new CfnFunction(scope, 'IndexerFunction', { functionName: INDEX_RESOURCES.functionName,
    runtime: 'nodejs22.x', handler: 'indexer.handler', architectures: ['x86_64'], memorySize: 256, timeout: timeoutSeconds,
    role: `arn:${stack.partition}:iam::${stack.account}:role/${INDEX_RESOURCES.roleName}`,
    // No reserved concurrency: one FIFO message group already serializes writes,
    // and overlapping reconciles only queue duplicate, idempotent requests.
    code: { s3Bucket: source.codeBucket, s3Key: source.codeKey },
    environment: { variables: { NOTE_BUCKET: source.noteBucket, NOTE_PREFIX: source.notePrefix, INDEX_QUEUE_URL: queue.ref } }, tags });
  indexer.addResourceDependency(logs);
  const mapping = new CfnEventSourceMapping(scope, 'IndexQueueMapping', { eventSourceArn: queue.attrArn, functionName: indexer.ref,
    batchSize: 10, functionResponseTypes: ['ReportBatchItemFailures'], enabled: true, tags });
  // Name-derived ARNs, not GetAtt: a code update to the indexer must not make
  // CloudFormation re-evaluate the rule and flag its permission for replacement.
  const indexerArn = `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:${INDEX_RESOURCES.functionName}`;
  const reconcileArn = `arn:${stack.partition}:events:${stack.region}:${stack.account}:rule/${INDEX_RESOURCES.reconcileRuleName}`;
  const reconcile = new CfnRule(scope, 'IndexReconcileRule', { name: INDEX_RESOURCES.reconcileRuleName, state: 'ENABLED',
    description: 'Daily ETag reconcile of every note index', scheduleExpression: RECONCILE_SCHEDULE,
    targets: [{ id: 'Indexer', arn: indexerArn, input: JSON.stringify({ action: 'reconcile' }) }], tags });
  reconcile.addDependency(indexer);
  const invoke = new CfnPermission(scope, 'IndexReconcilePermission', { action: 'lambda:InvokeFunction', functionName: indexer.ref,
    principal: 'events.amazonaws.com', sourceArn: reconcileArn, sourceAccount: stack.account });
  invoke.addDependency(reconcile);
  // Console-visible alarms without notification actions.
  const alarm = (id: string, alarmName: string, description: string, namespace: string, metricName: string, dimension: [string, string], statistic: string, period: number, threshold: number) =>
    new CfnAlarm(scope, id, { alarmName, alarmDescription: description, namespace, metricName, statistic, period, threshold,
      dimensions: [{ name: dimension[0], value: dimension[1] }], evaluationPeriods: 1, comparisonOperator: 'GreaterThanThreshold',
      treatMissingData: 'notBreaching', tags });
  const [deadLetterAlarm, backlogAlarm, errorAlarm] = INDEX_RESOURCES.alarmNames;
  const alarms = [
    alarm('IndexDeadLetterAlarm', deadLetterAlarm, 'Index changes failed five times. Inspect, purge, then run a reconcile.',
      'AWS/SQS', 'ApproximateNumberOfMessagesVisible', ['QueueName', INDEX_RESOURCES.deadLetterQueueName], 'Maximum', 300, 0),
    alarm('IndexBacklogAlarm', backlogAlarm, 'An index change has waited more than 30 minutes.',
      'AWS/SQS', 'ApproximateAgeOfOldestMessage', ['QueueName', INDEX_RESOURCES.queueName], 'Maximum', 300, 1800),
    alarm('IndexErrorAlarm', errorAlarm, 'The indexer or reconcile invocation failed.',
      'AWS/Lambda', 'Errors', ['FunctionName', INDEX_RESOURCES.functionName], 'Sum', 3600, 0),
  ];
  const resources: CfnResource[] = [...tables, deadLetters, queue, changes, queuePolicy, logs, indexer, mapping, reconcile, invoke, ...alarms];
  for (const resource of resources) {
    resource.overrideLogicalId(resource.node.id);
    // The index is a projection of the notes: rebuild instead of retaining it.
    resource.applyRemovalPolicy(RemovalPolicy.DESTROY, { applyToUpdateReplacePolicy: true });
  }
  return { tables, queue, deadLetters, indexer };
}
