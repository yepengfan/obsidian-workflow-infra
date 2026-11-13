// Run with Node 22.18+ native TypeScript support. Only built-in modules are used
// while the private key is present. Automic Vault supplies FD 3 by default,
// or an explicitly named environment variable authorized by Direct Access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

class AppSessionError extends Error {}

export type AppConfig = {
  clientId: string; appId: number; installationId: number;
  owner: string; repository: string; repositoryId: number;
  botLogin: string; botUserId: number;
};
type Installation = { id: number; app_id: number; account?: { login: string }; suspended_at: unknown; permissions: Record<string, string>; repository_selection: string };
type Token = { token: string; expires_at: string; permissions: Record<string, string> };

export function consumeAppKeyEnvironment(name: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (!/^GITHUB_APP_[A-Z0-9_]+_PRIVATE_KEY$/u.test(name)) throw new AppSessionError('Use a dedicated GITHUB_APP_*_PRIVATE_KEY Secret');
  const value = env[name];
  // Remove before any subprocess, including validation/version commands.
  delete env[name];
  if (!value) throw new AppSessionError('The requested App key environment variable is missing or empty');
  return Buffer.from(value, 'utf8');
}

export function runAppCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    // Keep the parent event loop responsive for HTTP connection cleanup and
    // lease timers while a foreground daemon or a validation command runs.
    const child = spawn(command, args, { env, stdio: 'inherit', timeout: 45 * 60_000 });
    child.once('error', () => reject(new AppSessionError('Cannot start the child command')));
    child.once('exit', (status, signal) => {
      if (signal) reject(new AppSessionError('Command stopped or exceeded the 45-minute session limit'));
      else resolve(status ?? 1);
    });
  });
}

export function requireNoMistakesDaemon(root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(root, 'socket'));
    const fail = () => { socket.destroy(); reject(new AppSessionError('Start the isolated App-authenticated foreground daemon before using axi')); };
    socket.setTimeout(2_000, fail);
    socket.once('error', fail);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

export function parseAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== 'object') throw new AppSessionError('Invalid App configuration');
  const c = value as AppConfig;
  for (const k of ['appId', 'installationId', 'repositoryId', 'botUserId'] as const) {
    if (!Number.isSafeInteger(c[k]) || c[k] <= 0) throw new AppSessionError(`Invalid ${k}`);
  }
  for (const k of ['owner', 'repository'] as const) {
    if (typeof c[k] !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(c[k]) || ['.', '..'].includes(c[k])) throw new AppSessionError(`Invalid ${k}`);
  }
  if (typeof c.clientId !== 'string' || !/^Iv[0-9A-Za-z]+$/u.test(c.clientId)
    || typeof c.botLogin !== 'string' || !/^[a-z0-9-]+\[bot\]$/u.test(c.botLogin)) throw new AppSessionError('Invalid App identity');
  return c;
}

export async function openAppSession(pem: Buffer, config: AppConfig, request: typeof fetch = fetch) {
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(pem); }
  finally { pem.fill(0); }
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: config.clientId })}`;
  const jwt = `${payload}.${crypto.sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
  async function api(route: string, bearer: string, method = 'GET', body?: unknown) {
    const response = await request(`https://api.github.com${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'github-app-session',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Do not include response bodies or authentication material in errors.
    if (!response.ok) throw new AppSessionError(`GitHub ${method} ${route}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  const app = await api('/app', jwt) as { id: number; slug: string; owner?: { login: string }; permissions?: Record<string, string> };
  if (app.id !== config.appId || app.owner?.login !== config.owner || `${app.slug}[bot]` !== config.botLogin) throw new AppSessionError('App identity mismatch');
  const installation = await api(`/repos/${config.owner}/${config.repository}/installation`, jwt) as Installation;
  if (installation.id !== config.installationId || installation.app_id !== config.appId
    || installation.account?.login !== config.owner || installation.suspended_at !== null) throw new AppSessionError('Installation mismatch or suspended');
  // Explicitly narrow both repository and permission scope, even if the App is
  // installed on every repository. Additional permissions need a code review.
  const permissions: Record<string, string> = { contents: 'write', pull_requests: 'write', metadata: 'read' };
  for (const name of ['workflows', 'actions', 'checks', 'statuses']) {
    if (installation.permissions[name]) permissions[name] = name === 'workflows' ? 'write' : 'read';
  }
  const token = await api(`/app/installations/${config.installationId}/access_tokens`, jwt, 'POST', {
    repository_ids: [config.repositoryId], permissions,
  }) as Token;
  if (typeof token.token !== 'string' || !token.token) throw new AppSessionError('GitHub did not return an installation token');
  const revoke = () => api('/installation/token', token.token, 'DELETE');
  try {
    const expires = Date.parse(token.expires_at);
    if (!Number.isFinite(expires) || expires < Date.now() + 5 * 60_000 || expires > Date.now() + 65 * 60_000) throw new AppSessionError('Unexpected token lifetime');
    for (const [name, level] of Object.entries(token.permissions ?? {})) {
      if (!(name in permissions) || (level === 'write' && permissions[name] !== 'write')) throw new AppSessionError('Unexpected token permissions');
    }
    for (const [name, level] of Object.entries(permissions)) {
      if (token.permissions?.[name] !== level) throw new AppSessionError('Requested token permissions were not granted');
    }
    const scope = await api('/installation/repositories?per_page=100', token.token) as {
      total_count: number; repositories: { id: number; full_name: string }[];
    };
    if (scope.total_count !== 1 || scope.repositories.length !== 1
      || scope.repositories[0]?.id !== config.repositoryId
      || scope.repositories[0]?.full_name !== `${config.owner}/${config.repository}`) throw new AppSessionError('Token repository scope mismatch');
    return { token: token.token, expiresAt: token.expires_at, permissions: token.permissions,
      installationSelection: installation.repository_selection,
      appPermissions: app.permissions, installationPermissions: installation.permissions, revoke };
  } catch (error) {
    await revoke();
    throw error;
  }
}

// This is an authentication adapter for trusted commands, not an execution
// sandbox. The child receives a repository-scoped token, never the App PEM.
export function appEnvironment(base: NodeJS.ProcessEnv, config: AppConfig, token: string, configDir: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (/^(?:GH_|GITHUB_|GIT_CONFIG|GIT_TRACE|GIT_CURL_VERBOSE)/u.test(name)
      || ['BASH_ENV', 'ENV', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND'].includes(name)) delete env[name];
  }
  const helper = '!f() { [ "$1" = get ] || exit 0; protocol=; host=; path=; while IFS= read -r line && [ -n "$line" ]; do case "$line" in protocol=*) protocol=${line#protocol=};; host=*) host=${line#host=};; path=*) path=${line#path=};; esac; done; [ "$protocol" = https ] && [ "$host" = github.com ] || exit 0; [ "$path" = "$GITHUB_APP_REPOSITORY" ] || [ "$path" = "$GITHUB_APP_REPOSITORY.git" ] || exit 0; printf "username=x-access-token\\npassword=%s\\n\\n" "$GH_TOKEN"; }; f';
  const email = `${config.botUserId}+${config.botLogin}@users.noreply.github.com`;
  Object.assign(env, {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${base.PATH ?? ''}`,
    GH_TOKEN: token, GITHUB_TOKEN: token, GH_HOST: 'github.com', GH_REPO: `${config.owner}/${config.repository}`,
    GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: '1',
    GITHUB_APP_REPOSITORY: `${config.owner}/${config.repository}`,
    GIT_AUTHOR_NAME: config.botLogin, GIT_COMMITTER_NAME: config.botLogin,
    GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: helper,
    GIT_CONFIG_KEY_2: 'credential.useHttpPath', GIT_CONFIG_VALUE_2: 'true',
    GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: '/usr/bin/false', GIT_ALLOW_PROTOCOL: 'https:file',
  });
  return env;
}

async function main() {
  const argv = process.argv.slice(2);
  let environmentPem: Buffer | undefined;
  if (argv[0] === '--key-env') {
    argv.shift();
    environmentPem = consumeAppKeyEnvironment(argv.shift() ?? '');
  }
  const [configPath, mode, ...args] = argv;
  if (!configPath || (mode !== '--check' && mode !== '--') || (mode === '--' && args.length === 0)) throw new AppSessionError('Usage: node bin/github-app-session.ts [--key-env GITHUB_APP_NAME_PRIVATE_KEY] CONFIG.json --check | -- git/gh/gh-axi/no-mistakes ARGS');
  if (mode === '--' && !['git', 'gh', 'gh-axi', 'no-mistakes'].includes(path.basename(args[0]!))) throw new AppSessionError('Only Git, GitHub CLI and an isolated no-mistakes instance are supported');
  const noMistakes = mode === '--' && path.basename(args[0]!) === 'no-mistakes';
  if (noMistakes) {
    const isolatedRoot = path.resolve(path.dirname(configPath), 'no-mistakes');
    if (process.env.NM_HOME !== isolatedRoot || args.includes('--root') || args.some(a => a.startsWith('--root='))) throw new AppSessionError('no-mistakes must use the isolated NM_HOME beside the App configuration');
    if (!['init', 'axi'].includes(args[1] ?? '') && !(args[1] === 'daemon' && args[2] === 'run')) throw new AppSessionError('Use the isolated foreground daemon, init or axi; managed daemon service changes are not supported');
    if (args[1] === 'axi') await requireNoMistakesDaemon(isolatedRoot);
    const version = spawnSync(args[0]!, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (version.status !== 0 || !/\bg7a0fdc7\b/u.test(version.stdout)) throw new AppSessionError('Review no-mistakes startup compatibility before using a build other than g7a0fdc7');
  }
  const config = parseAppConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const pem = environmentPem ?? fs.readFileSync(3);
  if (!environmentPem) fs.closeSync(3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-app-session-'));
  fs.chmodSync(dir, 0o700);
  let session: Awaited<ReturnType<typeof openAppSession>> | undefined;
  try {
    session = await openAppSession(pem, config);
    const env = appEnvironment(process.env, config, session.token, dir);
    const local = spawnSync('git', ['config', '--local', '--get-regexp', '^(url\\..*\\.insteadof|http(\\..*)?\\.extraheader)$'], { env, encoding: 'utf8', timeout: 10_000 });
    if (local.status !== 1) throw new AppSessionError('Local Git URL rewrites or HTTP headers must be reviewed before using this adapter');
    const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { env, encoding: 'utf8', timeout: 10_000 });
    const expected = `https://github.com/${config.owner}/${config.repository}`;
    if (origin.status !== 0 || ![expected, `${expected}.git`].includes(origin.stdout.trim())) throw new AppSessionError('Origin must be the configured repository over credential-free HTTPS');
    if (mode === '--check') {
      for (const command of [
        ['gh', 'auth', 'status'],
        ['gh-axi', 'repo', 'view', `${config.owner}/${config.repository}`],
        ['git', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=20', 'ls-remote', `https://github.com/${config.owner}/${config.repository}.git`, 'HEAD'],
      ]) {
        const result = spawnSync(command[0]!, command.slice(1), { env, encoding: 'utf8', timeout: 60_000 });
        if (result.error && 'code' in result.error && result.error.code === 'ENOENT') throw new AppSessionError(`${command[0]} is not available on PATH`);
        if (result.status !== 0) throw new AppSessionError(`${command[0]} authenticated read failed; no personal-account fallback was used`);
        console.log(`${command[0]}: authenticated read passed`);
      }
      console.log(JSON.stringify({ appId: config.appId, installationId: config.installationId,
        repository: `${config.owner}/${config.repository}`, installationSelection: session.installationSelection,
        appPermissions: session.appPermissions, installationPermissions: session.installationPermissions,
        tokenExpiresAt: session.expiresAt, tokenPermissions: session.permissions,
        author: config.botLogin, personalFallback: false }, null, 2));
    } else {
      if (noMistakes) {
        // The installed no-mistakes version documents this as its direct-start
        // production escape hatch. If the daemon disappears after the socket
        // check, never let its implicit restart install a managed service that
        // drops the App token, gh config isolation and bot Git identity.
        env.NM_TEST_START_DAEMON = '1';
        const auth = spawnSync('gh', ['auth', 'status'], { env, encoding: 'utf8', timeout: 30_000 });
        if (auth.status !== 0) throw new AppSessionError('gh auth status could not validate the App session for no-mistakes');
      }
      process.exitCode = await runAppCommand(args[0]!, args.slice(1), env);
    }
  } finally {
    try {
      if (session) { await session.revoke(); console.error('GitHub App installation token revoked.'); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof AppSessionError ? error.message : `GitHub App session failed before completion (${error instanceof Error ? error.name : 'unknown error'}).`);
    console.error('No personal-account fallback was used.'); process.exitCode = 1;
  });
}
