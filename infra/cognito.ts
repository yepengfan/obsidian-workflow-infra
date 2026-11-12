import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import type { DeploymentConfig, RuntimeConfig } from '../src/config.js';

export class CognitoAuth extends Construct {
  readonly oauth: RuntimeConfig['oauth'];

  constructor(scope: Construct, id: string, config: DeploymentConfig) {
    super(scope, id);
    const stack = Stack.of(this);
    const settings = config.cognito;
    const pool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true }, signInCaseSensitive: false,
      autoVerify: { email: true }, accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.REQUIRED, mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 14, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      removalPolicy: RemovalPolicy.RETAIN, deletionProtection: true,
    });
    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: settings.domainPrefix ?? `obsidian-mcp-${config.account}-${config.region}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const server = new cognito.CfnUserPoolResourceServer(this, 'ResourceServer', {
      userPoolId: pool.userPoolId, identifier: settings.resourceIdentifier,
      name: 'Read private Obsidian notes', scopes: [{ scopeName: settings.scopeName, scopeDescription: 'List, search and read private Markdown notes' }],
    });
    const readScope = `${settings.resourceIdentifier}/${settings.scopeName}`;
    const oauthEnabled = settings.callbackUrls.length > 0;
    // No invented callback URL: first deploy creates the pool with OAuth disabled.
    // Re-deploy with the exact ChatGPT callback to enable authorization-code login.
    const client = new cognito.CfnUserPoolClient(this, 'ChatGptClient', {
      userPoolId: pool.userPoolId, clientName: 'ChatGPT Obsidian MCP', generateSecret: true,
      supportedIdentityProviders: ['COGNITO'], explicitAuthFlows: ['ALLOW_USER_SRP_AUTH'],
      allowedOAuthFlowsUserPoolClient: oauthEnabled,
      ...(oauthEnabled ? { allowedOAuthFlows: ['code'], allowedOAuthScopes: ['openid', 'email', 'profile', 'phone', readScope], callbackUrLs: settings.callbackUrls } : {}),
      accessTokenValidity: settings.accessTokenMinutes, idTokenValidity: settings.accessTokenMinutes,
      refreshTokenValidity: settings.refreshTokenDays,
      tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'days' },
      enableTokenRevocation: true, preventUserExistenceErrors: 'ENABLED',
      refreshTokenRotation: { feature: 'ENABLED', retryGracePeriodSeconds: 10 },
      readAttributes: ['email', 'email_verified', 'phone_number', 'phone_number_verified'], writeAttributes: ['email'],
    });
    client.addResourceDependency(server);
    client.applyRemovalPolicy(RemovalPolicy.RETAIN);
    server.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const branding = new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: pool.userPoolId, clientId: client.ref, useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);
    const issuer = `https://cognito-idp.${config.region}.${stack.urlSuffix}/${pool.userPoolId}`;
    this.oauth = { issuer, jwksUri: `${issuer}/.well-known/jwks.json`, clientId: client.ref,
      allowedSubjects: settings.allowedSubjects, scope: readScope, requestOfflineAccess: false };
    new CfnOutput(stack, 'CognitoUserPoolId', { value: pool.userPoolId });
    new CfnOutput(stack, 'CognitoLoginUrl', { value: domain.baseUrl() });
    new CfnOutput(stack, 'OAuthLoginEnabled', { value: String(oauthEnabled) });
    // Never output ClientSecret; the owner reads it directly in the AWS console.
  }
}
