import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { STORAGE_STACK_NAME, type StorageConfig } from './storage-config.js';

export const githubSchema = z.object({
  repositorySubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+@\d+\/[A-Za-z0-9_.-]+@\d+$/u),
  bootstrapQualifier: z.string().regex(/^[a-z0-9]+$/u),
}).strict();

/** One-time reviewed foundation, separate from the unchanged bucket import. */
export class GitHubTrustStack extends Stack {
  constructor(scope: Construct, id: string, storage: StorageConfig, github: z.infer<typeof githubSchema>) {
    super(scope, id, { env: { account: storage.account, region: storage.region } });
    const provider = new iam.OidcProviderNative(this, 'Provider', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const principal = (environment: string) => new iam.FederatedPrincipal(provider.oidcProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `${github.repositorySubject}:environment:${environment}`,
      },
    }, 'sts:AssumeRoleWithWebIdentity');
    const plan = new iam.Role(this, 'PlanRole', { assumedBy: principal('production-plan'), maxSessionDuration: Duration.hours(1) });
    const apply = new iam.Role(this, 'DeployRole', { assumedBy: principal('production'), maxSessionDuration: Duration.hours(1) });
    const stackArn = `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${STORAGE_STACK_NAME}/*`;
    const executionRole = `arn:${this.partition}:iam::${this.account}:role/cdk-${github.bootstrapQualifier}-cfn-exec-role-${this.account}-${this.region}`;
    const changeSetNames = ['obsidian-storage-*', `arn:${this.partition}:cloudformation:${this.region}:${this.account}:changeSet/obsidian-storage-*/*`];
    for (const role of [plan, apply]) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResources', 'cloudformation:DescribeChangeSet', 'cloudformation:GetTemplate'],
        resources: [stackArn],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetBucketLocation', 's3:GetBucketPublicAccessBlock', 's3:GetBucketVersioning', 's3:GetEncryptionConfiguration', 's3:GetBucketOwnershipControls'],
        resources: [storage.buckets.vault.name, storage.buckets.library.name].map((name) => `arn:${this.partition}:s3:::${name}`),
      }));
    }
    plan.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:GetTemplateSummary'], resources: ['*'] }));
    plan.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:CreateChangeSet'], resources: [stackArn],
      conditions: {
        ArnEquals: { 'cloudformation:RoleArn': executionRole },
        StringLike: { 'cloudformation:ChangeSetName': changeSetNames },
        'ForAllValues:StringEquals': { 'cloudformation:ResourceTypes': ['AWS::S3::Bucket', 'AWS::S3::BucketPolicy'] },
        Null: { 'cloudformation:ResourceTypes': 'false' },
      },
    }));
    plan.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [executionRole],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }));
    apply.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:ExecuteChangeSet'], resources: [stackArn],
      conditions: { StringLike: { 'cloudformation:ChangeSetName': changeSetNames } },
    }));
    apply.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:UpdateTerminationProtection', 'cloudformation:DetectStackDrift', 'cloudformation:DetectStackResourceDrift', 'cloudformation:DescribeStackResourceDrifts'], resources: [stackArn] }));
    apply.addToPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStackDriftDetectionStatus', 'cloudformation:BatchDescribeTypeConfigurations'], resources: ['*'] }));
    new CfnOutput(this, 'PlanRoleArn', { value: plan.roleArn });
    new CfnOutput(this, 'DeployRoleArn', { value: apply.roleArn });
    new CfnOutput(this, 'CloudFormationExecutionRoleArn', { value: executionRole });
  }
}
