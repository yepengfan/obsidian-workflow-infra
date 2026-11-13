import { CfnOutput, DefaultStackSynthesizer, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnUserPool, CfnUserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import { z } from 'zod';
import type { StorageConfig } from './storage-config.js';

export const cognitoSchema = z.strictObject({
  userPoolName: z.string().min(1).max(128).regex(/^[\w -]+$/u),
  // AWS prefix domains only. Custom domains require a separate IAM review.
  domainPrefix: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u)
    .refine(value => !['aws', 'amazon', 'cognito'].some(reserved => value.includes(reserved)), 'Reserved Cognito domain prefix'),
});

/** A retained issuer probe, with no client, user, registration or MCP endpoint. */
export class CognitoStack extends Stack {
  constructor(scope: Construct, id: string, aws: Pick<StorageConfig, 'account' | 'region'>, settings: z.infer<typeof cognitoSchema>) {
    super(scope, id, {
      env: { account: aws.account, region: aws.region },
      synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
      terminationProtection: true,
      description: 'Retained Cognito issuer compatibility probe for private Obsidian MCP',
    });
    const pool = new CfnUserPool(this, 'UserPool', {
      userPoolName: settings.userPoolName,
      userPoolTier: 'ESSENTIALS',
      userPoolTags: { Project: 'obsidian-mcp' },
      deletionProtection: 'ACTIVE',
      adminCreateUserConfig: { allowAdminCreateUserOnly: true },
      usernameAttributes: ['email'],
      usernameConfiguration: { caseSensitive: false },
      autoVerifiedAttributes: ['email'],
      schema: [{ name: 'email', attributeDataType: 'String', required: true, mutable: true }],
      mfaConfiguration: 'ON',
      enabledMfas: ['SOFTWARE_TOKEN_MFA'],
      accountRecoverySetting: { recoveryMechanisms: [{ name: 'verified_email', priority: 1 }] },
      policies: { passwordPolicy: {
        minimumLength: 14, requireLowercase: true, requireUppercase: true,
        requireNumbers: true, requireSymbols: true, temporaryPasswordValidityDays: 1,
      } },
    });
    pool.overrideLogicalId('UserPool');
    const domain = new CfnUserPoolDomain(this, 'UserPoolDomain', {
      domain: settings.domainPrefix, userPoolId: pool.ref, managedLoginVersion: 2,
    });
    domain.overrideLogicalId('UserPoolDomain');
    for (const resource of [pool, domain]) {
      resource.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });
    }
    new CfnOutput(this, 'UserPoolId', { value: pool.ref });
    // The pool uses Cognito's default original issuer. The live check verifies
    // the exact issuer instead of assuming PKCE/discovery compatibility.
    new CfnOutput(this, 'OAuthIssuer', { value: `https://cognito-idp.${aws.region}.amazonaws.com/${pool.ref}` });
    new CfnOutput(this, 'ManagedLoginDomain', { value: `https://${settings.domainPrefix}.auth.${aws.region}.amazoncognito.com` });
  }
}
