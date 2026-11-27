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
it('reserves bounded capacity for a parallel MCP metadata refresh burst', () => {
  const options = mcpAppSchema.parse({ notePrefix: '', callbackUrls: ['https://chatgpt.com/connector/oauth/exact-callback-id'] });
  const stack = new CognitoStack(new App(), 'ObsidianMcp', aws, cognito, deployment, { options, code, noteBucket: aws.buckets.vault.name });
  const resources = Template.fromStack(stack).toJSON().Resources;
  const concurrency = resources.McpFunction.Properties.ReservedConcurrentExecutions;
  const gateway = resources.McpStage.Properties.DefaultRouteSettings;
  // Eight concurrent public metadata requests reproduced live Lambda throttles.
  expect(concurrency).toBeGreaterThanOrEqual(8);
  expect(concurrency).toBeLessThanOrEqual(20);
  expect(gateway.ThrottlingBurstLimit).toBeGreaterThanOrEqual(8);
  expect(gateway.ThrottlingBurstLimit).toBeLessThanOrEqual(concurrency);
  expect(gateway.ThrottlingRateLimit).toBe(2);
});
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
  // The MCP runtime and the note indexer.
  template.resourceCountIs('AWS::Lambda::Function', 2); template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  const resources = template.toJSON().Resources;
  const readScope = { 'Fn::Join': ['', [{ Ref: 'NotesResourceServer' }, '/read']] };
  expect(resources.McpFunction.Properties).toMatchObject({ FunctionName: deployment.functionName, Runtime: 'nodejs22.x', Handler: 'index.handler', Timeout: 10,
    Code: { S3Bucket: { Ref: 'CodeArtifacts' }, S3Key: code.key },
    Environment: { Variables: { NOTE_BUCKET: aws.buckets.vault.name, NOTE_PREFIX: '', OAUTH_CLIENT_IDS: { 'Fn::Join': ['', ['["', { Ref: 'ChatGptClient' }, '"]']] }, OAUTH_SCOPE: readScope } } });
  expect(resources.NotesResourceServer.Properties.Identifier).toEqual(resources.McpFunction.Properties.Environment.Variables.MCP_RESOURCE);
  expect(resources.NotesResourceServer.Properties.Scopes.map((scope: { ScopeName: string }) => scope.ScopeName)).toEqual(['read']);
  expect(template.toJSON().Outputs.NotesScope.Value).toEqual(readScope);
  expect(resources.ChatGptClient.DependsOn).toContain('NotesResourceServer');
  expect(JSON.parse(resources.McpFunction.Properties.Environment.Variables.MCP_LIMITS)).toEqual(options.limits);
  expect(JSON.parse(resources.McpFunction.Properties.Environment.Variables.MCP_OPTIONS)).not.toHaveProperty('limits');
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

it.each([false, true])('adds an isolated Claude client with practice writes enabled: %s', writesEnabled => {
  const configuration = { notePrefix: '', callbackUrls: ['https://chatgpt.com/connector/oauth/exact-callback-id'],
    practice: { enabled: true, writesEnabled, timeZone: 'Australia/Brisbane' } };
  const templateFor = (claudeCallbackUrls: string[]) => Template.fromStack(new CognitoStack(new App(), 'ObsidianMcp', aws, cognito,
    { ...deployment, practiceWrites: writesEnabled }, { options: mcpAppSchema.parse({ ...configuration, claudeCallbackUrls }), code, noteBucket: aws.buckets.vault.name }));
  const before = templateFor([]).toJSON();
  const template = templateFor(['https://claude.ai/api/mcp/auth_callback']);
  const after = template.toJSON();
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 2);
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.resourceCountIs('AWS::IAM::Role', 0);
  expect(before.Resources).not.toHaveProperty('ClaudeClient');
  expect(before.Outputs).not.toHaveProperty('ClaudeClientId');
  for (const id of ['ChatGptClient', 'ChatGptLoginBranding', 'UserPool', 'UserPoolDomain', 'OwnersGroup']) {
    expect(after.Resources[id]).toEqual(before.Resources[id]);
  }
  expect(after.Resources.ClaudeClient.Properties).toEqual({ ...before.Resources.ChatGptClient.Properties,
    ClientName: 'obsidian-claude', CallbackURLs: ['https://claude.ai/api/mcp/auth_callback'] });
  expect(after.Resources.ClaudeClient.DependsOn).toContain('NotesResourceServer');
  expect(after.Resources.ClaudeLoginBranding.Properties).toEqual({
    UserPoolId: { Ref: 'UserPool' }, ClientId: { Ref: 'ClaudeClient' }, UseCognitoProvidedValues: true,
  });
  expect(after.Resources.ClaudeLoginBranding.DependsOn).toContain('UserPoolDomain');
  expect(after.Outputs.ClaudeClientId.Value).toEqual({ Ref: 'ClaudeClient' });
  expect(after.Outputs.ChatGptClientId).toEqual(before.Outputs.ChatGptClientId);
  const environment = after.Resources.McpFunction.Properties.Environment.Variables;
  expect(environment.OAUTH_CLIENT_ID).toEqual({ Ref: 'ChatGptClient' });
  expect(environment.MCP_OPTIONS).toEqual(before.Resources.McpFunction.Properties.Environment.Variables.MCP_OPTIONS);
  expect(JSON.parse(environment.MCP_OPTIONS)).not.toHaveProperty('claudeCallbackUrls');
  expect(environment.OAUTH_CLIENT_IDS).toEqual({ 'Fn::Join': ['', ['["', { Ref: 'ChatGptClient' }, '","', { Ref: 'ClaudeClient' }, '"]']] });
  expect(Object.keys(environment).some(key => /secret/iu.test(key))).toBe(false);
  expect(Object.keys(after.Outputs).some(key => /secret/iu.test(key))).toBe(false);
});

const geminiCallback = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture';
it.each([false, true])('adds an isolated Gemini client without changing ChatGPT or Claude, writes enabled: %s', writesEnabled => {
  const configuration = { notePrefix: '', callbackUrls: ['https://chatgpt.com/connector/oauth/exact-callback-id'],
    claudeCallbackUrls: ['https://claude.ai/api/mcp/auth_callback'],
    practice: { enabled: true, writesEnabled, timeZone: 'Australia/Brisbane' } };
  const templateFor = (geminiCallbackUrls: string[]) => Template.fromStack(new CognitoStack(new App(), 'ObsidianMcp', aws, cognito,
    { ...deployment, practiceWrites: writesEnabled }, { options: mcpAppSchema.parse({ ...configuration, geminiCallbackUrls }), code, noteBucket: aws.buckets.vault.name }));
  const before = templateFor([]).toJSON();
  const template = templateFor([geminiCallback]);
  const after = template.toJSON();
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 3);
  template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 3);
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.resourceCountIs('AWS::IAM::Role', 0);
  expect(before.Resources).not.toHaveProperty('GeminiClient');
  expect(before.Outputs).not.toHaveProperty('GeminiClientId');
  for (const id of ['ChatGptClient', 'ChatGptLoginBranding', 'ClaudeClient', 'ClaudeLoginBranding', 'UserPool', 'UserPoolDomain', 'OwnersGroup', 'NotesResourceServer']) {
    expect(after.Resources[id]).toEqual(before.Resources[id]);
  }
  expect(after.Resources.GeminiClient.Properties).toEqual({ ...before.Resources.ClaudeClient.Properties,
    ClientName: 'obsidian-gemini', CallbackURLs: [geminiCallback] });
  expect(after.Resources.GeminiClient.DependsOn).toContain('NotesResourceServer');
  expect(after.Resources.GeminiLoginBranding.Properties).toEqual({
    UserPoolId: { Ref: 'UserPool' }, ClientId: { Ref: 'GeminiClient' }, UseCognitoProvidedValues: true,
  });
  expect(after.Resources.GeminiLoginBranding.DependsOn).toContain('UserPoolDomain');
  expect(after.Outputs.GeminiClientId.Value).toEqual({ Ref: 'GeminiClient' });
  expect(after.Outputs.ChatGptClientId).toEqual(before.Outputs.ChatGptClientId);
  expect(after.Outputs.ClaudeClientId).toEqual(before.Outputs.ClaudeClientId);
  const environment = after.Resources.McpFunction.Properties.Environment.Variables;
  const previous = before.Resources.McpFunction.Properties.Environment.Variables;
  expect(environment.OAUTH_CLIENT_ID).toEqual({ Ref: 'ChatGptClient' });
  expect(environment.OAUTH_SCOPE).toEqual(previous.OAUTH_SCOPE);
  expect(environment.MCP_RESOURCE).toEqual(previous.MCP_RESOURCE);
  expect(environment.MCP_OPTIONS).toEqual(previous.MCP_OPTIONS);
  expect(JSON.parse(environment.MCP_OPTIONS)).not.toHaveProperty('geminiCallbackUrls');
  expect(JSON.parse(environment.MCP_OPTIONS)).not.toHaveProperty('claudeCallbackUrls');
  expect(environment.OAUTH_CLIENT_IDS).toEqual({ 'Fn::Join': ['', ['["', { Ref: 'ChatGptClient' }, '","', { Ref: 'ClaudeClient' }, '","', { Ref: 'GeminiClient' }, '"]']] });
  expect(previous.OAUTH_CLIENT_IDS).toEqual({ 'Fn::Join': ['', ['["', { Ref: 'ChatGptClient' }, '","', { Ref: 'ClaudeClient' }, '"]']] });
  expect(Object.keys(environment).some(key => /secret/iu.test(key))).toBe(false);
  expect(Object.keys(after.Outputs).some(key => /secret/iu.test(key))).toBe(false);
});
it.each(['https://oauth-redirect.googleusercontent.com/r/*', 'https://gemini.google.com/oauth/callback', 'https://vertexaisearch.cloud.google.com/oauth-redirect'])('rejects a guessed or broad Gemini callback %s', callback => {
  expect(mcpAppSchema.safeParse({ notePrefix: '', geminiCallbackUrls: [callback] }).success).toBe(false);
});
it('enables the committed Gemini client for the owner redirect', () => {
  const ownerRedirect = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-example';
  const options = mcpAppSchema.parse(JSON.parse(fs.readFileSync('config/mcp-runtime.json', 'utf8')));
  expect(options.geminiCallbackUrls).toEqual([ownerRedirect]);
  expect(options.callbackUrls).toEqual(['https://chatgpt.com/connector/oauth/example']);
  expect(options.claudeCallbackUrls).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  expect(options.allowedOrigins).toEqual(['https://chatgpt.com', 'https://claude.ai']);
  const stack = new CognitoStack(new App(), 'Committed', aws, cognito,
    mcpResources(aws, github.runtimeRoleName, options.notePrefix, options.practice.writesEnabled, options.metadataSearch, options.journal.writesEnabled),
    { options, code, noteBucket: aws.buckets.vault.name });
  const template = Template.fromStack(stack).toJSON();
  expect(template.Resources.GeminiClient.Properties.ClientName).toBe('obsidian-gemini');
  expect(template.Resources.GeminiClient.Properties.CallbackURLs).toEqual([ownerRedirect]);
  expect(template.Resources.GeminiClient.Properties.GenerateSecret).toBe(true);
  expect(template.Outputs.GeminiClientId.Value).toEqual({ Ref: 'GeminiClient' });
  expect(template.Resources.ClaudeClient.Properties.ClientName).toBe('obsidian-claude');
  expect(template.Resources.ClaudeClient.Properties.CallbackURLs).toEqual(options.claudeCallbackUrls);
  expect(template.Resources.ChatGptClient.Properties.ClientName).toBe('obsidian-chatgpt');
  expect(template.Resources.ChatGptClient.Properties.CallbackURLs).toEqual(options.callbackUrls);
  const environment = template.Resources.McpFunction.Properties.Environment.Variables;
  expect(JSON.parse(environment.MCP_OPTIONS)).not.toHaveProperty('geminiCallbackUrls');
  expect(environment.OAUTH_CLIENT_ID).toEqual({ Ref: 'ChatGptClient' });
  expect(environment.OAUTH_CLIENT_IDS).toEqual({ 'Fn::Join': ['', ['["', { Ref: 'ChatGptClient' }, '","', { Ref: 'ClaudeClient' }, '","', { Ref: 'GeminiClient' }, '"]']] });
  expect(Object.keys(environment).some(key => /secret/iu.test(key))).toBe(false);
  expect(Object.keys(template.Outputs).some(key => /secret/iu.test(key))).toBe(false);
});

it('adds a write scope only when the separate practice IAM boundary matches', () => {
  const options = mcpAppSchema.parse({ notePrefix: '', callbackUrls: ['https://chatgpt.com/connector/oauth/exact-callback-id'],
    practice: { enabled: true, writesEnabled: true, timeZone: 'Australia/Brisbane' } });
  expect(() => new CognitoStack(new App(), 'Mismatch', aws, cognito, deployment, { options, code, noteBucket: aws.buckets.vault.name })).toThrow('IAM boundary');
  const stack = new CognitoStack(new App(), 'Matching', aws, cognito, { ...deployment, practiceWrites: true }, { options, code, noteBucket: aws.buckets.vault.name });
  const resources = Template.fromStack(stack).toJSON().Resources;
  expect(resources.NotesResourceServer.Properties.Scopes.map((scope: { ScopeName: string }) => scope.ScopeName)).toEqual(['read', 'write']);
  expect(resources.ChatGptClient.Properties.AllowedOAuthScopes).toHaveLength(6);
  expect(resources.ChatGptClient.Properties.AllowedOAuthScopes).toContainEqual({ 'Fn::Join': ['', [{ Ref: 'NotesResourceServer' }, '/write']] });
  expect(resources.RuntimeLogs.Properties.RetentionInDays).toBe(14);
});

it('adds the shared write scope for Journal writes only when the Journal IAM boundary matches', () => {
  const options = mcpAppSchema.parse({ notePrefix: '', callbackUrls: ['https://chatgpt.com/connector/oauth/exact-callback-id'], journal: { writesEnabled: true } });
  expect(() => new CognitoStack(new App(), 'Mismatch', aws, cognito, deployment, { options, code, noteBucket: aws.buckets.vault.name })).toThrow('Journal write configuration');
  expect(() => new CognitoStack(new App(), 'Reverse', aws, cognito, { ...deployment, journalWrites: true },
    { options: mcpAppSchema.parse({ notePrefix: '' }), code, noteBucket: aws.buckets.vault.name })).toThrow('Journal write configuration');
  const stack = new CognitoStack(new App(), 'Matching', aws, cognito, { ...deployment, journalWrites: true }, { options, code, noteBucket: aws.buckets.vault.name });
  const resources = Template.fromStack(stack).toJSON().Resources;
  expect(resources.NotesResourceServer.Properties.Scopes.map((scope: { ScopeName: string }) => scope.ScopeName)).toEqual(['read', 'write']);
  expect(resources.ChatGptClient.Properties.AllowedOAuthScopes).toContainEqual({ 'Fn::Join': ['', [{ Ref: 'NotesResourceServer' }, '/write']] });
  expect(JSON.parse(resources.McpFunction.Properties.Environment.Variables.MCP_OPTIONS).journal).toEqual({ writesEnabled: true });
});
