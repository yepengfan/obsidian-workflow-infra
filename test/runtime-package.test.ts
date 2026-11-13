import type { HttpRequest } from '@smithy/types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { unzipSync } from 'fflate';
import { expect, it } from 'vitest';
import { buildRuntime, publishCode, validateCode } from '../bin/runtime-package.js';

it('builds byte-identical ZIPs for identical runtime code and executes the emitted Lambda handler', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-code-test-'));
  const saved = { ...process.env };
  try {
    process.env.TZ = 'UTC';
    const first = await buildRuntime(path.join(directory, 'one'), 'a'.repeat(40));
    process.env.TZ = 'Australia/Brisbane';
    const second = await buildRuntime(path.join(directory, 'two'), 'b'.repeat(40));
    const zip = await fs.readFile(path.join(directory, 'one/CodeBundle.zip'));
    expect(zip.equals(await fs.readFile(path.join(directory, 'two/CodeBundle.zip')))).toBe(true);
    expect(first.sha256).toBe(second.sha256); expect(first.bytes).toBe(zip.length);
    validateCode(first, zip, 'a'.repeat(40));
    expect(() => validateCode(first, zip, 'b'.repeat(40))).toThrow();
    const files = unzipSync(zip); expect(Object.keys(files)).toEqual(['index.mjs']);
    const file = path.join(directory, 'index.mjs'); await fs.writeFile(file, files['index.mjs']!);
    process.env.AWS_REGION = 'ap-southeast-2'; process.env.NOTE_BUCKET = 'private-test-vault'; process.env.NOTE_PREFIX = '';
    process.env.OAUTH_ISSUER = 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Test'; process.env.OAUTH_CLIENT_ID = 'test-client';
    process.env.MCP_RESOURCE = 'https://example.execute-api.ap-southeast-2.amazonaws.com/mcp'; process.env.OAUTH_SCOPE = 'obsidian.notes/read'; process.env.MCP_OPTIONS = '{}';
    const emitted = await import(pathToFileURL(file).href);
    const result = await emitted.handler({ rawPath: '/.well-known/oauth-protected-resource/mcp', headers: {}, requestContext: { http: { method: 'GET' } } }, { awsRequestId: 'fixture-request' });
    expect(result.statusCode).toBe(200); expect(JSON.parse(result.body).resource).toBe(process.env.MCP_RESOURCE);
  } finally { process.env = saved; await fs.rm(directory, { recursive: true, force: true }); }
}, 30000);
it.each(['new', 'exists', 'conflict', 'wrong checksum', 'wrong artifact'] as const)('publishes immutable code with verified checksum: %s', async mode => {
  const bytes = Buffer.from('zip-fixture'); const sha = createHash('sha256').update(bytes).digest();
  const metadata = { schemaVersion: 1 as const, sourceSha: 'a'.repeat(40), bytes: bytes.length, sha256: sha.toString('hex'), sha256Base64: sha.toString('base64'), key: `releases/${sha.toString('hex')}.zip` };
  const calls: { method: string; headers: Record<string, string> }[] = [];
  const client = new S3Client({ region: 'ap-southeast-2', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
    requestHandler: { handle: async (request: HttpRequest) => {
      calls.push({ method: request.method, headers: request.headers });
      if (request.method === 'PUT' && mode !== 'new') return { response: { statusCode: mode === 'conflict' ? 409 : 412, headers: {}, body: Readable.from(['<Error><Code>PreconditionFailed</Code></Error>']) } };
      return { response: { statusCode: 200, headers: { 'content-length': String(bytes.length), 'x-amz-server-side-encryption': 'AES256', 'x-amz-checksum-sha256': mode === 'wrong checksum' ? 'bad' : metadata.sha256Base64 }, body: Readable.from([]) } };
    } },
  });
  try {
    const operation = publishCode(client, 'private-code-only', metadata, mode === 'wrong artifact' ? Buffer.from('changed') : bytes, metadata.sourceSha);
    if (mode === 'new' || mode === 'exists') await operation; else await expect(operation).rejects.toThrow();
    if (mode === 'wrong artifact') expect(calls).toHaveLength(0);
    else {
      expect(calls[0]).toMatchObject({ method: 'PUT', headers: { 'if-none-match': '*', 'x-amz-server-side-encryption': 'AES256', 'x-amz-checksum-sha256': metadata.sha256Base64 } });
      expect(calls.map(call => call.method)).toEqual(mode === 'conflict' ? ['PUT'] : ['PUT', 'HEAD']);
    }
  } finally { client.destroy(); }
});
