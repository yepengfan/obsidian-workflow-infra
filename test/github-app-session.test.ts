import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { appEnvironment, consumeAppKeyEnvironment, openAppSession, parseAppConfig, requireNoMistakesDaemon, runAppCommand, type AppConfig } from '../bin/github-app-session.js';

const config: AppConfig = { clientId: 'IvEXAMPLE', appId: 123, installationId: 456,
  owner: 'example', repository: 'private-repo', repositoryId: 789,
  botLogin: 'example-app[bot]', botUserId: 12345 };
let pem: string;
let publicKey: crypto.KeyObject;
beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  publicKey = pair.publicKey;
});

function github(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    '/app': { id: 123, slug: 'example-app', owner: { login: 'example' } },
    '/repos/example/private-repo/installation': { id: 456, app_id: 123, account: { login: 'example' },
      suspended_at: null, repository_selection: 'all', permissions: { contents: 'write', metadata: 'read', pull_requests: 'write', actions: 'write' } },
    '/app/installations/456/access_tokens': { token: 'test-installation-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: 'write', metadata: 'read', pull_requests: 'write', actions: 'read' } },
    '/installation/repositories?per_page=100': { total_count: 1, repositories: [{ id: 789, full_name: 'example/private-repo' }] },
    ...overrides,
  };
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const route = url.pathname + url.search;
    if (route === '/installation/token' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (!(route in data)) throw new Error(`Unexpected test route: ${route}`);
    return Response.json(data[route]);
  });
}

describe('repository-scoped App sessions', () => {
  it('consumes only the explicitly selected environment key and rejects a missing key', () => {
    const env = { GITHUB_APP_TEST_PRIVATE_KEY: pem, KEEP: 'unrelated' };
    expect(consumeAppKeyEnvironment('GITHUB_APP_TEST_PRIVATE_KEY', env).toString()).toBe(pem);
    expect(env).toEqual({ KEEP: 'unrelated' });
    expect(() => consumeAppKeyEnvironment('GITHUB_APP_TEST_PRIVATE_KEY', env)).toThrow('missing or empty');
    expect(() => consumeAppKeyEnvironment('GH_TOKEN', { GH_TOKEN: 'personal' })).toThrow('dedicated');
  });

  it('erases the supplied buffer even when private-key parsing fails', async () => {
    const invalid = Buffer.from('not-a-private-key');
    const request = github();
    await expect(openAppSession(invalid, config, request)).rejects.toThrow();
    expect(invalid.every(byte => byte === 0)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['environment', 'fd'])('the real %s CLI isolates the key, runs Git as the bot and revokes its token', delivery => {
    const root = fs.realpathSync(fs.mkdtempSync('/tmp/app-key-route-'));
    const adapter = path.resolve('bin/github-app-session.ts');
    const configPath = path.join(root, 'config.json');
    const preload = path.join(root, 'github.mjs');
    const marker = path.join(root, 'revoked');
    const child = path.join(root, 'inspect.mjs');
    try {
      fs.writeFileSync(configPath, JSON.stringify(config));
      fs.writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const route = url.pathname + url.search;
  if (route === '/installation/token' && init.method === 'DELETE') {
    fs.writeFileSync(${JSON.stringify(marker)}, 'revoked');
    return new Response(null, { status: 204 });
  }
  const data = {
    '/app': { id: 123, slug: 'example-app', owner: { login: 'example' } },
    '/repos/example/private-repo/installation': { id: 456, app_id: 123,
      account: { login: 'example' }, suspended_at: null, permissions: {} },
    '/app/installations/456/access_tokens': { token: 'test-installation-token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } },
    '/installation/repositories?per_page=100': { total_count: 1,
      repositories: [{ id: 789, full_name: 'example/private-repo' }] }
  };
  if (!(route in data)) throw new Error('Unexpected test API route');
  return Response.json(data[route]);
};`);
      fs.writeFileSync(child, `import assert from 'node:assert/strict';
assert.equal(process.env.GITHUB_APP_TEST_PRIVATE_KEY, undefined);
assert.equal(process.env.GH_TOKEN, 'test-installation-token');
assert.equal(process.env.GIT_AUTHOR_NAME, 'example-app[bot]');
assert.equal(process.env.GIT_COMMITTER_NAME, 'example-app[bot]');
console.log('isolated App child passed');`);
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      expect(spawnSync('git', ['init', root], { env: gitEnv }).status).toBe(0);
      expect(spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/private-repo.git'], { env: gitEnv }).status).toBe(0);
      const keyPath = path.join(root, 'fixture-key.pem');
      fs.writeFileSync(keyPath, pem, { mode: 0o600 });
      const fd = fs.openSync(keyPath, 'r');
      try {
        const env = { ...process.env };
        delete env.GITHUB_APP_TEST_PRIVATE_KEY;
        if (delivery === 'environment') env.GITHUB_APP_TEST_PRIVATE_KEY = pem;
        const result = spawnSync(process.execPath, ['--import', preload, adapter,
          ...(delivery === 'environment' ? ['--key-env', 'GITHUB_APP_TEST_PRIVATE_KEY'] : []),
          configPath, '--', 'git', '-c', `alias.inspect=!"${process.execPath}" "${child}"`, 'inspect'], {
          cwd: root, env, encoding: 'utf8', timeout: 15_000,
          stdio: ['pipe', 'pipe', 'pipe', delivery === 'fd' ? fd : 'ignore'],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('isolated App child passed');
        expect(result.stderr).toContain('installation token revoked');
        expect(result.stdout + result.stderr).not.toContain(pem);
        expect(fs.readFileSync(marker, 'utf8')).toBe('revoked');
      } finally { fs.closeSync(fd); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('signs a bounded JWT, explicitly narrows scope, verifies the token and revokes it', async () => {
    const request = github();
    const session = await openAppSession(Buffer.from(pem), config, request);
    const init = request.mock.calls[0]![1]!;
    const jwt = String((init.headers as Record<string, string>).Authorization).slice(7);
    const [header, payload, signature] = jwt.split('.');
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe(config.clientId);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const tokenRequest = request.mock.calls.find(([url]) => String(url).endsWith('/access_tokens'))![1]!;
    expect(JSON.parse(String(tokenRequest.body))).toEqual({ repository_ids: [789], permissions: {
      contents: 'write', pull_requests: 'write', metadata: 'read', actions: 'read',
    } });
    expect(tokenRequest.redirect).toBe('error');
    await session.revoke();
    expect(request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });

  it('rejects a different App before issuing a token', async () => {
    const request = github({ '/app': { id: 999, slug: 'example-app', owner: { login: 'example' } } });
    await expect(openAppSession(Buffer.from(pem), config, request)).rejects.toThrow('App identity mismatch');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a different installation before issuing a token', async () => {
    const request = github({ '/repos/example/private-repo/installation': { id: 999, app_id: 123, account: { login: 'example' }, suspended_at: null } });
    await expect(openAppSession(Buffer.from(pem), config, request)).rejects.toThrow('Installation mismatch');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { total_count: 2, repositories: [{ id: 789, full_name: 'example/private-repo' }, { id: 987, full_name: 'example/other-private-repo' }] },
    { total_count: 1, repositories: [{ id: 987, full_name: 'example/other-private-repo' }] },
  ])('revokes a token whose effective repository scope differs from the request', async scope => {
    const request = github({ '/installation/repositories?per_page=100': scope });
    await expect(openAppSession(Buffer.from(pem), config, request)).rejects.toThrow('Token repository scope mismatch');
    expect(request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });

  it('revokes a token with an unexpected write capability', async () => {
    const request = github({ '/app/installations/456/access_tokens': { token: 'test-installation-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { administration: 'write' } } });
    await expect(openAppSession(Buffer.from(pem), config, request)).rejects.toThrow('Unexpected token permissions');
    expect(request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });

  it('does not include an API error response body or a credential in its error', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ message: 'private-response test-installation-token' }, { status: 403 }));
    await expect(openAppSession(Buffer.from(pem), config, request)).rejects.toThrow('GitHub GET /app: HTTP 403');
  });
});

describe('Git and gh credential isolation', () => {
  it('keeps parent timers responsive while an actual child command runs', async () => {
    let parentTimerRan = false;
    const timer = setTimeout(() => { parentTimerRan = true; }, 10);
    try {
      const status = await runAppCommand(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 150)'], process.env);
      expect(status).toBe(0);
      expect(parentTimerRan).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it('refuses an absent daemon before allowing a client to start one implicitly', async () => {
    const root = fs.mkdtempSync('/tmp/app-daemon-test-');
    try { await expect(requireNoMistakesDaemon(root)).rejects.toThrow('foreground daemon'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a live isolated IPC endpoint without starting or modifying a service', async () => {
    const root = fs.mkdtempSync('/tmp/app-daemon-test-');
    const server = net.createServer(socket => socket.end());
    try {
      await new Promise<void>(resolve => server.listen(path.join(root, 'socket'), resolve));
      await expect(requireNoMistakesDaemon(root)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the real CLI refuses axi with a missing daemon before reading configuration or key material', () => {
    const root = fs.mkdtempSync('/tmp/app-daemon-test-');
    try {
      const result = spawnSync(process.execPath, [path.resolve('bin/github-app-session.ts'),
        path.join(root, 'config.json'), '--', 'no-mistakes', 'axi'], {
        env: { ...process.env, NM_HOME: path.join(root, 'no-mistakes') }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('foreground daemon before using axi');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('the real CLI fails closed when an installed build has not been checked for compatible startup', async () => {
    const root = fs.mkdtempSync('/tmp/app-daemon-test-');
    const nmHome = path.join(root, 'no-mistakes');
    const executable = path.join(root, 'bin', 'no-mistakes');
    fs.mkdirSync(nmHome);
    fs.mkdirSync(path.dirname(executable));
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "no-mistakes version v99.0.0\\n"\n', { mode: 0o700 });
    const server = net.createServer(socket => socket.end());
    try {
      await new Promise<void>(resolve => server.listen(path.join(nmHome, 'socket'), resolve));
      const result = spawnSync(process.execPath, [path.resolve('bin/github-app-session.ts'),
        path.join(root, 'config.json'), '--', executable, 'axi'], {
        env: { ...process.env, NM_HOME: nmHome }, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Review no-mistakes startup compatibility');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('replaces inherited personal credentials and Git tracing without changing the source environment', () => {
    const original = { GH_TOKEN: 'personal-token', GITHUB_TOKEN: 'personal-token', GH_DEBUG: 'api',
      GH_ENTERPRISE_TOKEN: 'personal-enterprise', GIT_CONFIG_PARAMETERS: 'personal-helper',
      GIT_TRACE_CURL: '1', GIT_ASKPASS: '/personal/helper', GIT_AUTHOR_NAME: 'Personal User', PATH: '/usr/bin:/bin' };
    const env = appEnvironment(original, config, 'app-token', '/private/config');
    expect(env.GH_TOKEN).toBe('app-token');
    expect(env.GITHUB_TOKEN).toBe('app-token');
    expect(env.GH_CONFIG_DIR).toBe('/private/config');
    expect(env.GIT_AUTHOR_NAME).toBe('example-app[bot]');
    expect(env.GIT_COMMITTER_EMAIL).toBe('12345+example-app[bot]@users.noreply.github.com');
    for (const name of ['GH_DEBUG', 'GH_ENTERPRISE_TOKEN', 'GIT_CONFIG_PARAMETERS', 'GIT_TRACE_CURL', 'GIT_ASKPASS']) expect(env[name]).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(original.GH_TOKEN).toBe('personal-token');
  });

  it('the actual credential helper only releases the App token for the configured HTTPS repository', () => {
    const env = appEnvironment({ PATH: '/usr/bin:/bin' }, config, 'app-token', '/private/config');
    const helper = env.GIT_CONFIG_VALUE_1!.slice(1);
    function credential(protocol: string, host: string, repo: string) {
      return spawnSync('/bin/sh', ['-c', `${helper} get`], { env, encoding: 'utf8',
        input: `protocol=${protocol}\nhost=${host}\npath=${repo}\n\n` }).stdout;
    }
    expect(credential('https', 'github.com', 'example/private-repo.git')).toContain('password=app-token');
    expect(credential('https', 'github.com', 'example/other-private-repo.git')).toBe('');
    expect(credential('https', 'other.example.com', 'example/private-repo.git')).toBe('');
    expect(credential('http', 'github.com', 'example/private-repo.git')).toBe('');
  });

  it('rejects path traversal and invalid identifiers in non-secret configuration', () => {
    expect(parseAppConfig(config)).toEqual(config);
    expect(() => parseAppConfig({ ...config, repository: '../other' })).toThrow();
    expect(() => parseAppConfig({ ...config, repositoryId: -1 })).toThrow();
  });

  it.each([
    { home: '/unrelated/shared-daemon', args: ['daemon', 'run'] },
    { home: '/tmp/app-config/no-mistakes', args: ['daemon', 'run', '--root', '/unrelated/shared-daemon'] },
    { home: '/tmp/app-config/no-mistakes', args: ['daemon', 'restart'] },
  ])('rejects unsafe no-mistakes routing through the real CLI before requesting credentials', ({ home, args }) => {
    const result = spawnSync(process.execPath, [path.resolve('bin/github-app-session.ts'),
      '/tmp/app-config/nonexistent-test-config.json', '--', 'no-mistakes', ...args], {
      encoding: 'utf8', env: { ...process.env, NM_HOME: home }, timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/isolated NM_HOME|managed daemon service changes/u);
  });
});
