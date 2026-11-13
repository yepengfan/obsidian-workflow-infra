import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const storage = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
type Statement = { Action: string | string[]; Resource?: unknown; Condition?: { StringEquals?: Record<string, string> } };
type Role = { Properties: { AssumeRolePolicyDocument: { Statement: Statement[] } } };
type Policy = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Statement[] } } };

describe('GitHub OIDC foundation', () => {
  it('uses the native OIDC resource and exact immutable repository/environment subjects', () => {
    const template = Template.fromStack(new GitHubTrustStack(new App(), 'Trust', storage, github));
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    const roles = template.findResources('AWS::IAM::Role') as Record<string, Role>;
    expect(Object.keys(roles)).toHaveLength(2);
    const subjects = Object.values(roles).map((role) => {
      const statement = role.Properties.AssumeRolePolicyDocument.Statement[0]!;
      expect(statement.Condition?.StringEquals?.['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
      return statement.Condition?.StringEquals?.['token.actions.githubusercontent.com:sub'];
    });
    expect(subjects.sort()).toEqual([
      `${github.repositorySubject}:environment:production`, `${github.repositorySubject}:environment:production-plan`,
    ]);
    expect(Object.values(template.toJSON().Resources).map((r) => (r as { Type: string }).Type).sort()).toEqual([
      'AWS::IAM::OIDCProvider', 'AWS::IAM::Policy', 'AWS::IAM::Policy', 'AWS::IAM::Role', 'AWS::IAM::Role',
    ]);
  });

  it('separates creating a change set from executing it and grants no note-object access', () => {
    const stack = new GitHubTrustStack(new App(), 'Trust', storage, github);
    const template = Template.fromStack(stack);
    const roles = template.findResources('AWS::IAM::Role') as Record<string, Role>;
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as Policy[];
    for (const [id, role] of Object.entries(roles)) {
      const subject = role.Properties.AssumeRolePolicyDocument.Statement[0]!.Condition!.StringEquals!['token.actions.githubusercontent.com:sub']!;
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

  it('rejects mutable repository subjects', () => {
    expect(() => githubSchema.parse({ ...github, repositorySubject: 'repo:yepengfan/obsidian-workflow-infra' })).toThrow();
  });
});
