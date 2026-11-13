import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { storageSchema } from '../infra/storage-config.js';
import { StorageStack } from '../infra/storage-stack.js';

const baseline = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const synth = (config = baseline) => Template.fromStack(new StorageStack(new App(), 'Test', config)).toJSON();

describe('existing storage import baseline', () => {
  it('models both original buckets without creating policies or cleanup machinery', () => {
    const template = synth();
    expect(Object.keys(template.Resources).sort()).toEqual(['Library', 'Vault']);
    for (const [id, settings] of [['Vault', baseline.buckets.vault], ['Library', baseline.buckets.library]] as const) {
      expect(template.Resources[id]).toEqual({
        Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
        Properties: {
          BucketName: settings.name,
          BucketEncryption: { ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            BucketKeyEnabled: id === 'Vault', BlockedEncryptionTypes: { EncryptionType: ['SSE-C'] },
          }] },
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
          OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
          ...(id === 'Vault' ? { VersioningConfiguration: { Status: 'Enabled' } } : {}),
        },
      });
    }
  });

  it('binds the native CloudFormation import mapping to exactly those physical resources', () => {
    const mapping = JSON.parse(fs.readFileSync('config/import-resources.json', 'utf8')) as {
      ResourceType: string; LogicalResourceId: string; ResourceIdentifier: { BucketName: string };
    }[];
    const resources = synth().Resources;
    expect(mapping).toHaveLength(2);
    expect(new Set(mapping.map((item) => item.LogicalResourceId)).size).toBe(2);
    for (const item of mapping) {
      expect(item.ResourceType).toBe('AWS::S3::Bucket');
      expect(resources[item.LogicalResourceId].Type).toBe(item.ResourceType);
      expect(resources[item.LogicalResourceId].Properties.BucketName).toBe(item.ResourceIdentifier.BucketName);
    }
  });

  it('supports a later versioning change on the same physical bucket and logical ID', () => {
    const config = structuredClone(baseline);
    config.buckets.library.versioning = 'enabled';
    const before = synth();
    const after = synth(config);
    expect(Object.keys(after.Resources)).toEqual(Object.keys(before.Resources));
    expect(after.Resources.Library.Properties.BucketName).toBe(before.Resources.Library.Properties.BucketName);
    expect(after.Resources.Library.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    delete after.Resources.Library.Properties.VersioningConfiguration;
    expect(after).toEqual(before);
  });

  it('rejects unknown cleanup settings and unsafe public access in the import baseline', () => {
    const config = structuredClone(baseline);
    expect(() => storageSchema.parse({ ...config, lifecycle: { days: 1 } })).toThrow();
    expect(() => storageSchema.parse({ ...config, buckets: {
      ...config.buckets, vault: { ...config.buckets.vault, publicAccessBlock: {
        ...config.buckets.vault.publicAccessBlock, blockPublicPolicy: false,
      } },
    } })).toThrow();
  });
});
