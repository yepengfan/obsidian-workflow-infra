import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { boundedBody, MAX_NOTE_BYTES, Notes, S3NotesStore } from '../src/notes.js';
import { normalizePrefix, notePath } from '../src/paths.js';
import { config, MemoryStore } from './fixtures.js';

describe('vault boundary', () => {
  it.each(['../secret.md', '/secret.md', 'x/../y.md', 'x//y.md', 'x\\y.md', '%2e%2e/secret.md', '.obsidian/config.md', 'x/.hidden.md', 'x?.md', 'x*.md', 's3://secret.md', 'file.txt', 'x\u0000.md', 'x/'.repeat(300) + 'a.md'])('rejects unsafe path %j', (path) => {
    expect(() => notePath(path)).toThrow();
  });
  it('preserves Unicode and normalizes a directory boundary', () => {
    expect(notePath('Projects/中文.md')).toBe('Projects/中文.md');
    expect(normalizePrefix('vault')).toBe('vault/');
    expect(normalizePrefix('')).toBe('');
    expect(() => normalizePrefix('vault/*')).toThrow();
  });
  it('rejects traversal before S3 and pins reads to the configured prefix', async () => {
    const store = new MemoryStore(); const notes = new Notes(config, store);
    await expect(notes.read('../secret.md', new AbortController().signal)).rejects.toThrow();
    expect(store.reads).toEqual([]);
    const note = await notes.read('Projects/中文.md', new AbortController().signal);
    expect(store.reads).toEqual(['vault/Projects/中文.md']);
    expect(note.body).toContain('中文');
  });
});

describe('bounded scanning', () => {
  it('lists one page, filters attachments and paginates', async () => {
    const store = new MemoryStore(); const notes = new Notes(config, store); const signal = new AbortController().signal;
    const page = await notes.list({ page_size: 1 }, signal);
    expect(page.scanned_objects).toBe(1); expect(page.next_cursor).not.toBeNull();
    await notes.list({ page_size: 1, cursor: page.next_cursor! }, signal);
    expect(store.lists[1]?.cursor).toBe(page.next_cursor);
    expect(store.reads).toEqual([]);
    expect((await notes.list({ page_size: 50 }, signal)).notes).toHaveLength(2);
  });
  it('searches literal filename and body, including Unicode', async () => {
    const store = new MemoryStore(); const notes = new Notes(config, store); const signal = new AbortController().signal;
    expect((await notes.search({ query: '中文' }, signal)).matches[0]?.matched_on).toBe('filename');
    expect((await notes.search({ query: 'typescript' }, signal)).matches[0]?.matched_on).toBe('body');
    expect((await notes.search({ query: '.*' }, signal)).matches).toHaveLength(0);
  });
  it('bounds object reads and exposes skipped bodies rather than claiming completeness', async () => {
    const files = new Map(Array.from({ length: 30 }, (_, i) => [`vault/${String(i).padStart(2, '0')}.md`, 'match']));
    files.set('vault/00.md', 'x'.repeat(MAX_NOTE_BYTES + 1));
    const store = new MemoryStore(files); const notes = new Notes(config, store);
    const page = await notes.search({ query: 'match' }, new AbortController().signal);
    expect(page.listed_objects).toBe(20); expect(page.scanned_objects).toBe(9); expect(store.reads).toHaveLength(8);
    expect(page.body_read_budget_used_bytes).toBe(512 * 1024);
    expect(page.skipped_body_scans).toBe(1); expect(page.incomplete).toBe(true);
    expect(page.next_cursor).not.toBeNull();
    const next = await notes.search({ query: 'match', cursor: page.next_cursor! }, new AbortController().signal);
    expect(next.matches[0]?.path).toBe('09.md');
    expect(store.lists[1]?.after).toBe('vault/08.md');
  });
  it('reports failed reads while allowing the page to advance', async () => {
    const store = new MemoryStore();
    store.read = async () => { throw new Error('unreadable'); };
    const result = await new Notes(config, store).search({ query: 'no-match' }, new AbortController().signal);
    expect(result.failed_body_scans).toBe(2);
    expect(result.incomplete).toBe(true);
    expect(result.matches).toEqual([]);
  });
  it('does not cross the boundary even if a store returns a foreign key', async () => {
    const store = new MemoryStore();
    store.list = async () => ({ objects: [{ key: 'vault-other/leak.md', size: 10 }, { key: 'vault/.obsidian/leak.md', size: 10 }] });
    expect((await new Notes(config, store).search({ query: 'leak' }, new AbortController().signal)).matches).toEqual([]);
    expect(store.reads).toEqual([]);
  });
  it('binds a search cursor to its query and fixed vault prefix', async () => {
    const store = new MemoryStore(new Map(Array.from({ length: 25 }, (_, i) => [`vault/${i}.md`, 'body'])));
    const notes = new Notes(config, store); const signal = new AbortController().signal;
    const first = await notes.search({ query: 'body' }, signal);
    await expect(notes.search({ query: 'different', cursor: first.next_cursor! }, signal)).rejects.toThrow();
    const cursor = JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString('utf8'));
    cursor.afterBase64 = Buffer.from('outside-vault/a.md').toString('base64url');
    await expect(notes.search({ query: 'body', cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }, signal)).rejects.toThrow();
    expect(store.lists).toHaveLength(1);
  });
  it('returns a resumable position before the search deadline is exhausted', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const store = new MemoryStore(new Map(Array.from({ length: 20 }, (_, i) => [`vault/${String(i).padStart(2, '0')}.md`, 'body'])));
      const read = store.read.bind(store);
      store.read = async (...args) => { now += 3500; return read(...args); };
      const page = await new Notes(config, store).search({ query: 'body' }, new AbortController().signal);
      expect(page.matches).toHaveLength(3);
      expect(page.next_cursor).not.toBeNull();
      const position = JSON.parse(Buffer.from(page.next_cursor!, 'base64url').toString('utf8'));
      expect(Buffer.from(position.afterBase64, 'base64url').toString('utf8')).toBe('vault/02.md');
    } finally { clock.mockRestore(); }
  });
});

describe('S3 adapter', () => {
  it('uses a prefix, continuation token and transfer range with no writes', async () => {
    const commands: unknown[] = [];
    const client = { send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: true, NextContinuationToken: 'next' };
      return { ContentLength: 5, Body: Readable.from([Buffer.from('hello')]) };
    } } as unknown as S3Client;
    const store = new S3NotesStore(config.bucket, client); const signal = new AbortController().signal;
    expect((await store.list('vault/', 'previous', 20, signal)).nextCursor).toBe('next');
    expect((commands[0] as ListObjectsV2Command).input).toMatchObject({ Prefix: 'vault/', ContinuationToken: 'previous', MaxKeys: 20 });
    expect(await store.read('vault/a.md', signal)).toBe('hello');
    expect((commands[1] as GetObjectCommand).input).toMatchObject({ Key: 'vault/a.md', Range: `bytes=0-${MAX_NOTE_BYTES}` });
  });
  it('rejects oversized streamed bytes and invalid UTF-8', async () => {
    await expect(boundedBody(Readable.from([Buffer.alloc(MAX_NOTE_BYTES), Buffer.from('x')]), new AbortController().signal)).rejects.toThrow('size limit');
    await expect(boundedBody(Readable.from([Buffer.from([0xff])]), new AbortController().signal)).rejects.toThrow();
  });
  it('reads an empty Markdown object without interpreting arbitrary range errors as empty', async () => {
    let size = 0;
    const client = { send: async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: size };
      throw Object.assign(new Error('range'), { name: 'InvalidRange' });
    } } as unknown as S3Client;
    const store = new S3NotesStore(config.bucket, client);
    expect(await store.read('vault/empty.md', new AbortController().signal)).toBe('');
    size = 10;
    await expect(store.read('vault/not-empty.md', new AbortController().signal)).rejects.toThrow('range');
  });
  it('aborts a stalled response body', async () => {
    const body = new Readable({ read() {} });
    await expect(boundedBody(body, AbortSignal.timeout(20))).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });
});
