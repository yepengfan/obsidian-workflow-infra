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
