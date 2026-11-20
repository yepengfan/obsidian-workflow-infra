import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { indexedModules } from '../src/index-modules/index.js';
import { indexTableName } from '../src/index-modules/types.js';
import type { McpDeploymentConfig } from './mcp-permissions.js';
import { FUNCTION_MANAGEMENT_ACTIONS, LOG_GROUP_MANAGEMENT_ACTIONS } from './lambda-management.js';
import { INDEX_RESOURCES } from './practice-index-resources.js';

export function indexArns(stack: Stack) {
  const arn = (service: string, resource: string) => `arn:${stack.partition}:${service}:${stack.region}:${stack.account}:${resource}`;
  return {
    function: arn('lambda', `function:${INDEX_RESOURCES.functionName}`),
    logGroup: arn('logs', `log-group:/aws/lambda/${INDEX_RESOURCES.functionName}`),
    queue: arn('sqs', INDEX_RESOURCES.queueName), deadLetterQueue: arn('sqs', INDEX_RESOURCES.deadLetterQueueName),
    tables: indexedModules.map(module => arn('dynamodb', `table/${indexTableName(module.id)}`)),
    rules: [INDEX_RESOURCES.changeRuleName, INDEX_RESOURCES.reconcileRuleName].map(name => arn('events', `rule/${name}`)),
    alarms: INDEX_RESOURCES.alarmNames.map(name => arn('cloudwatch', `alarm:${name}`)),
    eventSourceMappings: arn('lambda', 'event-source-mapping:*'),
  };
}

/**
 * Foundation grants for the note index (local SSO procedure). The indexer reads
 * only indexed module folders and writes only index tables. The MCP runtime gets
 * read-only queries on the table indexes. Note writes are unchanged.
 */
export function grantPracticeIndex(stack: Stack, vaultBucket: string, settings: McpDeploymentConfig, execution: iam.Role, runtime: iam.Role) {
  const arns = indexArns(stack);
  const vault = `arn:${stack.partition}:s3:::${vaultBucket}`;
  const sources = indexedModules.map(module => `${settings.notePrefix}${module.sourcePrefix}`);
  const indexer = new iam.Role(stack, 'IndexerRole', {
    roleName: INDEX_RESOURCES.roleName, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'Project indexed note frontmatter into rebuildable DynamoDB index tables',
  });
  indexer.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [vault],
    conditions: { StringLike: { 's3:prefix': sources.map(source => `${source}*`) }, StringEquals: { 's3:delimiter': '/' }, NumericLessThanEquals: { 's3:max-keys': 1000 } } }));
  indexer.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: sources.map(source => `${vault}/${source}*`) }));
  indexer.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan'], resources: arns.tables }));
  indexer.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility',
    'sqs:GetQueueAttributes', 'sqs:SendMessage'], resources: [arns.queue] }));
  indexer.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${arns.logGroup}:log-stream:*`] }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: arns.tables.map(table => `${table}/index/*`) }));

  // A separate named policy keeps the MCP execution role's inline policy under
  // the IAM per-role size limit and groups every index deployment grant.
  const deployment = new iam.ManagedPolicy(stack, 'IndexDeploymentPolicy', { managedPolicyName: 'obsidian-mcp-index-deployment',
    description: 'Let the MCP CloudFormation role manage only the note index resources', roles: [execution] });
  deployment.addStatements(new iam.PolicyStatement({ actions: [...FUNCTION_MANAGEMENT_ACTIONS], resources: [arns.function] }));
  deployment.addStatements(new iam.PolicyStatement({ actions: [...LOG_GROUP_MANAGEMENT_ACTIONS, 'logs:GetDataProtectionPolicy'],
    resources: [arns.logGroup, `${arns.logGroup}:*`] }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [indexer.roleArn],
    conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } } }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['lambda:AddPermission'], resources: [arns.function],
    conditions: { StringEquals: { 'lambda:Principal': 'events.amazonaws.com' } } }));
  // Event source mappings have generated IDs; each change is bound to the indexer.
  deployment.addStatements(new iam.PolicyStatement({ actions: ['lambda:CreateEventSourceMapping', 'lambda:UpdateEventSourceMapping', 'lambda:DeleteEventSourceMapping'],
    resources: ['*'], conditions: { StringEquals: { 'lambda:FunctionArn': arns.function } } }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['lambda:GetEventSourceMapping', 'lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource'],
    resources: [arns.eventSourceMappings] }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['dynamodb:CreateTable', 'dynamodb:DescribeTable', 'dynamodb:UpdateTable', 'dynamodb:DeleteTable',
    'dynamodb:DescribeTimeToLive', 'dynamodb:UpdateTimeToLive', 'dynamodb:DescribeContinuousBackups', 'dynamodb:UpdateContinuousBackups',
    'dynamodb:DescribeContributorInsights', 'dynamodb:UpdateContributorInsights', 'dynamodb:DescribeKinesisStreamingDestination',
    'dynamodb:GetResourcePolicy', 'dynamodb:ListTagsOfResource', 'dynamodb:TagResource', 'dynamodb:UntagResource'],
  resources: arns.tables.flatMap(table => [table, `${table}/index/*`]) }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:GetQueueUrl', 'sqs:GetQueueAttributes',
    'sqs:SetQueueAttributes', 'sqs:ListQueueTags', 'sqs:TagQueue', 'sqs:UntagQueue'], resources: [arns.queue, arns.deadLetterQueue] }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['events:PutRule', 'events:DescribeRule', 'events:DeleteRule', 'events:PutTargets',
    'events:RemoveTargets', 'events:ListTargetsByRule', 'events:TagResource', 'events:UntagResource', 'events:ListTagsForResource'], resources: arns.rules }));
  deployment.addStatements(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:TagResource',
    'cloudwatch:UntagResource', 'cloudwatch:ListTagsForResource'], resources: arns.alarms }));
  // Alarm reads are metadata only and are not reliably authorized per alarm.
  deployment.addStatements(new iam.PolicyStatement({ actions: ['cloudwatch:DescribeAlarms'], resources: ['*'],
    conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } } }));
  return indexer;
}

/** CloudFormation types the MCP stack adds for the index. */
export const INDEX_RESOURCE_TYPES = ['AWS::DynamoDB::Table', 'AWS::SQS::Queue', 'AWS::SQS::QueuePolicy',
  'AWS::Events::Rule', 'AWS::Lambda::EventSourceMapping', 'AWS::CloudWatch::Alarm'];
