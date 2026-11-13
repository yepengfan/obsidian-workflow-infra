import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const settings = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));

describe('Cognito compatibility probe', () => {
  it('synthesizes only a retained protected pool and prefix domain, without assets or credentials', () => {
    const stack = new CognitoStack(new App(), 'ObsidianMcp', aws, settings);
    const template = Template.fromStack(stack).toJSON();
    expect(stack.terminationProtection).toBe(true);
    expect(Object.keys(template.Resources).sort()).toEqual(['UserPool', 'UserPoolDomain']);
    expect(template.Resources.UserPool).toMatchObject({
      Type: 'AWS::Cognito::UserPool', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: {
        UserPoolTags: { Project: 'obsidian-mcp' }, UserPoolTier: 'ESSENTIALS',
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        DeletionProtection: 'ACTIVE', MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        UsernameAttributes: ['email'], UsernameConfiguration: { CaseSensitive: false },
        Policies: { PasswordPolicy: { MinimumLength: 14, TemporaryPasswordValidityDays: 1 } },
      },
    });
    expect(template.Resources.UserPoolDomain).toMatchObject({
      Type: 'AWS::Cognito::UserPoolDomain', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: { UserPoolId: { Ref: 'UserPool' }, Domain: settings.domainPrefix, ManagedLoginVersion: 2 },
    });
    expect(template.Resources.UserPoolDomain.Properties.CustomDomainConfig).toBeUndefined();
    expect(template.Parameters).toBeUndefined();
    expect(template.Rules).toBeUndefined();
    expect(Object.keys(template.Outputs).sort()).toEqual(['ManagedLoginDomain', 'OAuthIssuer', 'UserPoolId']);
  });

  it.each(['https://auth.example.com', 'auth.example.com', 'Uppercase', 'aws-test', '-prefix', 'prefix-', 'x'.repeat(64)])('rejects unsupported domain %s', domainPrefix => {
    expect(cognitoSchema.safeParse({ ...settings, domainPrefix }).success).toBe(false);
  });
});
