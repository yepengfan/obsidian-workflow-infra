import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { CfnBucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { McpDeploymentConfig } from './mcp-permissions.js';

/** Code only. Provision before the runtime's first approved ZIP upload. */
export function addCodeArtifacts(scope: Construct, settings: McpDeploymentConfig, incompleteUploadDays: number): CfnBucket {
  const bucket = new CfnBucket(scope, 'CodeArtifacts', {
    bucketName: settings.codeBucketName,
    versioningConfiguration: { status: 'Enabled' },
    lifecycleConfiguration: { rules: [{ id: 'AbortIncompleteMultipartUploads', status: 'Enabled', prefix: '',
      abortIncompleteMultipartUpload: { daysAfterInitiation: incompleteUploadDays } }] },
    ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
    publicAccessBlockConfiguration: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true },
    bucketEncryption: { serverSideEncryptionConfiguration: [{
      serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' },
      blockedEncryptionTypes: { encryptionType: ['SSE-C'] },
    }] },
    tags: [{ key: 'Project', value: 'obsidian-mcp' }, { key: 'Purpose', value: 'code-artifacts' }],
  });
  bucket.overrideLogicalId('CodeArtifacts');
  const policy = new CfnBucketPolicy(scope, 'CodeArtifactsPolicy', {
    bucket: bucket.ref,
    policyDocument: { Version: '2012-10-17', Statement: [{
      Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*',
      Resource: [bucket.attrArn, `${bucket.attrArn}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    }] },
  });
  policy.overrideLogicalId('CodeArtifactsPolicy');
  for (const resource of [bucket, policy]) resource.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });
  new CfnOutput(scope, 'CodeArtifactBucketName', { value: bucket.ref });
  return bucket;
}
