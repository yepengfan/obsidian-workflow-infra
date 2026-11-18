import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { StorageStack } from '../infra/storage-stack.js';
import { storageSchema } from '../infra/storage-config.js';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { GitHubTrustStack, githubSchema } from '../infra/github-stack.js';
import { mcpResources } from '../infra/mcp-resources.js';
import { mcpAppSchema } from '../infra/mcp-runtime.js';

const load = (name: string) => JSON.parse(fs.readFileSync(`config/${name}.json`, 'utf8'));
const storage = storageSchema.parse(load('storage')), github = githubSchema.parse(load('github'));
const code = { schemaVersion: 1 as const, sourceSha: 'local', sha256: 'a'.repeat(64), sha256Base64: 'a'.repeat(43) + '=', key: 'releases/' + 'a'.repeat(64) + '.zip', bytes: 100 };
type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };
type Resource = { Type: string; Properties: { RoleName?: string; Roles?: { Ref: string }[]; PolicyDocument?: { Statement: Statement[] } } };
function foundationPolicies() {
  const deployment = mcpResources(storage, github.runtimeRoleName, '', false, true);
  const resources = Template.fromStack(new GitHubTrustStack(new App(), 'Foundation', storage, github, deployment)).toJSON().Resources as Record<string, Resource>;
  return (name: string) => {
    const role = Object.entries(resources).find(([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === name)![0];
    return Object.values(resources).filter(r => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some(ref => ref.Ref === role))
      .flatMap(r => r.Properties.PolicyDocument!.Statement);
  };
}
const actions = (statement: Statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action];
const tableResource = (path: string) => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:s3tables:${storage.region}:${storage.account}:bucket/${path}`]] });

it('enables inventory only on the vault and expires the required journal after seven days', () => {
  const template = Template.fromStack(new StorageStack(new App(), 'Storage', storage, true)).toJSON();
  expect(template.Resources.Vault.Properties.MetadataConfiguration).toEqual({
    InventoryTableConfiguration: { ConfigurationState: 'ENABLED', EncryptionConfiguration: { SseAlgorithm: 'AES256' } },
    JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: 7 }, EncryptionConfiguration: { SseAlgorithm: 'AES256' } },
  });
  expect(template.Resources.Library.Properties.MetadataConfiguration).toBeUndefined();
  expect(template.Resources.Vault.DeletionPolicy).toBe('Retain');
});

it('uses a capped on-demand workgroup with managed results and a retained native IAM catalog', () => {
  const options = mcpAppSchema.parse({ notePrefix: '', metadataSearch: true });
  const deployment = mcpResources(storage, github.runtimeRoleName, '', false, true);
  const resources = Template.fromStack(new CognitoStack(new App(), 'Mcp', storage, cognitoSchema.parse(load('cognito')), deployment,
    { options, code, noteBucket: storage.buckets.vault.name })).toJSON().Resources;
  expect(resources.MetadataWorkgroup.Properties.WorkGroupConfiguration).toMatchObject({ EnforceWorkGroupConfiguration: true,
    BytesScannedCutoffPerQuery: 268435456, ManagedQueryResultsConfiguration: { Enabled: true } });
  expect(resources.MetadataWorkgroup.Properties.WorkGroupConfiguration).not.toHaveProperty('ExecutionRole');
  expect(resources.S3TablesCatalog.Properties).toMatchObject({ Name: 's3tablescatalog', FederatedCatalog: { ConnectionName: 'aws:s3tables' } });
  expect(resources.S3TablesCatalog.DeletionPolicy).toBe('Retain');
  expect(resources.McpFunction.DependsOn).toEqual(expect.arrayContaining(['S3TablesCatalog', 'MetadataWorkgroup']));
  expect(Object.values(resources).filter((r: unknown) => (r as { Type: string }).Type === 'AWS::S3::Bucket')).toHaveLength(1);
});

it('limits runtime table access to this vault inventory and query access to its workgroup', () => {
  const policies = foundationPolicies()(github.runtimeRoleName);
  const statement = policies.find(s => actions(s).includes('s3tables:GetTableData'))!;
  expect(statement.Condition).toEqual({ StringEquals: { 's3tables:namespace': `b_${storage.buckets.vault.name}`, 's3tables:tableName': 'inventory' } });
  const query = policies.find(s => actions(s).includes('athena:StartQueryExecution'))!;
  expect(JSON.stringify(query.Resource)).toContain('workgroup/obsidian-mcp-metadata');
  expect(JSON.stringify(policies)).not.toContain('s3tables:*');
});

it('allows first-time namespace creation without an unsupported namespace condition', () => {
  const policies = foundationPolicies()(github.executionRoleName);
  const namespace = policies.find(s => actions(s).includes('s3tables:CreateNamespace'))!;
  // AWS supplies no s3tables:namespace context for CreateNamespace. A StringEquals
  // check on it denies the first metadata configuration before tables exist.
  expect(namespace.Condition).toBeUndefined();
  expect(namespace.Resource).toEqual(tableResource('aws-s3'));
  const table = policies.find(s => actions(s).includes('s3tables:CreateTable'))!;
  expect(table.Condition).toEqual({ StringEquals: { 's3tables:namespace': `b_${storage.buckets.vault.name}` } });
});

it('allows the encryption authorization checked against the bucket when creating metadata tables', () => {
  const policies = foundationPolicies()(github.executionRoleName);
  const encryption = policies.filter(s => actions(s).includes('s3tables:PutTableEncryption'));
  // Live CreateTable with AES256 authorizes this dependent action on the bucket,
  // before a table ARN exists. A table-only grant leaves configuration FAILED.
  expect(encryption).toEqual(expect.arrayContaining([
    expect.objectContaining({ Resource: tableResource('aws-s3') }),
  ]));
  expect(encryption.find(s => JSON.stringify(s.Resource) === JSON.stringify(tableResource('aws-s3')))!.Condition).toBeUndefined();
  for (const statement of encryption) {
    expect([tableResource('aws-s3'), tableResource('aws-s3/table/*')]).toContainEqual(statement.Resource);
  }
  const tableEncryption = encryption.find(s => JSON.stringify(s.Resource) === JSON.stringify(tableResource('aws-s3/table/*')))!;
  expect(tableEncryption.Condition).toEqual({ StringEquals: {
    's3tables:namespace': `b_${storage.buckets.vault.name}`, 's3tables:tableName': ['inventory', 'journal'],
  } });
});

it('grants the catalog deployment role the regional read prerequisites without table writes', () => {
  const policies = foundationPolicies()(github.mcpExecutionRoleName);
  const readActions = ['s3tables:GetTableBucket', 's3tables:GetNamespace', 's3tables:GetTable', 's3tables:GetTableMetadataLocation', 's3tables:GetTableData'];
  const statements = policies.filter(s => actions(s).some(action => action.startsWith('s3tables:')));
  expect(statements.flatMap(actions).sort()).toEqual(readActions.sort());
  for (const action of readActions) {
    const statement = statements.find(s => actions(s).includes(action))!;
    expect(statement.Resource).toEqual(tableResource(`*${['s3tables:GetTableBucket', 's3tables:GetNamespace'].includes(action) ? '' : '/table/*'}`));
  }
  expect(policies.flatMap(actions)).toEqual(expect.arrayContaining(['glue:GetDatabase', 'glue:GetTable']));
});
