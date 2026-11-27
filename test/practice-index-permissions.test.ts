import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { loadGitHubConfig, GitHubTrustStack } from '../infra/github-stack.js';
import { mcpResources } from '../infra/mcp-resources.js';
import { MCP_RESOURCE_TYPES } from '../infra/mcp-permissions.js';
import { INDEX_RESOURCE_TYPES } from '../infra/practice-index-permissions.js';
import { INDEX_RESOURCES } from '../infra/practice-index-resources.js';
import { storageSchema } from '../infra/storage-config.js';

const storage = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const config = loadGitHubConfig(storage.region);
type Statement = { Action: string | string[]; Resource: unknown; Effect: string; Condition?: Record<string, Record<string, unknown>> };
const actions = (s: Statement) => [s.Action].flat();

function build(notePrefix = '') {
  const stack = new GitHubTrustStack(new App(), 'Trust', storage, config, { ...mcpResources(storage, config.runtimeRoleName), notePrefix });
  const template = Template.fromStack(stack);
  const roleId = (name: string) => Object.entries(template.findResources('AWS::IAM::Role')).find(([, r]) => r.Properties.RoleName === name)![0];
  const policies = [...Object.values(template.findResources('AWS::IAM::Policy')), ...Object.values(template.findResources('AWS::IAM::ManagedPolicy'))];
  const statements = (name: string): Statement[] => policies
    .filter(p => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId(name)))
    .flatMap(p => p.Properties.PolicyDocument.Statement);
  const arn = (service: string, resource: string) => stack.resolve(`arn:${stack.partition}:${service}:${storage.region}:${storage.account}:${resource}`);
  return { stack, template, statements, arn };
}

describe('note index permission boundary', () => {
  it.each(['', 'Knowledge/'])('lets the indexer read only the review items folder under %j and write only the index', prefix => {
    const { stack, statements, arn } = build(prefix);
    const indexer = statements(INDEX_RESOURCES.roleName);
    const vault = `arn:${stack.partition}:s3:::${storage.buckets.vault.name}`;
    expect(indexer.flatMap(actions).sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:Scan', 'logs:CreateLogStream', 'logs:PutLogEvents',
      's3:GetObject', 's3:ListBucket', 'sqs:ChangeMessageVisibility', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage', 'sqs:SendMessage']);
    expect(indexer.find(s => actions(s).includes('s3:ListBucket'))).toMatchObject({ Resource: stack.resolve(vault), Condition: {
      StringLike: { 's3:prefix': [`${prefix}Learning/Practice/Review/Items/*`, `${prefix}Learning/Practice/System-Design/Solutions/*`] }, StringEquals: { 's3:delimiter': '/' }, NumericLessThanEquals: { 's3:max-keys': 1000 } } });
    expect(indexer.find(s => actions(s).includes('s3:GetObject'))!.Resource).toEqual(stack.resolve([`${vault}/${prefix}Learning/Practice/Review/Items/*`, `${vault}/${prefix}Learning/Practice/System-Design/Solutions/*/progress.md`]));
    expect(indexer.find(s => actions(s).includes('dynamodb:PutItem'))!.Resource).toEqual(['practice-review', 'practice-session'].map(id => arn('dynamodb', 'table/obsidian-mcp-index-' + id)));
    // The consumer can never read or drain the dead-letter queue.
    expect(indexer.find(s => actions(s).includes('sqs:ReceiveMessage'))!.Resource).toEqual(arn('sqs', INDEX_RESOURCES.queueName));
    expect(JSON.stringify(indexer)).not.toContain(storage.buckets.library.name);
  });

  it('gives the MCP runtime read-only queries on index GSIs only', () => {
    const { statements, arn } = build();
    const dynamo = statements(config.runtimeRoleName).filter(s => actions(s).some(a => a.startsWith('dynamodb:')));
    expect(dynamo).toEqual([{ Effect: 'Allow', Action: 'dynamodb:Query', Resource: ['practice-review', 'practice-session'].map(id => arn('dynamodb', 'table/obsidian-mcp-index-' + id + '/index/*')) }]);
  });

  it('keeps every index deployment grant in one named policy without data-plane access', () => {
    const { template, statements, arn } = build();
    const [policy] = Object.values(template.findResources('AWS::IAM::ManagedPolicy'));
    expect(policy!.Properties.ManagedPolicyName).toBe('obsidian-mcp-index-deployment');
    const deployment: Statement[] = policy!.Properties.PolicyDocument.Statement;
    const granted = deployment.flatMap(actions);
    for (const forbidden of ['dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem',
      'sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:PurgeQueue', 's3:GetObject', 's3:PutObject', 'lambda:InvokeFunction']) {
      expect(granted).not.toContain(forbidden);
    }
    expect(deployment.find(s => actions(s).includes('lambda:CreateEventSourceMapping'))).toMatchObject({
      Resource: '*', Condition: { StringEquals: { 'lambda:FunctionArn': arn('lambda', `function:${INDEX_RESOURCES.functionName}`) } } });
    expect(deployment.find(s => actions(s).includes('lambda:AddPermission'))).toMatchObject({
      Resource: arn('lambda', `function:${INDEX_RESOURCES.functionName}`), Condition: { StringEquals: { 'lambda:Principal': 'events.amazonaws.com' } } });
    for (const statement of deployment.filter(s => s.Resource === '*')) expect(statement.Condition).toBeDefined();
    for (const statement of deployment.filter(s => s.Resource !== '*')) expect(JSON.stringify(statement.Resource)).toMatch(/obsidian-mcp-index|event-source-mapping|IndexerRole/u);
    // Only the indexer role, and only to Lambda.
    const indexerRole = Object.entries(template.findResources('AWS::IAM::Role')).find(([, r]) => r.Properties.RoleName === INDEX_RESOURCES.roleName)![0];
    expect(deployment.filter(s => actions(s).includes('iam:PassRole'))).toEqual([{ Effect: 'Allow', Action: 'iam:PassRole',
      Resource: { 'Fn::GetAtt': [indexerRole, 'Arn'] }, Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } } }]);
    expect(statements(config.mcpExecutionRoleName).filter(s => actions(s).includes('iam:PassRole'))).toHaveLength(2);
  });

  it('allows the plan role to create MCP change sets with the index resource types', () => {
    const { statements } = build();
    expect(MCP_RESOURCE_TYPES).toEqual(expect.arrayContaining(INDEX_RESOURCE_TYPES));
    const create = statements(config.planRoleName).find(s => actions(s).includes('cloudformation:CreateChangeSet') &&
      JSON.stringify(s.Resource).includes('ObsidianMcp'))!;
    expect(create.Condition!['ForAllValues:StringEquals']!['cloudformation:ResourceTypes']).toEqual(MCP_RESOURCE_TYPES);
  });
});
