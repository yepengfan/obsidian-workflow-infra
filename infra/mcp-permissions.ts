import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { z } from 'zod';
import type { StorageConfig } from './storage-config.js';

export const mcpDeploymentSchema = z.strictObject({
  functionName: z.string().regex(/^obsidian-mcp-[a-z0-9-]+$/u).max(64),
  runtimeRoleName: z.string().regex(/^obsidian-mcp-[a-z0-9-]+$/u).max(64),
  apiName: z.string().regex(/^obsidian-mcp(?:-[a-z0-9-]+)?$/u).max(64),
  codeBucketName: z.string().regex(/^obsidian-mcp-code-[a-z0-9-]+$/u).max(63),
  codePrefix: z.string().regex(/^releases\/$/u),
  notePrefix: z.string().max(512).refine(v => v === '' || (!v.startsWith('/') && !v.includes('${') && v.endsWith('/') && !v.split('/').some(p => p === '.' || p === '..') && !/[\\*?]/u.test(v) && ![...v].some(c => c.charCodeAt(0) < 32)), 'Use a literal relative folder prefix ending in /'),
});
export type McpDeploymentConfig = z.infer<typeof mcpDeploymentSchema>;

/** Permissions are deployed only through the reviewed local-SSO foundation. */
export function grantMcpRuntime(
  stack: Stack, storage: StorageConfig, settings: McpDeploymentConfig,
  execution: iam.Role, deploy: iam.Role, bucketReadActions: string[],
): iam.Role {
  if ([storage.buckets.vault.name, storage.buckets.library.name].includes(settings.codeBucketName)) throw new Error('Code storage must be separate from notes');
  const arn = (service: string, resource: string) => `arn:${stack.partition}:${service}:${stack.region}:${stack.account}:${resource}`;
  const codeBucket = `arn:${stack.partition}:s3:::${settings.codeBucketName}`;
  const codeObjects = `${codeBucket}/${settings.codePrefix}*`;
  const vault = `arn:${stack.partition}:s3:::${storage.buckets.vault.name}`;
  const functionArn = arn('lambda', `function:${settings.functionName}`);
  const group = arn('logs', `log-group:/aws/lambda/${settings.functionName}`);
  const runtime = new iam.Role(stack, 'McpRuntimeRole', {
    roleName: settings.runtimeRoleName, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'Read-only selected Obsidian notes and write only MCP execution logs',
  });
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [vault],
    conditions: { StringLike: { 's3:prefix': [`${settings.notePrefix}*`] }, StringEquals: { 's3:delimiter': '/' }, NumericLessThanEquals: { 's3:max-keys': 100 } } }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${vault}/${settings.notePrefix}*`] }));
  runtime.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${group}:log-stream:*`] }));

  execution.addToPolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [runtime.roleArn],
    conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } } }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: [
    'lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
    'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
    'lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource',
    'lambda:GetFunctionConcurrency', 'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
    'lambda:GetRuntimeManagementConfig', 'lambda:GetFunctionCodeSigningConfig',
    'lambda:GetPolicy', 'lambda:RemovePermission',
  ], resources: [functionArn] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:AddPermission'], resources: [functionArn],
    conditions: { StringEquals: { 'lambda:Principal': 'apigateway.amazonaws.com' } } }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy',
    'logs:DeleteRetentionPolicy', 'logs:ListTagsForResource', 'logs:ListTagsLogGroup', 'logs:TagResource', 'logs:TagLogGroup'],
  resources: [group, `${group}:*`] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['logs:GetDataProtectionPolicy'], resources: [group, `${group}:*`] }));
  // These metadata reads are required by the native LogGroup read handler and
  // do not support resource-level IAM authorization. They cannot read events.
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups', 'logs:DescribeIndexPolicies', 'logs:DescribeResourcePolicies'], resources: ['*'],
    conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } } }));

  execution.addToPolicy(new iam.PolicyStatement({ actions: [...bucketReadActions, 's3:CreateBucket',
    's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock', 's3:PutBucketOwnershipControls',
    's3:PutBucketVersioning', 's3:PutBucketTagging', 's3:TagResource', 's3:UntagResource', 's3:PutBucketPolicy', 's3:GetBucketPolicy'], resources: [codeBucket] }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [codeObjects] }));
  deploy.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [codeObjects],
    conditions: { StringEquals: { 's3:x-amz-server-side-encryption': 'AES256', 's3:if-none-match': '*' } } }));
  deploy.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [codeObjects] }));
  deploy.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:GetFunctionConfiguration'], resources: [functionArn] }));

  // API IDs are generated by AWS. Only tagged MCP APIs in this Region can be
  // managed. No grant can attach the ownership tag to an unowned API.
  const apiRoot = `arn:${stack.partition}:apigateway:${stack.region}::`;
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['apigateway:POST'], resources: [`${apiRoot}/apis`],
    conditions: { StringEquals: { 'aws:RequestTag/Project': 'obsidian-mcp', 'apigateway:Request/ApiName': settings.apiName } } }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['apigateway:GET', 'apigateway:POST', 'apigateway:PATCH', 'apigateway:DELETE'],
    resources: [`${apiRoot}/apis/*`], conditions: { StringEquals: { 'aws:ResourceTag/Project': 'obsidian-mcp' } } }));
  // The regional AWS::ApiGatewayV2::Stage create handler separately checks this
  // literal action on the collection, before a named stage exists. Its live
  // schema requires it even though IAM Access Analyzer reports INVALID_ACTION.
  // Keep the exception separate from normal API management and tag ownership.
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['apigateway:TagResource'],
    resources: [`${apiRoot}/apis/*/stages`], conditions: { StringEquals: {
      'aws:RequestedRegion': stack.region, 'aws:RequestTag/Project': 'obsidian-mcp',
    } } }));
  execution.addToPolicy(new iam.PolicyStatement({ actions: ['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
    resources: [`${apiRoot}/tags/*`], conditions: { StringEquals: { 'aws:ResourceTag/Project': 'obsidian-mcp' } } }));
  execution.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['apigateway:DELETE'],
    resources: [`${apiRoot}/tags/*`], conditions: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['Project'] } } }));
  execution.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY,
    actions: ['apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:TagResource'],
    resources: [`${apiRoot}/apis/*`, `${apiRoot}/tags/*`], conditions: {
      StringNotEquals: { 'aws:RequestTag/Project': 'obsidian-mcp' },
      Null: { 'aws:RequestTag/Project': 'false' },
    } }));
  return runtime;
}

export const MCP_RESOURCE_TYPES = [
  'AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolDomain', 'AWS::Cognito::UserPoolGroup',
  'AWS::Cognito::UserPoolClient', 'AWS::Cognito::UserPoolResourceServer', 'AWS::Cognito::ManagedLoginBranding',
  'AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::Lambda::Function', 'AWS::Lambda::Permission',
  'AWS::Logs::LogGroup', 'AWS::ApiGatewayV2::Api', 'AWS::ApiGatewayV2::Integration',
  'AWS::ApiGatewayV2::Route', 'AWS::ApiGatewayV2::Stage',
];
