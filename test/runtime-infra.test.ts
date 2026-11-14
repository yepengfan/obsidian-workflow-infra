import { mcpResources } from '../infra/mcp-resources.js';
import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, it } from 'vitest';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { githubSchema } from '../infra/github-stack.js';
import { mcpAppSchema } from '../infra/mcp-runtime.js';
import { storageSchema } from '../infra/storage-config.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const deployment = mcpResources(aws, github.runtimeRoleName);
const cognito = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));
const code = { schemaVersion: 1 as const, sourceSha: 'local', sha256: 'a'.repeat(64), sha256Base64: 'a'.repeat(43) + '=', key: 'releases/' + 'a'.repeat(64) + '.zip', bytes: 100 };
it.each([
  { scope: 'email', attributes: ['email', 'email_verified'] },
  { scope: 'phone', attributes: ['phone_number', 'phone_number_verified'] },
])('grants the claim reads required to exchange the advertised $scope scope', ({ scope, attributes }) => {
  const options = mcpAppSchema.parse({ notePrefix: '', callbackUrls: ['https://chatgpt.com/connector/oauth/exact-callback-id'] });
  const stack = new CognitoStack(new App(), 'ObsidianMcp', aws, cognito, deployment, { options, code, noteBucket: aws.buckets.vault.name });
  const client = Template.fromStack(stack).toJSON().Resources.ChatGptClient.Properties;
  expect(client.AllowedOAuthScopes).toContain(scope);
  expect(client.ReadAttributes).toEqual(expect.arrayContaining(attributes));
  expect(client.WriteAttributes).toEqual(['email']);
});
it.each([false, true])('synthesizes the protected runtime with callback enabled: %s', enabled => {
  const options = mcpAppSchema.parse({ notePrefix: '', callbackUrls: enabled ? ['https://chatgpt.com/connector/oauth/exact-callback-id'] : [] });
  const stack = new CognitoStack(new App(), 'ObsidianMcp', aws, cognito, deployment, { options, code, noteBucket: aws.buckets.vault.name });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::IAM::Role', 0); template.resourceCountIs('AWS::IAM::Policy', 0);
  template.resourceCountIs('AWS::Lambda::Function', 1); template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  const resources = template.toJSON().Resources;
  const readScope = { 'Fn::Join': ['', [{ Ref: 'NotesResourceServer' }, '/read']] };
  expect(resources.McpFunction.Properties).toMatchObject({ FunctionName: deployment.functionName, Runtime: 'nodejs22.x', Handler: 'index.handler', Timeout: 10,
    Code: { S3Bucket: { Ref: 'CodeArtifacts' }, S3Key: code.key },
    Environment: { Variables: { NOTE_BUCKET: aws.buckets.vault.name, NOTE_PREFIX: '', OAUTH_CLIENT_ID: { Ref: 'ChatGptClient' }, OAUTH_SCOPE: readScope } } });
  expect(resources.NotesResourceServer.Properties.Identifier).toEqual(resources.McpFunction.Properties.Environment.Variables.MCP_RESOURCE);
  expect(resources.NotesResourceServer.Properties.Scopes.map((scope: { ScopeName: string }) => scope.ScopeName)).toEqual(['read']);
  expect(template.toJSON().Outputs.NotesScope.Value).toEqual(readScope);
  expect(resources.ChatGptClient.DependsOn).toContain('NotesResourceServer');
  expect(JSON.parse(resources.McpFunction.Properties.Environment.Variables.MCP_OPTIONS).ownerGroup).toBe(options.ownerGroup);
  expect(JSON.parse(resources.McpFunction.Properties.Environment.Variables.MCP_OPTIONS)).not.toHaveProperty('ownerSubjects');
  template.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
  template.resourceCountIs('AWS::Cognito::UserPoolUserToGroupAttachment', 0);
  expect(resources.OwnersGroup.Properties).toEqual({ UserPoolId: { Ref: 'UserPool' }, GroupName: options.ownerGroup,
    Description: 'Authorized private Obsidian MCP users; membership is managed in Cognito' });
  expect(resources.McpFunction.DependsOn).toContain('OwnersGroup');
  expect(resources.ChatGptClient.Properties.AllowedOAuthFlowsUserPoolClient).toBe(enabled);
  expect(resources.ChatGptClient.Properties.GenerateSecret).toBe(true);
  expect(new Set(resources.ChatGptClient.Properties.ReadAttributes)).toEqual(new Set(['email', 'email_verified', 'phone_number', 'phone_number_verified']));
  expect(resources.ChatGptClient.Properties.WriteAttributes).toEqual(['email']);
  if (enabled) {
    expect(resources.ChatGptClient.Properties.AllowedOAuthFlows).toEqual(['code']);
    expect(resources.ChatGptClient.Properties.CallbackURLs).toEqual(options.callbackUrls);
    // Native Cognito advertises these OIDC scopes; ChatGPT requests them by default.
    // The generated client must accept that request without an invalid_scope error.
    expect(new Set(resources.ChatGptClient.Properties.AllowedOAuthScopes)).toEqual(
      new Set(['openid', 'email', 'phone', 'profile', readScope]),
    );
  } else {
    expect(resources.ChatGptClient.Properties.CallbackURLs).toBeUndefined();
    expect(resources.ChatGptClient.Properties.AllowedOAuthFlows).toBeUndefined();
  }
  expect(Object.keys(template.toJSON().Outputs)).not.toContain('ClientSecret');
  expect(resources.McpStage.Properties.Tags).toEqual({ Project: 'obsidian-mcp' });
  expect(resources.McpApi.Properties.Tags).toEqual({ Project: 'obsidian-mcp' });
  expect(resources.ApiInvokePermission.Properties.Principal).toBe('apigateway.amazonaws.com');
  expect(resources.UserPool.Properties.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: true });
  const durable = new Set(['UserPool', 'UserPoolDomain', 'CodeArtifacts', 'CodeArtifactsPolicy']);
  for (const [id, resource] of Object.entries(resources) as [string, { DeletionPolicy: string; UpdateReplacePolicy: string }][]) {
    const policy = durable.has(id) || id === 'OwnersGroup' ? 'Retain' : 'Delete';
    expect(resource.DeletionPolicy, id).toBe(id === 'OwnersGroup' ? 'RetainExceptOnCreate' : policy);
    expect(resource.UpdateReplacePolicy, id).toBe(policy);
  }
});
it.each(['https://evil.example/callback', 'https://chatgpt.com/connector/oauth/*', 'https://chatgpt.com/connector_platform/oauth/callback'])('rejects a guessed or broad callback %s', callback => {
  expect(mcpAppSchema.safeParse({ notePrefix: '', callbackUrls: [callback] }).success).toBe(false);
});
