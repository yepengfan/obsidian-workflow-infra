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
  it.each(['valid', 'missing S256', 'wrong output', 'pinned mismatch', 'MCP valid', 'MCP bootstrap', 'MCP wrong metadata', 'MCP legacy scope', 'MCP wrong output scope', 'MCP unprotected', 'MCP bad challenge', 'MCP resource rejected', 'MCP unexpected grant'] as const)('runs the real CLI for %s', mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cognito-discovery-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'config'));
      for (const file of ['storage.json', 'github.json', 'cognito.json', 'mcp-runtime.json']) fs.copyFileSync(`config/${file}`, path.join(dir, 'config', file));
      const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'config/mcp-runtime.json'), 'utf8'));
      runtime.callbackUrls = mode === 'MCP bootstrap' ? [] : ['https://chatgpt.com/connector/oauth/fixture-callback'];
      fs.writeFileSync(path.join(dir, 'config/mcp-runtime.json'), JSON.stringify(runtime));
      const stack = { Stacks: [{ StackName: 'ObsidianMcp', StackStatus: 'CREATE_COMPLETE', Outputs: [
        { OutputKey: 'UserPoolId', OutputValue: pool },
        ...(mode.startsWith('MCP') ? [
          { OutputKey: 'McpEndpoint', OutputValue: `https://example.execute-api.${aws.region}.amazonaws.com/mcp` },
          { OutputKey: 'NotesScope', OutputValue: mode === 'MCP wrong output scope' ? 'obsidian.notes/read' : `https://example.execute-api.${aws.region}.amazonaws.com/mcp/read` },
          { OutputKey: 'ChatGptClientId', OutputValue: 'fixture-client' },
        ] : []),
        { OutputKey: 'PermissionPoolArn', OutputValue: `arn:aws:cognito-idp:${aws.region}:${aws.account}:userpool/${mode === 'pinned mismatch' ? 'Other' : pool}` },
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
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ url, redirect: init.redirect, credentials: init.credentials })+'\\n');
  if (new URL(url).hostname === 'example.execute-api.${aws.region}.amazonaws.com') {
    const endpoint = 'https://example.execute-api.${aws.region}.amazonaws.com/mcp';
    if (init.method === 'POST') return new Response('', { status: ${JSON.stringify(mode)} === 'MCP unprotected' ? 200 : 401, headers: { 'WWW-Authenticate': ${JSON.stringify(mode)} === 'MCP bad challenge' ? 'Bearer' : 'Bearer resource_metadata="https://example.execute-api.${aws.region}.amazonaws.com/.well-known/oauth-protected-resource/mcp", scope="' + endpoint + '/read"' } });
    return Response.json({ resource: ${JSON.stringify(mode)} === 'MCP wrong metadata' ? 'https://wrong.example/mcp' : endpoint, authorization_servers: [${JSON.stringify(issuer)}], scopes_supported: [${JSON.stringify(mode)} === 'MCP legacy scope' ? 'obsidian.notes/read' : endpoint + '/read'] });
  }
  if (url.includes('/oauth2/authorize')) {
    const authorization = new URL(url);
    const target = new URL(authorization.searchParams.get('redirect_uri'));
    target.searchParams.set('state', authorization.searchParams.get('state'));
    if (${JSON.stringify(mode)} === 'MCP unexpected grant') target.searchParams.set('code', 'DO_NOT_PRINT_AUTHORIZATION_CODE');
    else target.searchParams.set('error', ${JSON.stringify(mode)} === 'MCP resource rejected' ? 'invalid_request' : 'login_required');
    return new Response('', { status: 302, headers: { Location: target.href } });
  }
  if (url.includes('oauth-authorization-server')) return new Response('', { status: 404 });
  return Response.json(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'metadata.json'))}, 'utf8')));
};`);
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload,
        path.resolve('bin/check-cognito.ts'), path.join(dir, 'stack.json')], { cwd: dir, encoding: 'utf8', env: process.env });
      expect(result.error).toBeUndefined();
      const valid = ['valid', 'MCP valid', 'MCP bootstrap'].includes(mode);
      expect(result.status === 0, result.stderr).toBe(valid);
      if (valid) expect(result.stdout).toContain('Cognito discovery passed');
      else expect(result.stdout).not.toContain('Cognito discovery passed');
      const calls = fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      expect(calls).toHaveLength(mode.startsWith('MCP') ? (mode === 'MCP wrong output scope' ? 2 : ['MCP wrong metadata', 'MCP legacy scope'].includes(mode) ? 3 : ['MCP valid', 'MCP resource rejected', 'MCP unexpected grant'].includes(mode) ? 5 : 4) : ['valid', 'missing S256'].includes(mode) ? 2 : 0);
      expect(result.stderr + result.stdout).not.toContain('DO_NOT_PRINT_AUTHORIZATION_CODE');
      if (mode === 'MCP valid') {
        const request = calls.at(-1); const authorization = new URL(request.url);
        const endpoint = `https://example.execute-api.${aws.region}.amazonaws.com/mcp`;
        expect(request.redirect).toBe('manual'); expect(request.credentials).toBe('omit');
        expect(authorization.searchParams.get('resource')).toBe(endpoint);
        expect(authorization.searchParams.get('scope')).toBe(`openid email phone profile ${endpoint}/read`);
        expect(authorization.searchParams.get('prompt')).toBe('none');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
