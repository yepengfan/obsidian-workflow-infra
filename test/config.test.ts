import { describe, expect, it } from 'vitest';
import { deploymentSchema, loadRuntimeConfig } from '../src/config.js';
import fs from 'node:fs';
import { config } from './fixtures.js';

describe('fail-closed configuration', () => {
  it('validates Cognito deployment settings without accepting secrets or unsafe paths', () => {
    const base = JSON.parse(fs.readFileSync('config/example.json', 'utf8'));
    expect(deploymentSchema.parse(base).prefix).toBe('vault/');
    expect(() => deploymentSchema.parse({ ...base, prefix: undefined })).toThrow();
    expect(() => deploymentSchema.parse({ ...base, prefix: 'vault/*' })).toThrow();
    expect(deploymentSchema.parse(base).cognito.allowedSubjects).toEqual([]);
    expect(() => deploymentSchema.parse({ ...base, cognito: { ...base.cognito, allowedSubjects: ['not-a-uuid'] } })).toThrow();
    expect(() => deploymentSchema.parse({ ...base, cognito: { ...base.cognito, callbackUrls: ['http://attacker.example'] } })).toThrow();
    expect(() => deploymentSchema.parse({ ...base, cognito: { ...base.cognito, clientSecret: 'must-not-be-here' } })).toThrow();
  });
  it('has no anonymous fallback if runtime environment is incomplete', () => {
    expect(() => loadRuntimeConfig({})).toThrow();
  });
  it('loads an empty allowlist for first deployment without enabling anyone', () => {
    const value = loadRuntimeConfig({ NOTES_BUCKET: config.bucket, NOTES_PREFIX: config.prefix, NOTES_REGION: config.region,
      OAUTH_CONFIG: JSON.stringify({ ...config.oauth, allowedSubjects: [] }), MCP_RESOURCE: config.resource,
      ALLOWED_ORIGINS: JSON.stringify(config.allowedOrigins) });
    expect(value.oauth.allowedSubjects).toEqual([]);
  });
});
