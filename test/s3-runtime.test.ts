import type { HttpRequest } from '@smithy/types';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { expect, it } from 'vitest';
import { S3NoteStore } from '../src/s3.js';

it('executes actual SDK listing serialization with delimiter, prefix and page bounds', async () => {
  const calls: unknown[] = [];
  const client = new S3Client({ region: 'ap-southeast-2', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
    requestHandler: { handle: async (request: HttpRequest) => {
      calls.push({ method: request.method, query: request.query });
      return { response: { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Readable.from([
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><CommonPrefixes><Prefix>Vault/Folder/</Prefix></CommonPrefixes><Contents><Key>Vault/hello.md</Key><Size>5</Size><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>',
      ]) } };
    } },
  });
  try {
    const result = await new S3NoteStore(client, 'private-test-vault').list('Vault/', 20, 'selected-page', AbortSignal.timeout(1000));
    expect(calls).toMatchObject([{ method: 'GET', query: { prefix: 'Vault/', delimiter: '/', 'max-keys': '20', 'continuation-token': 'selected-page' } }]);
    expect(result).toMatchObject({ folders: ['Vault/Folder/'], notes: [{ key: 'Vault/hello.md', size: 5 }], next: 'next' });
  } finally { client.destroy(); }
});
it('sends a bounded Range and If-Match and consumes only the selected object bytes', async () => {
  const calls: unknown[] = [];
  const client = new S3Client({ region: 'ap-southeast-2', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
    requestHandler: { handle: async (request: HttpRequest) => {
      calls.push({ method: request.method, path: request.path, headers: request.headers });
      return { response: { statusCode: 206, headers: { 'content-length': '3', 'content-range': 'bytes 2-4/8', etag: '"selected"' }, body: Readable.from(['abc']) } };
    } },
  });
  try {
    const result = await new S3NoteStore(client, 'private-test-vault').read('Vault/hello.md', 2, 3, '"selected"', AbortSignal.timeout(1000));
    expect(calls).toMatchObject([{ method: 'GET', path: '/Vault/hello.md', headers: { range: 'bytes=2-4', 'if-match': '"selected"' } }]);
    expect(Buffer.from(result.bytes).toString()).toBe('abc'); expect(result.total).toBe(8);
  } finally { client.destroy(); }
});
it('fails closed if the service ignores Range and sends an oversized body', async () => {
  const client = new S3Client({ region: 'ap-southeast-2', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
    requestHandler: { handle: async () => ({ response: { statusCode: 200, headers: { 'content-length': '10000', etag: '"selected"' }, body: Readable.from(['x'.repeat(10000)]) } }) },
  });
  try { await expect(new S3NoteStore(client, 'private-test-vault').read('Vault/hello.md', 0, 100, undefined, AbortSignal.timeout(1000))).rejects.toThrow('note_unavailable'); }
  finally { client.destroy(); }
});

it('serializes encrypted create, revision and explicit unconditional writes and rejects S3 conflicts without retry', async () => {
  const calls: { headers: Record<string, string> }[] = []; let status = 200;
  const client = new S3Client({ region: 'ap-southeast-2', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
    requestHandler: { handle: async (request: HttpRequest) => {
      calls.push({ headers: request.headers });
      return { response: { statusCode: status, headers: { etag: '"saved"', 'content-type': 'application/xml' },
        body: Readable.from(status === 200 ? [] : ['<Error><Code>PreconditionFailed</Code></Error>']) } };
    } },
  });
  try {
    const store = new S3NoteStore(client, 'private-test-vault');
    await store.put('Vault/Learning/Practice/Review/Items/lc-1.md', 'fixture', 'absent', AbortSignal.timeout(1000));
    await store.put('Vault/Learning/Practice/Review/Items/lc-1.md', 'updated', { revision: '"old"' }, AbortSignal.timeout(1000));
    await store.put('Vault/Journal/today.md', 'replaced', 'any', AbortSignal.timeout(1000));
    expect(calls[0]!.headers).toMatchObject({ 'if-none-match': '*', 'x-amz-server-side-encryption': 'AES256' });
    expect(calls[1]!.headers).toMatchObject({ 'if-match': '"old"', 'x-amz-server-side-encryption': 'AES256' });
    expect(calls[1]!.headers).not.toHaveProperty('if-none-match');
    expect(calls[2]!.headers).toMatchObject({ 'x-amz-server-side-encryption': 'AES256' });
    expect(calls[2]!.headers).not.toHaveProperty('if-match'); expect(calls[2]!.headers).not.toHaveProperty('if-none-match');
    status = 412;
    await expect(store.put('Vault/a.md', 'updated', { revision: '"old"' }, AbortSignal.timeout(1000))).rejects.toThrow('revision_conflict');
    expect(calls).toHaveLength(4);
  } finally { client.destroy(); }
});
