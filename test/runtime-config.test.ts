import fs from 'node:fs';
import { expect, it } from 'vitest';
import { environmentSettings, runtimeOptionsSchema } from '../src/config.js';

const resource = 'https://example.execute-api.ap-southeast-2.amazonaws.com/mcp';
const environment = {
  AWS_REGION: 'ap-southeast-2', NOTE_BUCKET: 'private-test-vault', MCP_OPTIONS: '{}',
  MCP_RESOURCE: resource, OAUTH_ISSUER: 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Test',
  OAUTH_CLIENT_IDS: JSON.stringify(['test-client']), OAUTH_SCOPE: `${resource}/read`,
};

it('uses legacy limits until the new environment supplies its configured limits', () => {
  const legacy = { ...environment, MCP_OPTIONS: JSON.stringify({ limits: { requestBytes: 65536 } }) };
  expect(environmentSettings(legacy).limits.requestBytes).toBe(65536);
  const limits = { requestBytes: 3145728, canvasElements: 3000 };
  expect(environmentSettings({ ...legacy, MCP_LIMITS: JSON.stringify(limits) }).limits).toMatchObject(limits);
});

it('loads a read scope assigned to the exact MCP resource', () => {
  expect(environmentSettings(environment)).toMatchObject({ resource, scope: `${resource}/read`, clientIds: ['test-client'] });
});
it('loads both explicitly approved OAuth clients', () => {
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_IDS: '["chatgpt-client","claude-client"]' }).clientIds)
    .toEqual(['chatgpt-client', 'claude-client']);
});
it('loads the ChatGPT, Claude and Gemini clients when all three are deployed', () => {
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_IDS: '["chatgpt-client","claude-client","gemini-client"]' }).clientIds)
    .toEqual(['chatgpt-client', 'claude-client', 'gemini-client']);
});
it('supports the previous single-client environment only when the new allowlist is absent', () => {
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_IDS: undefined, OAUTH_CLIENT_ID: 'previous-client' }).clientIds)
    .toEqual(['previous-client']);
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_ID: 'unlisted-previous-client' }).clientIds)
    .toEqual(['test-client']);
  expect(() => environmentSettings({ ...environment, OAUTH_CLIENT_IDS: undefined, OAUTH_CLIENT_ID: undefined })).toThrow();
  expect(() => environmentSettings({ ...environment, OAUTH_CLIENT_IDS: '[]', OAUTH_CLIENT_ID: 'previous-client' })).toThrow();
});
it.each([undefined, '', 'not-json', '"client"', '[]', '[""]', '[null]', '["a","a"]', '["a","b","a"]', '["a","b","c","d"]', '["a b"]'])('fails closed for a malformed client allowlist: %s', clientIds => {
  expect(() => environmentSettings({ ...environment, OAUTH_CLIENT_IDS: clientIds })).toThrow();
});
it('keeps Claude opt-in and its callback separate from ChatGPT', () => {
  const callback = 'https://claude.ai/api/mcp/auth_callback';
  expect(runtimeOptionsSchema.parse({}).claudeCallbackUrls).toEqual([]);
  expect(runtimeOptionsSchema.parse({ claudeCallbackUrls: [callback] }).claudeCallbackUrls).toEqual([callback]);
  expect(runtimeOptionsSchema.safeParse({ callbackUrls: [callback] }).success).toBe(false);
});
it.each([
  'https://chatgpt.com/connector/oauth/example', 'https://claude.ai/api/mcp/auth_callback/',
  'https://claude.ai/api/mcp/auth_callback?x=1', 'https://claude.ai/api/mcp/auth_callback#fragment',
  'https://claude.ai.evil.example/api/mcp/auth_callback', 'https://user@claude.ai/api/mcp/auth_callback',
  'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai/*',
])('rejects non-exact Claude callback %s', callback => {
  expect(runtimeOptionsSchema.safeParse({ claudeCallbackUrls: [callback] }).success).toBe(false);
});
const geminiCallback = (host: string, prefix: 'r' | 'a', id: string) => `https://${host}/${prefix}/${id}`;
it('keeps Gemini opt-in until an exact redirect URI is configured', () => {
  const committed = JSON.parse(fs.readFileSync('config/mcp-runtime.json', 'utf8'));
  expect(committed).not.toHaveProperty('geminiCallbackUrls');
  delete committed.notePrefix;
  expect(runtimeOptionsSchema.parse(committed).geminiCallbackUrls).toEqual([]);
  expect(runtimeOptionsSchema.parse({}).geminiCallbackUrls).toEqual([]);
  expect(runtimeOptionsSchema.shape.geminiCallbackUrls.parse(undefined)).toEqual([]);
  const callback = geminiCallback('oauth-redirect.googleusercontent.com', 'r', 'user_bound_custom-mcp-fixture');
  expect(runtimeOptionsSchema.parse({ geminiCallbackUrls: [callback] }).geminiCallbackUrls).toEqual([callback]);
  expect(runtimeOptionsSchema.safeParse({ callbackUrls: [callback] }).success).toBe(false);
  expect(runtimeOptionsSchema.safeParse({ claudeCallbackUrls: [callback] }).success).toBe(false);
});
it('accepts the six exact Connected Apps redirect families', () => {
  const hosts = ['oauth-redirect.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com'];
  const callbacks = hosts.flatMap(host => (['r', 'a'] as const).map((prefix, index) => geminiCallback(host, prefix, `app-${index}`)));
  expect(runtimeOptionsSchema.parse({ geminiCallbackUrls: callbacks }).geminiCallbackUrls).toEqual(callbacks);
  expect(runtimeOptionsSchema.safeParse({ geminiCallbackUrls: [...callbacks, geminiCallback(hosts[0]!, 'r', 'extra')] }).success).toBe(false);
});
it.each([
  'https://oauth-redirect.googleusercontent.com/r/*',
  'https://oauth-redirect-sandbox.googleusercontent.com/a/*',
  'https://oauth-redirect-test.googleusercontent.com/r/user_bound_custom-mcp-*',
  'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture/extra',
  'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture/',
  'https://oauth-redirect.googleusercontent.com/r/',
  'https://oauth-redirect.googleusercontent.com/oauth-redirect',
  'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture?x=1',
  'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture#fragment',
  'https://user@oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture',
  'http://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture',
  'https://oauth-redirect.googleusercontent.com.evil.example/r/user_bound_custom-mcp-fixture',
  'https://gemini.google.com/r/user_bound_custom-mcp-fixture',
  'https://vertexaisearch.cloud.google.com/oauth-redirect',
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector/oauth/example',
])('rejects a guessed or broad Gemini callback %s', callback => {
  expect(runtimeOptionsSchema.safeParse({ geminiCallbackUrls: [callback] }).success).toBe(false);
});
it.each(['obsidian.notes/read', 'https://other.example/mcp/read', `${resource}/write`, resource])('rejects a scope assigned to a different resource or operation: %s', scope => {
  expect(() => environmentSettings({ ...environment, OAUTH_SCOPE: scope })).toThrow();
});
