import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { storageSchema } from '../infra/storage-config.js';
import { StorageStack } from '../infra/storage-stack.js';

const baseline = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const synth = (config = baseline) => Template.fromStack(new StorageStack(new App(), 'Test', config)).toJSON();

describe('managed storage retention', () => {
  it('retains both original buckets and expires only noncurrent versions after 90 days', () => {
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
          VersioningConfiguration: { Status: 'Enabled' },
          LifecycleConfiguration: { Rules: [{
            Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled', Prefix: '',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }, {
            Id: 'ExpireNoncurrentVersionsAfter90Days', Status: 'Enabled', Prefix: '',
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          }] },
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

  it('preserves physical and logical IDs when updating the imported baseline', () => {
    const config = structuredClone(baseline);
    delete config.buckets.vault.noncurrentVersionRetentionDays;
    delete config.buckets.library.noncurrentVersionRetentionDays;
    config.buckets.library.versioning = 'unversioned';
    const before = synth(config);
    const after = synth();
    expect(Object.keys(after.Resources)).toEqual(Object.keys(before.Resources));
    expect(after.Resources.Library.Properties.BucketName).toBe(before.Resources.Library.Properties.BucketName);
    expect(after.Resources.Library.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    delete after.Resources.Library.Properties.VersioningConfiguration;
    for (const id of ['Vault', 'Library']) after.Resources[id].Properties.LifecycleConfiguration.Rules =
      after.Resources[id].Properties.LifecycleConfiguration.Rules.filter((r: { NoncurrentVersionExpiration?: unknown }) => !r.NoncurrentVersionExpiration);
    expect(after).toEqual(before);
  });

  it.each([0, 1, 89, 91, 90.5, '90'])('rejects retention outside the selected 90-day policy: %s', days => {
    expect(() => storageSchema.parse({ ...baseline, buckets: {
      ...baseline.buckets, vault: { ...baseline.buckets.vault, noncurrentVersionRetentionDays: days },
    } })).toThrow();
  });

  it.each(['unversioned', 'suspended'])('rejects active retention without enabled versioning: %s', versioning => {
    expect(() => storageSchema.parse({ ...baseline, buckets: {
      ...baseline.buckets, library: { ...baseline.buckets.library, versioning },
    } })).toThrow();
  });

  it('allows historical expiry to be removed without changing versioning or other settings', () => {
    const config = structuredClone(baseline);
    for (const settings of Object.values(config.buckets)) delete settings.noncurrentVersionRetentionDays;
    const withoutLifecycle = synth(storageSchema.parse(config));
    const withLifecycle = synth();
    for (const id of ['Vault', 'Library']) {
      expect(withoutLifecycle.Resources[id].Properties.LifecycleConfiguration.Rules).toEqual([{
        Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled', Prefix: '',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      }]);
      withLifecycle.Resources[id].Properties.LifecycleConfiguration = withoutLifecycle.Resources[id].Properties.LifecycleConfiguration;
    }
    expect(withoutLifecycle).toEqual(withLifecycle);
  });

  it('rejects unknown cleanup settings and unsafe public access', () => {
    const config = structuredClone(baseline);
    expect(() => storageSchema.parse({ ...config, lifecycle: { days: 1 } })).toThrow();
    expect(() => storageSchema.parse({ ...config, buckets: {
      ...config.buckets, vault: { ...config.buckets.vault, publicAccessBlock: {
        ...config.buckets.vault.publicAccessBlock, blockPublicPolicy: false,
      } },
    } })).toThrow();
  });
});
