import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

export const bundleSchema = z.strictObject({
  schemaVersion: z.literal(1), sourceSha: z.string().regex(/^(?:[a-f0-9]{40}|local)$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), sha256Base64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
  key: z.string().regex(/^releases\/[a-f0-9]{64}\.zip$/u), bytes: z.number().int().positive().max(8 * 1024 * 1024),
});
export type CodeBundle = z.infer<typeof bundleSchema>;
export async function buildRuntime(outputDirectory: string, sourceSha = 'local'): Promise<CodeBundle> {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/handler.ts', import.meta.url))], bundle: true,
    platform: 'node', target: 'node22', format: 'esm', write: false, minify: true, legalComments: 'inline',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  if (result.outputFiles.length !== 1) throw Error('Expected one runtime bundle');
  const bytes = zipSync({ 'index.mjs': [result.outputFiles[0]!.contents, { mtime: new Date(1980, 0, 1, 0, 0, 0) }] }, { level: 9 });
  const digest = createHash('sha256').update(bytes).digest();
  const metadata = bundleSchema.parse({ schemaVersion: 1, sourceSha, sha256: digest.toString('hex'), sha256Base64: digest.toString('base64'), key: `releases/${digest.toString('hex')}.zip`, bytes: bytes.length });
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, 'CodeBundle.zip'), bytes);
  await fs.writeFile(path.join(outputDirectory, 'CodeBundle.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}
export function validateCode(metadata: CodeBundle, bytes: Uint8Array, expectedSource: string) {
  const digest = createHash('sha256').update(bytes).digest();
  if (metadata.sourceSha !== expectedSource || metadata.bytes !== bytes.length || metadata.sha256 !== digest.toString('hex') ||
    metadata.sha256Base64 !== digest.toString('base64') || metadata.key !== `releases/${metadata.sha256}.zip`) throw Error('Code artifact does not match the reviewed manifest');
}
export async function publishCode(client: S3Client, bucket: string, metadata: CodeBundle, bytes: Uint8Array, expectedSource: string, tags?: Record<string, string>) {
  validateCode(bundleSchema.parse(metadata), bytes, expectedSource);
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: metadata.key, Body: bytes, IfNoneMatch: '*',
      ServerSideEncryption: 'AES256', ChecksumSHA256: metadata.sha256Base64, ContentType: 'application/zip',
      ...(tags ? { Tagging: new URLSearchParams(tags).toString() } : {}) }));
  } catch (error) {
    if (!(error instanceof Error && '$metadata' in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 412)) throw Error('Conditional code upload failed', { cause: error });
  }
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: metadata.key, ChecksumMode: 'ENABLED' }));
  if (head.ContentLength !== metadata.bytes || head.ChecksumSHA256 !== metadata.sha256Base64 || head.ServerSideEncryption !== 'AES256') throw Error('Stored code checksum differs from the reviewed artifact');
  return head;
}
