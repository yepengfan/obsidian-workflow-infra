import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ObsidianStack } from '../infra/stack.js';
import { deploymentSchema } from '../src/config.js';

describe('read-only infrastructure', () => {
  it('does not create or change S3 and grants only prefix-scoped data reads', () => {
    const config = deploymentSchema.parse(JSON.parse(fs.readFileSync('config/example.json', 'utf8')));
    const stack = new ObsidianStack(new App(), 'Test', config);
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::S3::BucketPolicy', 0);
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolUser', 0);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'], UserPoolTier: 'ESSENTIALS',
      DeletionProtection: 'ACTIVE',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true, AllowedOAuthFlowsUserPoolClient: false,
      AccessTokenValidity: 15, RefreshTokenValidity: 30,
      RefreshTokenRotation: { Feature: 'ENABLED', RetryGracePeriodSeconds: 10 },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    const raw = template.toJSON();
    expect(JSON.stringify(raw.Outputs)).not.toContain('ClientSecret');
    expect(raw.Outputs.OAuthLoginEnabled.Value).toBe('false');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([
        Match.objectLike({ Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': ['vault/*'] } } }),
        Match.objectLike({ Action: 's3:GetObject' }),
      ]) },
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).not.toMatch(/PutObject|DeleteObject|s3:\*|ListAllMyBuckets/u);
    expect(policies).toContain('replace-with-private-obsidian-bucket/vault/*');
    template.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Timeout: 25, ReservedConcurrentExecutions: 5 });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 },
    });
  }, 30_000);
  it('enables only authorization-code login for explicitly configured callbacks', () => {
    const config = deploymentSchema.parse(JSON.parse(fs.readFileSync('config/example.json', 'utf8')));
    config.cognito.callbackUrls = ['https://chatgpt.com/connector/oauth/test-connection'];
    const template = Template.fromStack(new ObsidianStack(new App(), 'Enabled', config));
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'],
      CallbackURLs: config.cognito.callbackUrls,
      AllowedOAuthScopes: ['openid', 'email', 'profile', 'phone', 'obsidian-mcp/read'],
    });
  }, 30_000);
});
