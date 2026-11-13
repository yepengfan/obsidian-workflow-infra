import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const storage = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const build = (mcpUserPoolId?: string) => {
  const stack = new GitHubTrustStack(new App(), 'Trust', storage, { ...github, mcpRuntime: undefined, mcpUserPoolId });
  const template = Template.fromStack(stack);
  const roleId = Object.entries(template.findResources('AWS::IAM::Role'))
    .find(([, role]) => role.Properties.RoleName === github.mcpExecutionRoleName)![0];
  const policy = Object.values(template.findResources('AWS::IAM::Policy'))
    .find(policy => policy.Properties.Roles.some((ref: { Ref: string }) => ref.Ref === roleId))!.Properties.PolicyDocument;
  return { stack, template, roleId, policy };
};

describe('Cognito discovery permission prerequisite', () => {
  it('grants only pool and prefix-domain configuration to a separate CloudFormation service role', () => {
    const { template, roleId, policy } = build();
    expect(template.toJSON().Resources[roleId].Properties.AssumeRolePolicyDocument.Statement).toEqual([{
      Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' },
    }]);
    const actions = policy.Statement.flatMap((s: { Action: string | string[] }) => [s.Action].flat());
    expect(actions.every((action: string) => action.startsWith('cognito-idp:') && !action.includes('*'))).toBe(true);
    expect(actions).toContain('cognito-idp:CreateUserPool');
    expect(actions).toContain('cognito-idp:CreateUserPoolDomain');
    for (const forbidden of ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword',
      'cognito-idp:ListUsers', 'cognito-idp:CreateUserPoolClient', 'cognito-idp:DeleteUserPool',
      'cognito-idp:DeleteUserPoolDomain']) {
      expect(actions).not.toContain(forbidden);
    }
    expect(template.toJSON().Resources[roleId].Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('requires a project tag for pool creation, limits generated pool ARNs, and protects the ownership tag', () => {
    const { stack, policy } = build();
    const create = policy.Statement.find((s: { Action: string | string[] }) => [s.Action].flat().includes('cognito-idp:CreateUserPool'));
    expect(create.Resource).toBe('*');
    expect(create.Condition.StringEquals).toEqual({ 'aws:RequestTag/Project': 'obsidian-mcp', 'aws:RequestedRegion': storage.region });
    const domain = policy.Statement.find((s: { Action: string | string[] }) => [s.Action].flat().includes('cognito-idp:CreateUserPoolDomain'));
    expect(domain.Resource).toEqual(stack.resolve(`arn:${stack.partition}:cognito-idp:${storage.region}:${storage.account}:userpool/*`));
    expect(domain.Condition.StringEquals).toEqual({ 'aws:ResourceTag/Project': 'obsidian-mcp' });
    expect(policy.Statement.find((s: { Effect: string }) => s.Effect === 'Deny')).toMatchObject({
      Action: 'cognito-idp:TagResource',
      Condition: { StringNotEquals: { 'aws:RequestTag/Project': 'obsidian-mcp' }, Null: { 'aws:RequestTag/Project': 'false' } },
    });
  });

  it('binds app plans to the app stack, dedicated role and two native Cognito resource types', () => {
    const { stack, template, roleId } = build();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(p => p.Properties.PolicyDocument.Statement);
    const plan = statements.find(s => [s.Action].flat().includes('cloudformation:CreateChangeSet') && s.Condition?.ArnEquals?.['cloudformation:RoleArn']?.['Fn::GetAtt']?.[0] === roleId);
    expect(plan.Resource).toEqual(stack.resolve(`arn:${stack.partition}:cloudformation:${storage.region}:${storage.account}:stack/ObsidianMcp/*`));
    expect(plan.Condition['ForAllValues:StringEquals']).toEqual({ 'cloudformation:ResourceTypes': ['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolDomain'] });
    expect(plan.Condition.Null).toEqual({ 'cloudformation:ResourceTypes': 'false' });
    const pass = statements.find(s => [s.Action].flat().includes('iam:PassRole') && s.Resource?.['Fn::GetAtt']?.[0] === roleId);
    expect(pass.Condition.StringEquals).toEqual({ 'iam:PassedToService': 'cloudformation.amazonaws.com' });
    const output = template.toJSON().Outputs.McpCloudFormationExecutionRoleArn;
    expect(output.Value).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
  });

  it('can remove bootstrap creation/tagging and pin configuration access to the deployed pool', () => {
    const id = 'ap-southeast-2_Example123';
    const { stack, policy } = build(id);
    const actions = policy.Statement.flatMap((s: { Action: string | string[] }) => [s.Action].flat());
    expect(actions).not.toContain('cognito-idp:CreateUserPool');
    const scoped = policy.Statement.filter((s: { Resource: unknown }) => s.Resource !== '*');
    for (const statement of scoped) {
      expect(statement.Resource).toEqual(stack.resolve(`arn:${stack.partition}:cognito-idp:${storage.region}:${storage.account}:userpool/${id}`));
    }
    const tagging = scoped.filter((s: { Effect: string; Action: string | string[] }) => s.Effect === 'Allow' && [s.Action].flat().includes('cognito-idp:TagResource'));
    expect(tagging).toHaveLength(1);
    expect(tagging[0].Condition.StringEquals).toEqual({ 'aws:ResourceTag/Project': 'obsidian-mcp' });
  });
});
