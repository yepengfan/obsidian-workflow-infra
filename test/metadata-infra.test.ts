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
  const deployment = mcpResources(storage, github.runtimeRoleName, '', false, true);
  const template = Template.fromStack(new GitHubTrustStack(new App(), 'Foundation', storage, github, deployment)).toJSON();
  const policies = Object.values(template.Resources).filter((r: unknown) => (r as { Type: string }).Type === 'AWS::IAM::Policy') as { Properties: { Roles: unknown[]; PolicyDocument: { Statement: { Action: string | string[]; Resource: string | string[]; Condition?: unknown }[] } } }[];
  const statement = policies.flatMap(p => p.Properties.PolicyDocument.Statement).find(s => JSON.stringify(s.Action).includes('s3tables:GetTableData'))!;
  expect(statement.Condition).toEqual({ StringEquals: { 's3tables:namespace': `b_${storage.buckets.vault.name}`, 's3tables:tableName': 'inventory' } });
  const query = policies.flatMap(p => p.Properties.PolicyDocument.Statement).find(s => JSON.stringify(s.Action).includes('athena:StartQueryExecution'))!;
  expect(JSON.stringify(query.Resource)).toContain('workgroup/obsidian-mcp-metadata');
  expect(JSON.stringify(template)).not.toContain('s3tables:*');
});
