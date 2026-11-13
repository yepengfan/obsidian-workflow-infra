import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { StorageConfig } from './storage-config.js';

/** Managed resource definitions. Bind them to the existing buckets with import. */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, config: StorageConfig) {
    super(scope, id, {
      env: { account: config.account, region: config.region },
      terminationProtection: true,
      description: 'Existing private Obsidian storage under IaC management',
    });

    for (const [logicalId, settings] of [
      ['Vault', config.buckets.vault], ['Library', config.buckets.library],
    ] as const) {
      // L1 exposes the complete CloudFormation encryption settings, including
      // the live SSE-C block. No reference-only fromBucketName constructs.
      const bucket = new s3.CfnBucket(this, logicalId, {
        bucketName: settings.name,
        bucketEncryption: {
          serverSideEncryptionConfiguration: [{
            serverSideEncryptionByDefault: { sseAlgorithm: settings.encryption.algorithm },
            bucketKeyEnabled: settings.encryption.bucketKeyEnabled,
            blockedEncryptionTypes: { encryptionType: settings.encryption.blockedEncryptionTypes },
          }],
        },
        publicAccessBlockConfiguration: settings.publicAccessBlock,
        ownershipControls: { rules: [{ objectOwnership: settings.objectOwnership }] },
        ...(settings.versioning === 'unversioned' ? {} : {
          versioningConfiguration: { status: settings.versioning === 'enabled' ? 'Enabled' : 'Suspended' },
        }),
      });
      // These IDs are part of the import mapping. Keep them stable after import.
      bucket.overrideLogicalId(logicalId);
      bucket.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });
    }
    // Baseline deliberately has no BucketPolicy, Lifecycle, CORS, IAM or object
    // operations. Add reviewed improvements only after successful import.
  }
}
