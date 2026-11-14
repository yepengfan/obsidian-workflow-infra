import { DeleteObjectCommand, GetObjectTaggingCommand, ListObjectVersionsCommand, PutObjectTaggingCommand, type S3Client, type Tag } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { protectRelease, protectionTags, releaseRollback, retainCode, type DeploymentState } from '../src/artifact-retention.js';

const now = new Date('2026-11-14T00:00:00Z'), day = 86400000;
const age = (days: number) => new Date(now.getTime() - days * day);
const key = (letter: string) => `releases/${letter.repeat(64)}.zip`;
const tags = (prior: string | null = null, unused?: Date) => ({ ...protectionTags(prior), ...(unused ? { 'obsidian-unused-since': unused.toISOString() } : {}) });
const policy = { unusedCodeDays: 90, maxCodeVersionsPerRun: 100, maxCodeChangesPerRun: 20 };
type Row = { Key: string; VersionId: string; LastModified: Date; Size: number; tags: Record<string, string> };
const row = (letter: string, values: Record<string, string> = tags(), version = letter) => ({ Key: key(letter), VersionId: version, LastModified: age(400), Size: 123, tags: { ...values } });
function store(rows: Row[], options: { pages?: object[]; tagError?: string; deleteError?: boolean } = {}) {
  const writes: { kind: string; key: string; version: string }[] = [];
  const listings: object[] = [];
  let page = 0;
  const client = { send: async (command: unknown) => {
    if (command instanceof ListObjectVersionsCommand) {
      expect(command.input).toMatchObject({ Bucket: 'code-only', Prefix: 'releases/', MaxKeys: 1000 });
      listings.push(command.input);
      return options.pages?.[page++] ?? { Versions: rows.map(value => ({ Key: value.Key, VersionId: value.VersionId, LastModified: value.LastModified, Size: value.Size })), IsTruncated: false };
    }
    if (command instanceof GetObjectTaggingCommand || command instanceof PutObjectTaggingCommand || command instanceof DeleteObjectCommand) {
      const input = command.input;
      expect(input.Bucket).toBe('code-only');
      const value = rows.find(r => r.Key === input.Key && (!input.VersionId || r.VersionId === input.VersionId));
      if (!value || options.tagError === input.Key) throw Error('Fixture metadata unavailable');
      if (command instanceof GetObjectTaggingCommand) return { VersionId: value.VersionId, TagSet: Object.entries(value.tags).map(([Key, Value]) => ({ Key, Value })) };
      expect(input.VersionId).toBeTruthy();
      if (command instanceof PutObjectTaggingCommand) {
        value.tags = Object.fromEntries((command.input.Tagging?.TagSet ?? []).map((t: Tag) => [t.Key!, t.Value!]));
        writes.push({ kind: 'tag', key: value.Key, version: value.VersionId }); return {};
      }
      if (options.deleteError) throw Error('Fixture delete denied');
      writes.push({ kind: 'delete', key: value.Key, version: value.VersionId }); rows.splice(rows.indexOf(value), 1); return {};
    }
    throw Error('Unexpected AWS operation');
  } } as unknown as S3Client;
  return { client, rows, writes, listings };
}
const state = (value: string | null = key('a')) => async (): Promise<DeploymentState> => ({ key: value, revision: 'stable' });

describe('bounded code-only retention', () => {
  it('protects deployed and rollback keys, including all their versions, and expires only unused managed versions', async () => {
    const data = store([row('a', tags(key('b'))), row('a', tags(null, age(200)), 'a-old'), row('b'), row('c', tags(null, age(91))), row('d', tags(null, age(89))), row('e', {}), row('f')]);
    const result = await retainCode(data.client, state(), { bucket: 'code-only', policy, apply: true, now });
    expect(result).toMatchObject({ protectedVersions: 3, deleted: 1, markedUnused: 1, unmanagedVersions: 1, wouldDeleteBytes: 123 });
    expect(data.writes).toEqual([{ kind: 'delete', key: key('c'), version: 'c' }, { kind: 'tag', key: key('f'), version: 'f' }]);
    expect(data.rows.find(r => r.Key === key('f'))!.tags['obsidian-unused-since']).toBe(now.toISOString());
  });
  it('starts the 90-day window when observed unused rather than at upload', async () => {
    const data = store([row('c')]);
    await retainCode(data.client, state(null), { bucket: 'code-only', policy, apply: true, now });
    expect(data.rows).toHaveLength(1);
    const later = new Date(now.getTime() + 90 * day);
    await retainCode(data.client, state(null), { bucket: 'code-only', policy, apply: true, now: later });
    expect(data.rows).toHaveLength(0);
  });
  it('performs no writes in dry-run, including unused marking', async () => {
    const data = store([row('c', tags(null, age(91))), row('d')]);
    const result = await retainCode(data.client, state(null), { bucket: 'code-only', policy, apply: false, now });
    expect(result).toMatchObject({ dryRun: true, wouldDelete: 1, wouldMarkUnused: 1, deleted: 0, markedUnused: 0 });
    expect(data.writes).toEqual([]);
  });
  it('preserves rollback on a same-code deployment and resets unused age on reactivation', async () => {
    const data = store([row('a', tags(key('b'))), row('b'), row('c', tags(null, age(200)))]);
    expect(await releaseRollback(data.client, 'code-only', key('a'), key('a'))).toBe(key('b'));
    const prior = await releaseRollback(data.client, 'code-only', key('c'), key('a'));
    expect(prior).toBe(key('a'));
    await protectRelease(data.client, 'code-only', key('c'), prior, 'c');
    expect(data.rows.find(r => r.Key === key('c'))!.tags).toEqual(tags(key('a')));
    data.writes.length = 0;
    const result = await retainCode(data.client, state(key('c')), { bucket: 'code-only', policy, apply: true, now });
    expect(result.protectedVersions).toBe(2); expect(result.deleted).toBe(0);
    expect(data.writes).toEqual([{ kind: 'tag', key: key('b'), version: 'b' }]);
  });
  it('paginates version IDs and reports delete markers without deleting them', async () => {
    const c = row('c', tags(null, age(91))), d = row('d');
    const data = store([c, d], { pages: [
      { Versions: [c], IsTruncated: true, NextKeyMarker: c.Key, NextVersionIdMarker: c.VersionId },
      { Versions: [d], DeleteMarkers: [{ Key: key('e'), VersionId: 'marker' }], IsTruncated: false },
    ] });
    const result = await retainCode(data.client, state(null), { bucket: 'code-only', policy, apply: true, now });
    expect(result.deleteMarkers).toBe(1);
    expect(data.listings[1]).toMatchObject({ KeyMarker: c.Key, VersionIdMarker: c.VersionId });
    expect(data.writes.some(w => w.version === 'marker')).toBe(false);
  });
  it.each(['missing protection', 'missing rollback', 'tag read', 'bad timestamp', 'scan overflow', 'cursor', 'duplicate'])('fails closed before writes: %s', async failure => {
    const a = row('a', failure === 'missing protection' ? {} : tags(key('b'))), b = row('b'), c = row('c', tags(null, age(91)));
    if (failure === 'bad timestamp') c.tags['obsidian-unused-since'] = 'yesterday';
    const data = store(failure === 'missing rollback' ? [a, c] : [a, b, c], {
      ...(failure === 'tag read' ? { tagError: c.Key } : {}),
      ...(failure === 'cursor' ? { pages: [{ Versions: [c], IsTruncated: true, NextKeyMarker: c.Key }] } : {}),
      ...(failure === 'duplicate' ? { pages: [{ Versions: [c, c], IsTruncated: false }] } : {}),
    });
    await expect(retainCode(data.client, state(), { bucket: 'code-only', policy: { ...policy, maxCodeVersionsPerRun: failure === 'scan overflow' ? 1 : 100 }, apply: true, now })).rejects.toThrow();
    expect(data.writes).toEqual([]);
  });
  it('rechecks deployment state before each write and reports completed operations', async () => {
    const data = store([row('c', tags(null, age(91))), row('d', tags(null, age(92)))]);
    let calls = 0; const receipts: number[] = [];
    await expect(retainCode(data.client, async () => ({ key: null, revision: ++calls < 3 ? 'stable' : 'changed' }),
      { bucket: 'code-only', policy, apply: true, now, report: r => receipts.push(r.deleted) })).rejects.toThrow('Deployment changed');
    expect(data.writes).toHaveLength(1); expect(receipts).toEqual([0, 1]);
  });
  it('bounds writes and prioritizes expired versions over new unused markers', async () => {
    const data = store([row('c'), row('d', tags(null, age(91)))]);
    const result = await retainCode(data.client, state(null), { bucket: 'code-only', policy: { ...policy, maxCodeChangesPerRun: 1 }, apply: true, now });
    expect(result).toMatchObject({ deleted: 1, markedUnused: 0, pendingChanges: 1 });
    expect(data.writes[0]!.key).toBe(key('d'));
  });
});
