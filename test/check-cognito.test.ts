import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const aws = JSON.parse(fs.readFileSync('config/storage.json', 'utf8'));
const cognito = JSON.parse(fs.readFileSync('config/cognito.json', 'utf8'));
const pool = `${aws.region}_Example`;
const issuer = `https://cognito-idp.${aws.region}.amazonaws.com/${pool}`;
const domain = `https://${cognito.domainPrefix}.auth.${aws.region}.amazoncognito.com`;
const metadata = {
  issuer, jwks_uri: `${issuer}/.well-known/jwks.json`,
  authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`,
  code_challenge_methods_supported: ['S256'], response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
};

describe('Cognito discovery command', () => {
  it.each(['valid', 'missing S256', 'wrong output', 'pinned mismatch'] as const)('runs the real CLI for %s', mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cognito-discovery-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'config'));
      for (const file of ['storage.json', 'github.json', 'cognito.json']) fs.copyFileSync(`config/${file}`, path.join(dir, 'config', file));
      if (mode === 'pinned mismatch') {
        const file = path.join(dir, 'config/github.json');
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mcpUserPoolId: `${aws.region}_Different` }));
      }
      const stack = { Stacks: [{ StackName: 'ObsidianMcp', StackStatus: 'CREATE_COMPLETE', Outputs: [
        { OutputKey: 'UserPoolId', OutputValue: pool },
        { OutputKey: 'OAuthIssuer', OutputValue: mode === 'wrong output' ? 'https://other.example' : issuer },
        { OutputKey: 'ManagedLoginDomain', OutputValue: domain },
      ] }] };
      fs.writeFileSync(path.join(dir, 'stack.json'), JSON.stringify(stack));
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ ...metadata,
        ...(mode === 'missing S256' ? { code_challenge_methods_supported: [] } : {}),
      }));
      const requests = path.join(dir, 'requests');
      const preload = path.join(dir, 'fetch.mjs');
      fs.writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ url, redirect: init.redirect })+'\\n');
  if (url.includes('oauth-authorization-server')) return new Response('', { status: 404 });
  return Response.json(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'metadata.json'))}, 'utf8')));
};`);
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload,
        path.resolve('bin/check-cognito.ts'), path.join(dir, 'stack.json')], { cwd: dir, encoding: 'utf8', env: process.env });
      expect(result.error).toBeUndefined();
      expect(result.status === 0, result.stderr).toBe(mode === 'valid');
      if (mode === 'valid') expect(result.stdout).toContain('Cognito discovery passed');
      else expect(result.stdout).not.toContain('Cognito discovery passed');
      const calls = fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      expect(calls).toHaveLength(['valid', 'missing S256'].includes(mode) ? 2 : 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
