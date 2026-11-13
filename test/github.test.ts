import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const storage = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
type Statement = { Action: string | string[]; Resource?: unknown; Principal?: { Federated?: unknown; Service?: string }; Condition?: { StringEquals?: Record<string, string> } };
type Role = { Properties: { AssumeRolePolicyDocument: { Statement: Statement[] } } };
type Policy = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Statement[] } } };

describe('GitHub OIDC foundation', () => {
  it('uses the native OIDC resource and exact immutable repository/environment subjects', () => {
    const template = Template.fromStack(new GitHubTrustStack(new App(), 'Trust', storage, github));
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    const roles = template.findResources('AWS::IAM::Role') as Record<string, Role>;
    expect(Object.keys(roles)).toHaveLength(3);
    const subjects = Object.values(roles).filter(role => role.Properties.AssumeRolePolicyDocument.Statement[0]?.Principal?.Federated).map((role) => {
      const statement = role.Properties.AssumeRolePolicyDocument.Statement[0]!;
      expect(statement.Condition?.StringEquals?.['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
      return statement.Condition?.StringEquals?.['token.actions.githubusercontent.com:sub'];
    });
    expect(subjects.sort()).toEqual([
      `${github.repositorySubject}:environment:production`, `${github.repositorySubject}:environment:production-plan`,
    ]);
    expect(Object.values(template.toJSON().Resources).map((r) => (r as { Type: string }).Type).sort()).toEqual([
      'AWS::IAM::OIDCProvider', 'AWS::IAM::Policy', 'AWS::IAM::Policy', 'AWS::IAM::Policy',
      'AWS::IAM::Role', 'AWS::IAM::Role', 'AWS::IAM::Role',
    ]);
  });

  it('separates creating a change set from executing it and grants no note-object access', () => {
    const stack = new GitHubTrustStack(new App(), 'Trust', storage, github);
    const template = Template.fromStack(stack);
    const roles = template.findResources('AWS::IAM::Role') as Record<string, Role>;
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as Policy[];
    for (const [id, role] of Object.entries(roles)) {
      const subject = role.Properties.AssumeRolePolicyDocument.Statement[0]!.Condition?.StringEquals?.['token.actions.githubusercontent.com:sub'];
      if (!subject) continue;
      const statements = policies.filter((p) => p.Properties.Roles.some((r) => r.Ref === id)).flatMap((p) => p.Properties.PolicyDocument.Statement);
      const actions = statements.flatMap((s) => Array.isArray(s.Action) ? s.Action : [s.Action]);
      if (subject.endsWith(':production-plan')) {
        expect(actions).toContain('cloudformation:CreateChangeSet');
        expect(actions).toContain('iam:PassRole');
        expect(actions).not.toContain('cloudformation:ExecuteChangeSet');
      } else {
        expect(actions).toContain('cloudformation:ExecuteChangeSet');
        for (const action of ['cloudformation:DetectStackDrift', 'cloudformation:DetectStackResourceDrift', 'cloudformation:DescribeStackResourceDrifts']) {
          expect(statements.find((statement) => [statement.Action].flat().includes(action))?.Resource)
            .toEqual(stack.resolve(`arn:${stack.partition}:cloudformation:${storage.region}:${storage.account}:stack/ObsidianWorkflowStorage/*`));
        }
        for (const action of ['cloudformation:BatchDescribeTypeConfigurations', 'cloudformation:DescribeStackDriftDetectionStatus']) {
          expect(statements.find((statement) => [statement.Action].flat().includes(action))?.Resource).toBe('*');
        }
        expect(actions).not.toContain('cloudformation:CreateChangeSet');
        expect(actions).not.toContain('iam:PassRole');
      }
      expect(actions).not.toContain('s3:GetObject');
      expect(actions).not.toContain('s3:PutObject');
      expect(actions).not.toContain('s3:DeleteObject');
      expect(actions).not.toContain('sts:AssumeRole');
      expect(actions).not.toContain('*');
    }
  });

  it('limits CloudFormation to bucket metadata and the four modeled configuration writes', () => {
    const stack = new GitHubTrustStack(new App(), 'Trust', storage, github);
    const template = Template.fromStack(stack);
    const [id, role] = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([, resource]) => resource.Properties.RoleName === github.executionRoleName)!;
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([{
      Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' },
    }]);
    for (const resource of Object.values(template.findResources('AWS::IAM::Role'))) {
      expect(resource.Properties.ManagedPolicyArns).toBeUndefined();
    }
    const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as Policy[])
      .filter(policy => policy.Properties.Roles.some(ref => ref.Ref === id))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement);
    expect(statements).toHaveLength(2);
    const expectedResources = [storage.buckets.vault.name, storage.buckets.library.name]
      .map(name => stack.resolve(`arn:${stack.partition}:s3:::${name}`));
    for (const statement of statements) expect(statement.Resource).toEqual(expectedResources);
    const actions = statements.flatMap(statement => [statement.Action].flat());
    expect(actions.filter(action => !action.startsWith('s3:Get') && !action.startsWith('s3:List')).sort()).toEqual([
      's3:PutBucketOwnershipControls', 's3:PutBucketPublicAccessBlock',
      's3:PutBucketVersioning', 's3:PutEncryptionConfiguration',
    ]);
    for (const forbidden of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion',
      's3:CreateBucket', 's3:DeleteBucket', 's3:PutBucketPolicy', 's3:PutLifecycleConfiguration']) {
      expect(actions).not.toContain(forbidden);
    }
    expect(actions.every(action => action.startsWith('s3:') && !action.includes('*'))).toBe(true);
    const plan = Object.values(template.findResources('AWS::IAM::Policy') as Record<string, Policy>)
      .flatMap(policy => policy.Properties.PolicyDocument.Statement)
      .find(statement => [statement.Action].flat().includes('iam:PassRole'))!;
    expect(plan.Resource).toEqual({ 'Fn::GetAtt': [id, 'Arn'] });
  });

  it('derives execution permissions from the configured bucket names', () => {
    const changed = structuredClone(storage);
    changed.buckets.library.name = 'another-private-library';
    const stack = new GitHubTrustStack(new App(), 'Trust', changed, github);
    const template = Template.fromStack(stack);
    const [id] = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([, resource]) => resource.Properties.RoleName === github.executionRoleName)!;
    const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as Policy[])
      .filter(policy => policy.Properties.Roles.some(ref => ref.Ref === id))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement);
    for (const statement of statements) expect(statement.Resource).toEqual(
      [changed.buckets.vault.name, changed.buckets.library.name].map(name => stack.resolve(`arn:${stack.partition}:s3:::${name}`)),
    );
  });

  it('rejects mutable repository subjects', () => {
    expect(() => githubSchema.parse({ ...github, repositorySubject: 'repo:yepengfan/obsidian-workflow-infra' })).toThrow();
  });
});
