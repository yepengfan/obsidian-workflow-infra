import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { githubSchema } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const cognito = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));

describe('private Lambda code-artifact storage', () => {
  it('adds only one private retained/versioned code bucket and its HTTPS-only policy', () => {
    const stack = new CognitoStack(new App(), 'ObsidianMcp', aws, cognito, github.mcpRuntime);
    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.resourceCountIs('AWS::S3::BucketPolicy', 1);
    t.resourceCountIs('AWS::Lambda::Function', 0);
    t.resourceCountIs('AWS::IAM::Role', 0);
    t.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
    const bucket = t.toJSON().Resources.CodeArtifacts;
    expect(bucket).toMatchObject({ Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      BucketName: github.mcpRuntime!.codeBucketName,
      VersioningConfiguration: { Status: 'Enabled' },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BlockedEncryptionTypes: { EncryptionType: ['SSE-C'] } }] },
    } });
    expect(bucket.Properties.LifecycleConfiguration).toBeUndefined();
    expect(bucket.Properties.ReplicationConfiguration).toBeUndefined();
    const policy = t.toJSON().Resources.CodeArtifactsPolicy;
    expect(policy).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      Bucket: { Ref: 'CodeArtifacts' }, PolicyDocument: { Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }] },
    } });
    expect(policy.Properties.PolicyDocument.Statement).toHaveLength(1);
    expect(policy.Properties.PolicyDocument.Statement[0].Resource).toEqual([{ 'Fn::GetAtt': ['CodeArtifacts', 'Arn'] }, { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['CodeArtifacts', 'Arn'] }, '/*']] }]);
  });
  it('preserves the native identity resources and original discovery outputs', () => {
    const before = Template.fromStack(new CognitoStack(new App(), 'ObsidianMcp', aws, cognito)).toJSON();
    const after = Template.fromStack(new CognitoStack(new App(), 'ObsidianMcp', aws, cognito, github.mcpRuntime)).toJSON();
    for (const id of ['UserPool', 'UserPoolDomain']) expect(after.Resources[id]).toEqual(before.Resources[id]);
    for (const key of Object.keys(before.Outputs)) expect(after.Outputs[key]).toEqual(before.Outputs[key]);
    expect(after.Outputs.CodeArtifactBucketName.Value).toEqual({ Ref: 'CodeArtifacts' });
    expect(Object.keys(after.Resources).sort()).toEqual(['CodeArtifacts', 'CodeArtifactsPolicy', 'UserPool', 'UserPoolDomain']);
  });
});
