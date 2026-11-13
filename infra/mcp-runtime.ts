import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnApi, CfnIntegration, CfnRoute, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { CfnManagedLoginBranding, CfnUserPoolClient, CfnUserPoolResourceServer, type CfnUserPool, type CfnUserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { CfnFunction, CfnPermission } from 'aws-cdk-lib/aws-lambda';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import type { CfnBucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { runtimeOptionsSchema } from '../src/config.js';
import type { CodeBundle } from '../bin/runtime-package.js';
import { mcpDeploymentSchema, type McpDeploymentConfig } from './mcp-permissions.js';

export const mcpAppSchema = runtimeOptionsSchema.extend({ notePrefix: mcpDeploymentSchema.shape.notePrefix });
export type McpApplication = { options: ReturnType<typeof mcpAppSchema.parse>; code: CodeBundle; noteBucket: string };

export function addMcpRuntime(scope: Construct, deployment: McpDeploymentConfig, application: McpApplication,
  pool: CfnUserPool, domain: CfnUserPoolDomain, bucket: CfnBucket) {
  const stack = Stack.of(scope);
  const { notePrefix, ...rawOptions } = application.options;
  if (notePrefix !== deployment.notePrefix) throw Error('Runtime prefix must match the IAM boundary');
  const options = runtimeOptionsSchema.parse(rawOptions);
  const scopeName = 'obsidian.notes/read';
  const resourceServer = new CfnUserPoolResourceServer(scope, 'NotesResourceServer', {
    userPoolId: pool.ref, identifier: 'obsidian.notes', name: 'Private Obsidian notes',
    scopes: [{ scopeName: 'read', scopeDescription: 'Read explicitly selected private Markdown notes' }],
  });
  resourceServer.overrideLogicalId('NotesResourceServer');
  const oauthEnabled = options.callbackUrls.length > 0;
  const client = new CfnUserPoolClient(scope, 'ChatGptClient', {
    userPoolId: pool.ref, clientName: 'obsidian-chatgpt', generateSecret: true,
    allowedOAuthFlowsUserPoolClient: oauthEnabled,
    ...(oauthEnabled ? { allowedOAuthFlows: ['code'], allowedOAuthScopes: ['openid', scopeName], callbackUrLs: options.callbackUrls } : {}),
    supportedIdentityProviders: ['COGNITO'], explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
    accessTokenValidity: 15, idTokenValidity: 15, refreshTokenValidity: 7,
    tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'days' },
    enableTokenRevocation: true, preventUserExistenceErrors: 'ENABLED', readAttributes: ['email'], writeAttributes: ['email'],
  });
  client.overrideLogicalId('ChatGptClient'); client.addResourceDependency(resourceServer);
  const branding = new CfnManagedLoginBranding(scope, 'ChatGptLoginBranding', { userPoolId: pool.ref, clientId: client.ref, useCognitoProvidedValues: true });
  branding.overrideLogicalId('ChatGptLoginBranding'); branding.addResourceDependency(domain);
  const api = new CfnApi(scope, 'McpApi', { name: deployment.apiName, protocolType: 'HTTP', tags: { Project: 'obsidian-mcp' } });
  api.overrideLogicalId('McpApi');
  const endpoint = `${api.attrApiEndpoint}/mcp`;
  const logs = new CfnLogGroup(scope, 'RuntimeLogs', { logGroupName: `/aws/lambda/${deployment.functionName}`, retentionInDays: 14 });
  logs.overrideLogicalId('RuntimeLogs');
  const runtime = new CfnFunction(scope, 'McpFunction', { functionName: deployment.functionName,
    runtime: 'nodejs22.x', handler: 'index.handler', architectures: ['x86_64'], memorySize: 512, timeout: 10,
    role: `arn:${stack.partition}:iam::${stack.account}:role/${deployment.runtimeRoleName}`, reservedConcurrentExecutions: 2,
    code: { s3Bucket: bucket.ref, s3Key: application.code.key },
    environment: { variables: {
      NOTE_BUCKET: application.noteBucket,
      NOTE_PREFIX: deployment.notePrefix, OAUTH_ISSUER: `https://cognito-idp.${stack.region}.amazonaws.com/${pool.ref}`,
      OAUTH_CLIENT_ID: client.ref, OAUTH_SCOPE: scopeName, MCP_RESOURCE: endpoint, MCP_OPTIONS: JSON.stringify(options),
    } }, tags: [{ key: 'Project', value: 'obsidian-mcp' }],
  });
  runtime.overrideLogicalId('McpFunction'); runtime.addResourceDependency(logs);
  const integration = new CfnIntegration(scope, 'McpIntegration', { apiId: api.ref, integrationType: 'AWS_PROXY', integrationUri: runtime.attrArn, payloadFormatVersion: '2.0', timeoutInMillis: 11000 });
  integration.overrideLogicalId('McpIntegration');
  const routes = [ ['McpRoute', 'ANY /mcp'], ['MetadataRoute', 'GET /.well-known/oauth-protected-resource'], ['MetadataPathRoute', 'GET /.well-known/oauth-protected-resource/mcp'] ].map(([id, key]) => {
    const route = new CfnRoute(scope, id!, { apiId: api.ref, routeKey: key!, authorizationType: 'NONE', target: `integrations/${integration.ref}` });
    route.overrideLogicalId(id!); return route;
  });
  const stage = new CfnStage(scope, 'McpStage', { apiId: api.ref, stageName: '$default', autoDeploy: true, tags: { Project: 'obsidian-mcp' }, defaultRouteSettings: { throttlingBurstLimit: 5, throttlingRateLimit: 2 } });
  stage.overrideLogicalId('McpStage'); routes.forEach(route => stage.addResourceDependency(route));
  const permission = new CfnPermission(scope, 'ApiInvokePermission', { action: 'lambda:InvokeFunction', functionName: runtime.ref,
    principal: 'apigateway.amazonaws.com', sourceAccount: stack.account, sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${api.ref}/*/*` });
  permission.overrideLogicalId('ApiInvokePermission');
  for (const resource of [resourceServer, client, branding, api, logs, runtime, integration, ...routes, stage, permission]) {
    resource.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });
  }
  new CfnOutput(scope, 'McpEndpoint', { value: endpoint });
  new CfnOutput(scope, 'ChatGptClientId', { value: client.ref });
  new CfnOutput(scope, 'NotesScope', { value: scopeName });
}
