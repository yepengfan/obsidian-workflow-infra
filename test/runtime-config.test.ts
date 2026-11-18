import { expect, it } from 'vitest';
import { environmentSettings, runtimeOptionsSchema } from '../src/config.js';

const resource = 'https://example.execute-api.ap-southeast-2.amazonaws.com/mcp';
const environment = {
  AWS_REGION: 'ap-southeast-2', NOTE_BUCKET: 'private-test-vault', MCP_OPTIONS: '{}',
  MCP_RESOURCE: resource, OAUTH_ISSUER: 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Test',
  OAUTH_CLIENT_IDS: JSON.stringify(['test-client']), OAUTH_SCOPE: `${resource}/read`,
};

it('loads a read scope assigned to the exact MCP resource', () => {
  expect(environmentSettings(environment)).toMatchObject({ resource, scope: `${resource}/read`, clientIds: ['test-client'] });
});
it('loads both explicitly approved OAuth clients', () => {
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_IDS: '["chatgpt-client","claude-client"]' }).clientIds)
    .toEqual(['chatgpt-client', 'claude-client']);
});
it('supports the previous single-client environment only when the new allowlist is absent', () => {
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_IDS: undefined, OAUTH_CLIENT_ID: 'previous-client' }).clientIds)
    .toEqual(['previous-client']);
  expect(environmentSettings({ ...environment, OAUTH_CLIENT_ID: 'unlisted-previous-client' }).clientIds)
    .toEqual(['test-client']);
  expect(() => environmentSettings({ ...environment, OAUTH_CLIENT_IDS: undefined, OAUTH_CLIENT_ID: undefined })).toThrow();
  expect(() => environmentSettings({ ...environment, OAUTH_CLIENT_IDS: '[]', OAUTH_CLIENT_ID: 'previous-client' })).toThrow();
});
it.each([undefined, '', 'not-json', '"client"', '[]', '[""]', '[null]', '["a","a"]', '["a","b","c"]', '["a b"]'])('fails closed for a malformed client allowlist: %s', clientIds => {
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
it.each(['obsidian.notes/read', 'https://other.example/mcp/read', `${resource}/write`, resource])('rejects a scope assigned to a different resource or operation: %s', scope => {
  expect(() => environmentSettings({ ...environment, OAUTH_SCOPE: scope })).toThrow();
});
