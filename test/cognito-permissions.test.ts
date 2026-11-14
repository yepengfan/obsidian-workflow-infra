import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { MCP_POOL_ARN_EXPORT } from '../infra/mcp-resources.js';
import { storageSchema } from '../infra/storage-config.js';

const storage = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
it('exports the ARN of the CDK-managed pool and imports that exact binding into IAM', () => {
  const app = new App();
  const pool = Template.fromStack(new CognitoStack(app, 'ObsidianMcp', storage,
    cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')))));
  expect(pool.toJSON().Outputs.PermissionPoolArn).toEqual({ Value: { 'Fn::GetAtt': ['UserPool', 'Arn'] }, Export: { Name: MCP_POOL_ARN_EXPORT } });
  const trust = Template.fromStack(new GitHubTrustStack(new App(), 'Trust', storage, github));
  const policies = Object.values(trust.findResources('AWS::IAM::Policy'));
  const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const cognito = statements.filter(s => [s.Action].flat().some((a: string) => a.startsWith('cognito-idp:')));
  expect(cognito.flatMap(s => [s.Action].flat())).toEqual(expect.arrayContaining(['cognito-idp:DescribeUserPool', 'cognito-idp:CreateUserPoolClient']));
  for (const statement of cognito) {
    const actions: string[] = [statement.Action].flat();
    expect(actions).not.toContain('cognito-idp:CreateUserPool');
    expect(actions).not.toContain('cognito-idp:AdminCreateUser');
    if (actions.includes('cognito-idp:DescribeUserPoolDomain')) expect(statement.Resource).toBe('*');
    else {
      expect(statement.Resource).toEqual({ 'Fn::ImportValue': MCP_POOL_ARN_EXPORT });
      if (statement.Effect === 'Allow') expect(statement.Condition.StringEquals).toEqual({ 'aws:ResourceTag/Project': 'obsidian-mcp' });
    }
  }
  trust.resourceCountIs('AWS::Cognito::UserPool', 0);
});

it('grants group structure management only to the pinned-pool execution role, without user or membership administration', () => {
  const trust = Template.fromStack(new GitHubTrustStack(new App(), 'Trust', storage, github));
  const roles = trust.findResources('AWS::IAM::Role');
  const execution = Object.entries(roles).find(([, role]) => role.Properties.RoleName === github.mcpExecutionRoleName)![0];
  const policies = Object.values(trust.findResources('AWS::IAM::Policy'));
  const groupActions = ['cognito-idp:CreateGroup', 'cognito-idp:GetGroup', 'cognito-idp:UpdateGroup', 'cognito-idp:DeleteGroup'];
  for (const policy of policies) {
    const isExecution = policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === execution);
    const statements = policy.Properties.PolicyDocument.Statement;
    const actions = statements.flatMap((s: { Action: string | string[] }) => [s.Action].flat());
    for (const action of ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'iam:PutRolePolicy']) {
      expect(actions).not.toContain(action);
    }
    if (isExecution) {
      expect(actions).toEqual(expect.arrayContaining(groupActions));
      for (const statement of statements.filter((s: { Action: string | string[] }) => [s.Action].flat().some(action => groupActions.includes(action)))) {
        expect(statement.Resource).toEqual({ 'Fn::ImportValue': MCP_POOL_ARN_EXPORT });
        expect(statement.Condition.StringEquals).toEqual({ 'aws:ResourceTag/Project': 'obsidian-mcp' });
      }
    } else for (const action of groupActions) expect(actions).not.toContain(action);
  }
  const plan = Object.entries(roles).find(([, role]) => role.Properties.RoleName === github.planRoleName)![0];
  const planStatements = policies.filter(policy => policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === plan))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const types = planStatements.map(statement => statement.Condition?.['ForAllValues:StringEquals']?.['cloudformation:ResourceTypes'])
    .find(types => Array.isArray(types) && types.includes('AWS::Cognito::UserPool'));
  expect(types).toContain('AWS::Cognito::UserPoolGroup');
  expect(types).not.toContain('AWS::Cognito::UserPoolUserToGroupAttachment');
});
