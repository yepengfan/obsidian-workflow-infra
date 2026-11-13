import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';
import { mcpDeploymentSchema } from '../infra/mcp-permissions.js';

const storage = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const config = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const settings = config.mcpRuntime!;
type Statement = { Action: string | string[]; Resource: unknown; Effect: string; Condition?: Record<string, Record<string, unknown>> };
function build(prefix = '') {
  const stack = new GitHubTrustStack(new App(), 'Trust', storage, { ...config, mcpRuntime: { ...settings, notePrefix: prefix } });
  const template = Template.fromStack(stack);
  const statements = (name: string): Statement[] => {
    const [id] = Object.entries(template.findResources('AWS::IAM::Role')).find(([, r]) => r.Properties.RoleName === name)!;
    return Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(p => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === id))
      .flatMap(p => p.Properties.PolicyDocument.Statement);
  };
  return { stack, template, statements };
}
const actions = (s: Statement) => [s.Action].flat();

describe('MCP runtime permission boundary', () => {
  it.each(['', 'Knowledge/'])('permits only bounded child listings and read-only Vault objects under %j', prefix => {
    const { stack, statements } = build(prefix);
    const runtime = statements(settings.runtimeRoleName);
    expect(runtime.flatMap(actions).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject', 's3:ListBucket']);
    expect(runtime.find(s => actions(s).includes('s3:ListBucket'))).toMatchObject({
      Resource: stack.resolve(`arn:${stack.partition}:s3:::${storage.buckets.vault.name}`),
      Condition: { StringLike: { 's3:prefix': [`${prefix}*`] }, StringEquals: { 's3:delimiter': '/' }, NumericLessThanEquals: { 's3:max-keys': 100 } },
    });
    expect(runtime.find(s => actions(s).includes('s3:GetObject'))!.Resource)
      .toEqual(stack.resolve(`arn:${stack.partition}:s3:::${storage.buckets.vault.name}/${prefix}*`));
    const logs = runtime.find(s => actions(s).includes('logs:PutLogEvents'))!;
    expect(logs.Resource).toEqual(stack.resolve(`arn:${stack.partition}:logs:${storage.region}:${storage.account}:log-group:/aws/lambda/${settings.functionName}:log-stream:*`));
  });
  it('keeps note access out of both CI roles and the CloudFormation role', () => {
    const { statements } = build();
    for (const name of [config.planRoleName, config.deployRoleName, config.mcpExecutionRoleName]) {
      for (const statement of statements(name).filter(s => actions(s).some(a => a === 's3:GetObject' || a === 's3:PutObject'))) {
        expect(JSON.stringify(statement.Resource)).toContain(settings.codeBucketName);
        expect(JSON.stringify(statement.Resource)).not.toContain(storage.buckets.vault.name);
        expect(JSON.stringify(statement.Resource)).not.toContain(storage.buckets.library.name);
      }
      expect(statements(name).flatMap(actions)).not.toContain('iam:PutRolePolicy');
      expect(statements(name).flatMap(actions)).not.toContain('iam:CreateRole');
    }
  });
  it('allows approval-side code uploads only to the release prefix with encryption and conditional creation', () => {
    const { stack, statements } = build();
    const put = statements(config.deployRoleName).filter(s => actions(s).includes('s3:PutObject'));
    expect(put).toHaveLength(1);
    expect(put[0]).toMatchObject({ Resource: stack.resolve(`arn:${stack.partition}:s3:::${settings.codeBucketName}/releases/*`),
      Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'AES256', 's3:if-none-match': '*' } } });
    expect(statements(config.planRoleName).flatMap(actions)).not.toContain('s3:PutObject');
  });
  it('pins Cognito, constrains API ownership, and passes only the named Lambda role', () => {
    const { stack, template, statements } = build();
    const execution = statements(config.mcpExecutionRoleName);
    expect(execution.flatMap(actions)).not.toContain('cognito-idp:CreateUserPool');
    for (const s of execution.filter(s => actions(s).some(a => a.startsWith('cognito-idp:') && a !== 'cognito-idp:DescribeUserPoolDomain'))) {
      expect(s.Resource).toEqual(stack.resolve(`arn:${stack.partition}:cognito-idp:${storage.region}:${storage.account}:userpool/${config.mcpUserPoolId}`));
    }
    const apiCreate = execution.find(s => s.Condition?.StringEquals?.['apigateway:Request/ApiName']);
    expect(apiCreate?.Condition?.StringEquals).toEqual({ 'aws:RequestTag/Project': 'obsidian-mcp', 'apigateway:Request/ApiName': settings.apiName });
    const role = Object.entries(template.findResources('AWS::IAM::Role')).find(([, r]) => r.Properties.RoleName === settings.runtimeRoleName)!;
    const pass = execution.filter(s => actions(s).includes('iam:PassRole'));
    expect(pass).toEqual([{ Action: 'iam:PassRole', Effect: 'Allow', Resource: { 'Fn::GetAtt': [role[0], 'Arn'] }, Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } } }]);
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      for (const s of policy.Properties.PolicyDocument.Statement as Statement[]) expect(actions(s)).not.toContain('*');
    }
  });
  it('creates only the IAM prerequisite, without changing the application or storage stacks', () => {
    const { template } = build();
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });
  it.each(['../', 'Notes/../', '/Notes/', 'Notes/*/', 'Notes/?/', 'Notes\\Folder/', 'Notes/\n/'])('rejects a nonliteral or escaping prefix %j', notePrefix => {
    expect(mcpDeploymentSchema.safeParse({ ...settings, notePrefix }).success).toBe(false);
  });
  it('requires the deployed pool pin before adding runtime permissions', () => {
    expect(githubSchema.safeParse({ ...config, mcpUserPoolId: undefined }).success).toBe(false);
  });
});
