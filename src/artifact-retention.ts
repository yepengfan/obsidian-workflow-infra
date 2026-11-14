import { GetObjectTaggingCommand, PutObjectTaggingCommand, ListObjectVersionsCommand, DeleteObjectCommand, type S3Client, type Tag } from '@aws-sdk/client-s3';
import { z } from 'zod';

export const releaseKey = z.string().regex(/^releases\/[a-f0-9]{64}\.zip$/u);
const schemaTag = 'obsidian-retention-schema';
const rollbackTag = 'obsidian-rollback-key';
const unusedTag = 'obsidian-unused-since';
const day = 86_400_000;
export type DeploymentState = { revision: string; key: string | null };
type Policy = { unusedCodeDays: number; maxCodeVersionsPerRun: number; maxCodeChangesPerRun: number };
type Version = { Key: string; VersionId: string; LastModified: Date; Size: number };
const newReceipt = (apply: boolean) => ({ dryRun: !apply, scanned: 0, protectedVersions: 0, unmanagedVersions: 0, deleteMarkers: 0,
  wouldMarkUnused: 0, wouldDelete: 0, wouldDeleteBytes: 0, markedUnused: 0, deleted: 0, pendingChanges: 0 });
export type RetentionReceipt = ReturnType<typeof newReceipt>;
type Options = { bucket: string; policy: Policy; apply: boolean; now?: Date; timeoutMs?: number; report?: (receipt: RetentionReceipt) => void };

function tagsMap(tags: Tag[] | undefined) {
  const result = new Map<string, string>();
  for (const tag of tags ?? []) {
    if (!tag.Key || tag.Value === undefined || result.has(tag.Key)) throw Error('Invalid release tags');
    result.set(tag.Key, tag.Value);
  }
  return result;
}
function serialize(tags: Map<string, string>): Tag[] {
  if (tags.size > 10) throw Error('Release tag limit exceeded');
  return [...tags].map(([Key, Value]) => ({ Key, Value }));
}
async function readTags(client: S3Client, bucket: string, key: string, version: string | undefined, signal: AbortSignal) {
  return tagsMap((await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: releaseKey.parse(key), VersionId: version }), { abortSignal: signal })).TagSet);
}
function rollback(tags: Map<string, string>): string | null {
  if (tags.get(schemaTag) !== '1' || !tags.has(rollbackTag)) throw Error('Release protection metadata is missing');
  return tags.get(rollbackTag) === 'none' ? null : releaseKey.parse(tags.get(rollbackTag));
}

/** Executed under the same repository-wide mutex as cleanup, before native Apply. */
export async function releaseRollback(client: S3Client, bucket: string, target: string, current: string | null) {
  releaseKey.parse(target);
  const signal = AbortSignal.timeout(15_000);
  const previous = current === null ? null : rollback(await readTags(client, bucket, current, undefined, signal));
  const nextRollback = current !== target ? current : previous;
  if (nextRollback === target) throw Error('Invalid rollback reference');
  return nextRollback;
}
export function protectionTags(previous: string | null) {
  return { [schemaTag]: '1', [rollbackTag]: previous === null ? 'none' : releaseKey.parse(previous) };
}
export async function protectRelease(client: S3Client, bucket: string, target: string, previous: string | null, version: string) {
  releaseKey.parse(target);
  if (!version || previous === target) throw Error('Invalid release protection');
  const signal = AbortSignal.timeout(15_000);
  const tags = await readTags(client, bucket, target, version, signal);
  for (const [key, value] of Object.entries(protectionTags(previous))) tags.set(key, value);
  tags.delete(unusedTag);
  await client.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: target, VersionId: version, Tagging: { TagSet: serialize(tags) } }), { abortSignal: signal });
}

/** No note access. Whole-run scan/operation bounds and explicit version IDs. */
export async function retainCode(client: S3Client, state: () => Promise<DeploymentState>, options: Options) {
  const { bucket, policy, apply } = options;
  if (!Number.isInteger(policy.unusedCodeDays) || policy.unusedCodeDays < 1 || policy.unusedCodeDays > 3650 ||
      !Number.isInteger(policy.maxCodeVersionsPerRun) || policy.maxCodeVersionsPerRun < 1 || policy.maxCodeVersionsPerRun > 10000 ||
      !Number.isInteger(policy.maxCodeChangesPerRun) || policy.maxCodeChangesPerRun < 1 || policy.maxCodeChangesPerRun > 2000) throw Error('Invalid retention budget');
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw Error('Invalid retention clock');
  const signal = AbortSignal.timeout(options.timeoutMs ?? 240_000);
  const initial = await state();
  const protectedKeys = new Set<string>();
  if (initial.key !== null) {
    protectedKeys.add(releaseKey.parse(initial.key));
    const prior = rollback(await readTags(client, bucket, initial.key, undefined, signal));
    if (prior === initial.key) throw Error('Invalid rollback reference');
    if (prior) {
      // Fail closed if rollback metadata cannot be read, including a missing object.
      if (rollback(await readTags(client, bucket, prior, undefined, signal)) === prior) throw Error('Invalid rollback reference');
      protectedKeys.add(prior);
    }
  }
  const receipt = newReceipt(apply);
  const versions: Version[] = [];
  let keyMarker: string | undefined, versionMarker: string | undefined;
  const cursors = new Set<string>();
  // Complete the bounded listing before any mutation; overflow fails closed.
  for (;;) {
    signal.throwIfAborted();
    const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: 'releases/', MaxKeys: 1000,
      KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: signal });
    receipt.scanned += (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
    receipt.deleteMarkers += page.DeleteMarkers?.length ?? 0;
    if (receipt.scanned > policy.maxCodeVersionsPerRun) throw Error('Code-version scan limit exceeded');
    for (const value of page.Versions ?? []) {
      if (!value.Key || !releaseKey.safeParse(value.Key).success) { receipt.unmanagedVersions++; continue; }
      if (!value.VersionId || !value.LastModified || !Number.isFinite(value.LastModified.getTime()) || value.LastModified > now ||
          !Number.isSafeInteger(value.Size) || value.Size! < 0) throw Error('Invalid code-version metadata');
      versions.push(value as Version);
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker || !page.NextVersionIdMarker) throw Error('Missing code-version cursor');
    const cursor = JSON.stringify([page.NextKeyMarker, page.NextVersionIdMarker]);
    if (cursors.has(cursor) || cursors.size >= 100) throw Error('Invalid code-version cursor');
    cursors.add(cursor); keyMarker = page.NextKeyMarker; versionMarker = page.NextVersionIdMarker;
  }
  const operations: { version: Version; tags: Map<string, string>; kind: 'mark' | 'delete' }[] = [];
  const seen = new Set<string>();
  // Validate tags for all candidates before mutation. At most four concurrent reads.
  for (let offset = 0; offset < versions.length; offset += 4) {
    const group = await Promise.all(versions.slice(offset, offset + 4).map(async version => {
      const id = JSON.stringify([version.Key, version.VersionId]);
      if (seen.has(id)) throw Error('Repeated code version'); seen.add(id);
      if (protectedKeys.has(version.Key)) { receipt.protectedVersions++; return null; }
      const tags = await readTags(client, bucket, version.Key, version.VersionId, signal);
      if (tags.get(schemaTag) !== '1') { receipt.unmanagedVersions++; return null; }
      if (version.Size < 1 || version.Size > 8 * 1024 * 1024) throw Error('Unexpected managed artifact size');
      rollback(tags);
      const since = tags.get(unusedTag);
      if (!since) {
        tags.set(unusedTag, now.toISOString()); receipt.wouldMarkUnused++;
        return { version, tags, kind: 'mark' as const };
      }
      const time = new Date(since).getTime();
      if (!Number.isFinite(time) || time < version.LastModified.getTime() || time > now.getTime()) throw Error('Invalid unused-release timestamp');
      if (now.getTime() - time < policy.unusedCodeDays * day) return null;
      receipt.wouldDelete++; receipt.wouldDeleteBytes += version.Size;
      return { version, tags, kind: 'delete' as const };
    }));
    operations.push(...group.filter(value => value !== null));
  }
  receipt.pendingChanges = Math.max(0, operations.length - policy.maxCodeChangesPerRun);
  operations.sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'delete' ? -1 : 1);
  options.report?.({ ...receipt });
  if (!apply) return receipt;
  for (const operation of operations.slice(0, policy.maxCodeChangesPerRun)) {
    signal.throwIfAborted();
    const live = await state();
    if (live.revision !== initial.revision || live.key !== initial.key) throw Error('Deployment changed during code retention');
    const { version } = operation;
    if (operation.kind === 'mark') {
      await client.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: version.Key, VersionId: version.VersionId,
        Tagging: { TagSet: serialize(operation.tags) } }), { abortSignal: signal }); receipt.markedUnused++;
    } else {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: version.Key, VersionId: version.VersionId }), { abortSignal: signal }); receipt.deleted++;
    }
    options.report?.({ ...receipt });
  }
  return receipt;
}
