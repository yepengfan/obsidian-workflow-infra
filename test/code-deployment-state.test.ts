import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployedCode, requireCurrentMain } from '../bin/code-deployment-state.js';

const input = { account: '123456789012', region: 'ap-southeast-2', codeBucketName: 'private-code-only', functionName: 'obsidian-mcp-server' };
const key = `releases/${'a'.repeat(64)}.zip`, sha = 'b'.repeat(40);
let directory: string;
let fixture: { stack: object; template: { Resources: Record<string, { Properties: Record<string, unknown> }> }; fn: object | null; missingError?: string };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-state-test-'));
  fs.mkdirSync(path.join(directory, 'config'));
  for (const name of ['storage', 'github']) fs.copyFileSync(`config/${name}.json`, path.join(directory, `config/${name}.json`));
  fs.symlinkSync(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
  fixture = {
    stack: { StackId: `arn:aws:cloudformation:${input.region}:${input.account}:stack/ObsidianMcp/test`, StackStatus: 'UPDATE_COMPLETE', LastUpdatedTime: '2026-11-14T00:00:00Z' },
    template: { Resources: { CodeArtifacts: { Properties: { BucketName: input.codeBucketName } } } }, fn: null,
  };
  const aws = `#!${process.execPath}\nconst fs=require('node:fs'); const f=JSON.parse(fs.readFileSync(process.env.STATE_FIXTURE)); const a=process.argv.slice(2); fs.appendFileSync(process.env.STATE_CALLS, JSON.stringify(a)+'\\n');
if(a[0]==='cloudformation'&&a[1]==='describe-stacks') console.log(JSON.stringify(f.stack));
else if(a[0]==='cloudformation'&&a[1]==='get-template') console.log(JSON.stringify(f.template));
else if(a[0]==='sts'&&a[1]==='get-caller-identity') console.log(JSON.stringify({Account:'391824190072',Arn:'arn:aws:sts::391824190072:assumed-role/LocalSso/session'}));
else if(a[0]==='lambda'&&a[1]==='get-function-configuration') { if(f.fn) console.log(JSON.stringify(f.fn)); else { console.error(f.missingError||'(ResourceNotFoundException)'); process.exit(254); } }
else process.exit(99);\n`;
  fs.writeFileSync(path.join(directory, 'aws'), aws, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'gh'), `#!${process.execPath}\nconsole.log(process.env.STATE_MAIN_SHA);\n`, { mode: 0o700 });
  vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv('STATE_FIXTURE', path.join(directory, 'fixture.json'));
  vi.stubEnv('STATE_CALLS', path.join(directory, 'calls.jsonl'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
function read() { fs.writeFileSync(process.env.STATE_FIXTURE!, JSON.stringify(fixture)); return deployedCode(input); }
function withFunction() {
  fixture.template.Resources.McpFunction = { Properties: { FunctionName: input.functionName, Code: { S3Bucket: { Ref: 'CodeArtifacts' }, S3Key: key } } };
  fixture.fn = { state: 'Active', updated: 'Successful', hash: Buffer.from('a'.repeat(64), 'hex').toString('base64') };
}
it('observes a stable code-storage deployment with no unmanaged function', () => {
  expect(read().key).toBeNull();
  const calls = fs.readFileSync(process.env.STATE_CALLS!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(args => args.slice(0, 2))).toEqual([
    ['cloudformation', 'describe-stacks'], ['cloudformation', 'get-template'], ['lambda', 'get-function-configuration'],
  ]);
});
it('binds the native code key to actual Lambda SHA-256 and includes deployment revision', () => {
  withFunction(); const first = read(); expect(first.key).toBe(key);
  fixture.stack = { ...fixture.stack, LastUpdatedTime: '2026-11-15T00:00:00Z' };
  expect(read().revision).not.toBe(first.revision);
});
it.each(['unstable', 'wrong account', 'bucket mismatch', 'hash mismatch', 'unmanaged function', 'permission denied', 'missing function', 'wrong function', 'wrong bucket ref'])('fails closed on %s', failure => {
  withFunction();
  if (failure === 'unstable') fixture.stack = { ...fixture.stack, StackStatus: 'UPDATE_IN_PROGRESS' };
  if (failure === 'wrong account') fixture.stack = { ...fixture.stack, StackId: 'arn:aws:cloudformation:ap-southeast-2:999999999999:stack/ObsidianMcp/test' };
  if (failure === 'bucket mismatch') fixture.template.Resources.CodeArtifacts!.Properties.BucketName = 'unrelated';
  if (failure === 'hash mismatch') fixture.fn = { state: 'Active', updated: 'Successful', hash: 'changed' };
  if (failure === 'unmanaged function') delete fixture.template.Resources.McpFunction;
  if (failure === 'permission denied') { fixture.fn = null; fixture.missingError = '(AccessDeniedException)'; }
  if (failure === 'missing function') fixture.fn = null;
  if (failure === 'wrong function') fixture.template.Resources.McpFunction!.Properties.FunctionName = 'different-function';
  if (failure === 'wrong bucket ref') fixture.template.Resources.McpFunction!.Properties.Code = { S3Bucket: 'other-bucket', S3Key: key };
  expect(read).toThrow();
});
it('requires a trusted current main revision for all mutating runs', () => {
  expect(requireCurrentMain).toThrow('Trusted main');
  vi.stubEnv('GITHUB_ACTIONS', 'true'); vi.stubEnv('GITHUB_REF', 'refs/heads/main'); vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repository'); vi.stubEnv('STATE_MAIN_SHA', sha);
  expect(requireCurrentMain).not.toThrow();
  vi.stubEnv('STATE_MAIN_SHA', 'c'.repeat(40)); expect(requireCurrentMain).toThrow('Outdated');
  vi.stubEnv('GITHUB_REF', 'refs/heads/feature'); expect(requireCurrentMain).toThrow('Trusted main');
});
it('rejects local SSO apply before any S3 access', () => {
  fs.writeFileSync(process.env.STATE_FIXTURE!, JSON.stringify(fixture));
  vi.stubEnv('GITHUB_ACTIONS', 'true'); vi.stubEnv('GITHUB_REF', 'refs/heads/main'); vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('STATE_MAIN_SHA', sha); vi.stubEnv('GITHUB_REPOSITORY', 'owner/repository');
  expect(() => execFileSync(process.execPath, ['--import', 'tsx', path.resolve('bin/retain-code.ts'), '--apply'],
    { cwd: directory, env: process.env, stdio: 'pipe', timeout: 10000 })).toThrow();
  const calls = fs.readFileSync(process.env.STATE_CALLS!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(args => args.slice(0, 2))).toEqual([['sts', 'get-caller-identity']]);
});
it('executes the default CLI preview through real SDK HTTP with zero mutations', async () => {
  const requests: { method: string; url: string }[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method!, url: request.url! });
    response.setHeader('Content-Type', 'application/xml');
    response.end('<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListVersionsResult>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture listener failed');
    fixture.stack = { ...fixture.stack, StackId: 'arn:aws:cloudformation:ap-southeast-2:391824190072:stack/ObsidianMcp/test' };
    fixture.template.Resources.CodeArtifacts!.Properties.BucketName = 'obsidian-mcp-code-391824190072-ap-southeast-2';
    fs.writeFileSync(process.env.STATE_FIXTURE!, JSON.stringify(fixture));
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('bin/retain-code.ts')], {
      cwd: directory, env: { ...process.env, AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${address.port}`, AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture', AWS_SESSION_TOKEN: '',
        GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') }, timeout: 10000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, scanned: 0, deleted: 0, markedUnused: 0 });
    expect(requests).toHaveLength(1); expect(requests[0]!.method).toBe('GET');
    const url = new URL(requests[0]!.url, 'http://fixture');
    expect(url.pathname).toBe('/obsidian-mcp-code-391824190072-ap-southeast-2/');
    expect(url.searchParams.get('prefix')).toBe('releases/'); expect(url.searchParams.get('max-keys')).toBe('1000');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);
