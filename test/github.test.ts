import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { GitHubTrustStack } from '../infra/github-stack.js';

it('separates read-only plan and deploy trust by exact GitHub environment subject', () => {
  const template = Template.fromStack(new GitHubTrustStack(new App(), 'Trust', {
    account: '111111111111', region: 'ap-southeast-2', repositorySubject: 'repo:owner@123/repo@456', createProvider: false, bootstrapQualifier: 'hnb659fds',
  }));
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.resourceCountIs('AWS::IAM::Role', 2);
  const roles = JSON.stringify(template.findResources('AWS::IAM::Role'));
  expect(roles).toContain('repo:owner@123/repo@456:environment:production-plan');
  expect(roles).toContain('repo:owner@123/repo@456:environment:production');
  expect(roles).not.toContain('StringLike');
  const policies = template.findResources('AWS::IAM::Policy');
  const plan = Object.entries(policies).find(([id]) => id.startsWith('PlanRole'))?.[1];
  expect(JSON.stringify(plan)).not.toContain('sts:AssumeRole');
  expect(JSON.stringify(policies)).not.toContain('AdministratorAccess');
});
