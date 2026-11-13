import { MCP_POOL_ARN_EXPORT, mcpResources } from './mcp-resources.js';
import type { McpDeploymentConfig } from './mcp-permissions.js';
import { CfnOutput, DefaultStackSynthesizer, Duration, Fn, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { STORAGE_STACK_NAME, type StorageConfig } from './storage-config.js';
import { grantMcpRuntime, mcpDeploymentSchema, MCP_RESOURCE_TYPES } from './mcp-permissions.js';

const roleName = z.string().regex(/^obsidian-[A-Za-z0-9+=,.@_-]+$/u).max(64);

export const githubSchema = z.object({
  repositorySubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+@\d+\/[A-Za-z0-9_.-]+@\d+$/u),
  planRoleName: roleName,
  deployRoleName: roleName,
  executionRoleName: roleName,
  mcpExecutionRoleName: roleName,
  runtimeRoleName: z.string().regex(/^obsidian-mcp-[a-z0-9-]+$/u).max(64),
}).strict().refine(config => new Set([config.executionRoleName, config.mcpExecutionRoleName,
  config.planRoleName, config.deployRoleName, config.runtimeRoleName].map(name => name.toLowerCase())).size === 5,
  'Role names must be distinct');

/** Reviewed permission foundation; local SSO update procedure: docs/github-actions.md. */
export class GitHubTrustStack extends Stack {
  constructor(scope: Construct, id: string, storage: StorageConfig, github: z.infer<typeof githubSchema>, deployment: McpDeploymentConfig = mcpDeploymentSchema.parse(mcpResources(storage, github.runtimeRoleName))) {
    super(scope, id, {
      env: { account: storage.account, region: storage.region },
      // Native CloudFormation receives this asset-free template directly.
      synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    });
    const provider = new iam.OidcProviderNative(this, 'Provider', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const principal = (environment: string) => new iam.FederatedPrincipal(provider.oidcProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `${github.repositorySubject}:environment:${environment}`,
      },
    }, 'sts:AssumeRoleWithWebIdentity');
    const plan = new iam.Role(this, 'PlanRole', { roleName: github.planRoleName, assumedBy: principal('production-plan'), maxSessionDuration: Duration.hours(1) });
    const apply = new iam.Role(this, 'DeployRole', { roleName: github.deployRoleName, assumedBy: principal('production'), maxSessionDuration: Duration.hours(1) });
    const stackArn = `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${STORAGE_STACK_NAME}/*`;
    const bucketArns = [storage.buckets.vault.name, storage.buckets.library.name]
      .map((name) => `arn:${this.partition}:s3:::${name}`);
    const execution = new iam.Role(this, 'StorageExecutionRole', {
      roleName: github.executionRoleName,
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Manage only the modeled configuration of the two existing Obsidian buckets',
    });
    const bucketReadActions = [
        's3:GetAccelerateConfiguration', 's3:GetLifecycleConfiguration',
        's3:GetBucketPublicAccessBlock', 's3:GetAnalyticsConfiguration',
        's3:GetBucketCORS', 's3:GetEncryptionConfiguration',
        's3:GetInventoryConfiguration', 's3:GetBucketLogging',
        's3:GetMetricsConfiguration', 's3:GetBucketNotification',
        's3:GetBucketVersioning', 's3:GetReplicationConfiguration',
        's3:GetBucketWebsite', 's3:GetBucketObjectLockConfiguration',
        's3:GetBucketTagging', 's3:ListTagsForResource', 's3:GetBucketAbac',
        's3:GetBucketOwnershipControls', 's3:GetIntelligentTieringConfiguration',
        's3:GetBucketMetadataTableConfiguration',
        's3:ListBucket', 's3:GetBucketLocation',
      ];
    execution.addToPolicy(new iam.PolicyStatement({
      // AWS::S3::Bucket read permissions (Sydney registry, 2026-11-13),
      // excluding its unrecognized GetBucketDefaultStorageClass action.
      // ListBucket is needed for HeadBucket; no object-body permissions are granted.
      actions: bucketReadActions,
      resources: bucketArns,
    }));
    execution.addToPolicy(new iam.PolicyStatement({
      // Reviewed configuration writes. Future capabilities require a reviewed
      // foundation update via local SSO before the resource deployment.
      actions: [
        's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock',
        's3:PutBucketOwnershipControls', 's3:PutBucketVersioning',
        // S3 lifecycle expiry can delete history without DeleteObject permission.
        // Activation belongs to a separate, reviewed bucket-resource change.
        's3:PutLifecycleConfiguration',
      ],
      resources: bucketArns,
    }));
    const executionRole = execution.roleArn;
    // Dedicated application service role. IAM itself remains foundation-owned.
    const mcpExecution = new iam.Role(this, 'McpExecutionRole', {
      roleName: github.mcpExecutionRoleName,
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Manage the pinned MCP identity and reviewed application resources',
    });
    const poolArn = Fn.importValue(MCP_POOL_ARN_EXPORT);
    const project = 'obsidian-mcp';
    mcpExecution.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:DescribeUserPool', 'cognito-idp:GetUserPoolMfaConfig',
        'cognito-idp:UpdateUserPool', 'cognito-idp:SetUserPoolMfaConfig',
        'cognito-idp:CreateUserPoolDomain', 'cognito-idp:UpdateUserPoolDomain',
        'cognito-idp:ListTagsForResource',
        'cognito-idp:TagResource',
      ], resources: [poolArn],
      conditions: { StringEquals: { 'aws:ResourceTag/Project': project } },
    }));
    mcpExecution.addToPolicy(new iam.PolicyStatement({
      // DescribeUserPoolDomain has no resource-level authorization support.
      actions: ['cognito-idp:DescribeUserPoolDomain'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
    }));
    // Preserve the ownership tag, including when tagging an already-owned pool.
    mcpExecution.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY, actions: ['cognito-idp:TagResource'], resources: [poolArn],
      conditions: { StringNotEquals: { 'aws:RequestTag/Project': project }, Null: { 'aws:RequestTag/Project': 'false' } },
    }));
    mcpExecution.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY, actions: ['cognito-idp:TagResource'], resources: [poolArn],
      conditions: { StringNotEquals: { 'aws:ResourceTag/Project': project }, Null: { 'aws:ResourceTag/Project': 'false' } },
    }));
    mcpExecution.addToPolicy(new iam.PolicyStatement({ actions: [
      'cognito-idp:CreateUserPoolClient', 'cognito-idp:DescribeUserPoolClient',
      'cognito-idp:UpdateUserPoolClient', 'cognito-idp:DeleteUserPoolClient',
      'cognito-idp:CreateResourceServer', 'cognito-idp:DescribeResourceServer',
      'cognito-idp:UpdateResourceServer', 'cognito-idp:DeleteResourceServer',
      'cognito-idp:CreateManagedLoginBranding', 'cognito-idp:DescribeManagedLoginBranding',
      'cognito-idp:UpdateManagedLoginBranding', 'cognito-idp:DeleteManagedLoginBranding',
    ], resources: [poolArn], conditions: { StringEquals: { 'aws:ResourceTag/Project': project } } }));
    grantMcpRuntime(this, storage, deployment, mcpExecution, apply, bucketReadActions);
    const changeSetNames = ['obsidian-storage-*', `arn:${this.partition}:cloudformation:${this.region}:${this.account}:changeSet/obsidian-storage-*/*`];
    for (const role of [plan, apply]) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResources', 'cloudformation:DescribeChangeSet', 'cloudformation:GetTemplate'],
        resources: [stackArn],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetBucketLocation', 's3:GetBucketPublicAccessBlock', 's3:GetBucketVersioning', 's3:GetEncryptionConfiguration', 's3:GetBucketOwnershipControls'],
        resources: bucketArns,
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
    const mcpStackArn = `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/ObsidianMcp/*`;
    const mcpChangeSets = ['obsidian-mcp-*', `arn:${this.partition}:cloudformation:${this.region}:${this.account}:changeSet/obsidian-mcp-*/*`];
    for (const role of [plan, apply]) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResources', 'cloudformation:DescribeChangeSet', 'cloudformation:GetTemplate'],
        resources: [mcpStackArn],
      }));
    }
    plan.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:CreateChangeSet'], resources: [mcpStackArn],
      conditions: {
        ArnEquals: { 'cloudformation:RoleArn': mcpExecution.roleArn },
        StringLike: { 'cloudformation:ChangeSetName': mcpChangeSets },
        'ForAllValues:StringEquals': { 'cloudformation:ResourceTypes': MCP_RESOURCE_TYPES },
        Null: { 'cloudformation:ResourceTypes': 'false' },
      },
    }));
    plan.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [mcpExecution.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }));
    apply.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:ExecuteChangeSet'], resources: [mcpStackArn],
      conditions: { StringLike: { 'cloudformation:ChangeSetName': mcpChangeSets } },
    }));
    apply.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:UpdateTerminationProtection', 'cloudformation:DetectStackDrift', 'cloudformation:DetectStackResourceDrift', 'cloudformation:DescribeStackResourceDrifts'],
      resources: [mcpStackArn],
    }));
    new CfnOutput(this, 'PlanRoleArn', { value: plan.roleArn });
    new CfnOutput(this, 'DeployRoleArn', { value: apply.roleArn });
    new CfnOutput(this, 'CloudFormationExecutionRoleArn', { value: executionRole });
    new CfnOutput(this, 'McpCloudFormationExecutionRoleArn', { value: mcpExecution.roleArn });
  }
}
