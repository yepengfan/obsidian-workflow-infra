import { expect, it } from 'vitest';
import { environmentSettings } from '../src/config.js';

const resource = 'https://example.execute-api.ap-southeast-2.amazonaws.com/mcp';
const environment = {
  AWS_REGION: 'ap-southeast-2', NOTE_BUCKET: 'private-test-vault', MCP_OPTIONS: '{}',
  MCP_RESOURCE: resource, OAUTH_ISSUER: 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Test',
  OAUTH_CLIENT_ID: 'test-client', OAUTH_SCOPE: `${resource}/read`,
};

it('loads a read scope assigned to the exact MCP resource', () => {
  expect(environmentSettings(environment)).toMatchObject({ resource, scope: `${resource}/read` });
});
it.each(['obsidian.notes/read', 'https://other.example/mcp/read', `${resource}/write`, resource])('rejects a scope assigned to a different resource or operation: %s', scope => {
  expect(() => environmentSettings({ ...environment, OAUTH_SCOPE: scope })).toThrow();
});
