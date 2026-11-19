import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth.js';
import { createFetchHandler } from '../src/handler.js';
import { Journal, JOURNAL_NOTE_BYTES } from '../src/journal.js';
import type { NoteStore, NoteWriter, WriteCondition } from '../src/note-store.js';
import { NoteError } from '../src/paths.js';
import { owner, runtimeSettings } from './runtime-fixtures.js';

/** Mirrors the S3 adapter: a missing key reads as `note_unavailable`, and conditions are enforced. */
class JournalStore implements NoteStore, NoteWriter {
  files = new Map<string, string>([['Vault/Journal/Dashboard.md', '# Dashboard\nNo trailing newline']]);
  writes: { key: string; condition: WriteCondition }[] = [];
  unreadable = new Set<string>();
  tag(key: string) { return '"' + createHash('sha256').update(this.files.get(key) ?? '').digest('hex') + '"'; }
  async list() { return { folders: [], notes: [] }; }
  async read(key: string, offset: number, length: number, _etag: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.files.has(key) || this.unreadable.has(key)) throw new NoteError('note_unavailable');
    const data = Buffer.from(this.files.get(key)!);
    return { bytes: data.subarray(offset, offset + length), total: data.length, etag: this.tag(key) };
  }
  async put(key: string, text: string, condition: WriteCondition, signal: AbortSignal) {
    signal.throwIfAborted();
    if (condition === 'absent' ? this.files.has(key) : condition !== 'any' && this.tag(key) !== condition.revision) throw new NoteError('revision_conflict');
    this.files.set(key, text); this.writes.push({ key, condition }); return this.tag(key);
  }
}
const settings = (writesEnabled = true) => runtimeSettings({ journal: { writesEnabled } });
const signal = () => AbortSignal.timeout(5000);
const setup = () => { const store = new JournalStore(); return { store, journal: new Journal(store, store, settings()) }; };

describe('Journal writes', () => {
  it('appends on a new line, pinned to the revision it read', async () => {
    const { store, journal } = setup();
    const revision = store.tag('Vault/Journal/Dashboard.md');
    await expect(journal.write({ path: 'Journal/Dashboard.md', mode: 'append', content: '- 记录\n' }, signal()))
      .resolves.toEqual({ path: 'Journal/Dashboard.md', mode: 'append', created: false, totalBytes: Buffer.byteLength('# Dashboard\nNo trailing newline\n- 记录\n') });
    expect(store.files.get('Vault/Journal/Dashboard.md')).toBe('# Dashboard\nNo trailing newline\n- 记录\n');
    expect(store.writes).toEqual([{ key: 'Vault/Journal/Dashboard.md', condition: { revision } }]);
    await journal.write({ path: 'Journal/Dashboard.md', mode: 'append', content: 'next' }, signal());
    expect(store.files.get('Vault/Journal/Dashboard.md')).toBe('# Dashboard\nNo trailing newline\n- 记录\nnext');
  });
  it('creates an absent note when appending, including in a subfolder', async () => {
    const { store, journal } = setup();
    await expect(journal.write({ path: 'Journal/2026/2026-11-19.md', mode: 'append', content: 'today' }, signal()))
      .resolves.toMatchObject({ created: true, totalBytes: 5 });
    expect(store.files.get('Vault/Journal/2026/2026-11-19.md')).toBe('today');
    expect(store.writes).toEqual([{ key: 'Vault/Journal/2026/2026-11-19.md', condition: 'absent' }]);
  });
  it('reports an unreadable existing note instead of replacing it', async () => {
    const { store, journal } = setup();
    store.unreadable.add('Vault/Journal/Dashboard.md');
    await expect(journal.write({ path: 'Journal/Dashboard.md', mode: 'append', content: 'x' }, signal())).rejects.toThrow('note_unavailable');
    expect(store.files.get('Vault/Journal/Dashboard.md')).toBe('# Dashboard\nNo trailing newline');
  });
  it('surfaces a concurrent change during append as a conflict', async () => {
    const { store, journal } = setup();
    const read = store.read.bind(store);
    store.read = async (...args) => { const chunk = await read(...args); store.files.set('Vault/Journal/Dashboard.md', 'synced elsewhere'); return chunk; };
    await expect(journal.write({ path: 'Journal/Dashboard.md', mode: 'append', content: 'x' }, signal())).rejects.toThrow('revision_conflict');
    expect(store.files.get('Vault/Journal/Dashboard.md')).toBe('synced elsewhere');
  });
  it('overwrites unconditionally and creates an absent note', async () => {
    const { store, journal } = setup();
    await expect(journal.write({ path: 'Journal/Dashboard.md', mode: 'overwrite', content: '# New' }, signal()))
      .resolves.toEqual({ path: 'Journal/Dashboard.md', mode: 'overwrite', totalBytes: 5 });
    await journal.write({ path: 'Journal/Review.md', mode: 'overwrite', content: 'fresh' }, signal());
    expect(store.files.get('Vault/Journal/Dashboard.md')).toBe('# New');
    expect(store.files.get('Vault/Journal/Review.md')).toBe('fresh');
    expect(store.writes.map(write => write.condition)).toEqual(['any', 'any']);
  });
  it.each(['Learning/Practice/Algorithm/Log/a.md', 'Journal', 'Journal/', 'journal/a.md', 'Journal2/a.md', 'Journal/../a.md',
    '/Journal/a.md', 'Journal/a.txt', 'Journal/a.md/'])('rejects %j before any storage access', async path => {
    const { store, journal } = setup();
    for (const mode of ['append', 'overwrite'] as const) await expect(journal.write({ path, mode, content: 'x' }, signal())).rejects.toThrow('invalid_path');
    expect(store.writes).toHaveLength(0);
  });
  it('bounds the note read back for append and the saved result', async () => {
    const { store, journal } = setup();
    store.files.set('Vault/Journal/big.md', 'x'.repeat(JOURNAL_NOTE_BYTES + 1));
    await expect(journal.write({ path: 'Journal/big.md', mode: 'append', content: 'y' }, signal())).rejects.toThrow('journal_note_too_large');
    store.files.set('Vault/Journal/full.md', 'x'.repeat(JOURNAL_NOTE_BYTES));
    await expect(journal.write({ path: 'Journal/full.md', mode: 'append', content: 'y' }, signal())).rejects.toThrow('journal_note_too_large');
    store.files.set('Vault/Journal/binary.md', '');
    store.read = async () => ({ bytes: Buffer.from([0xff]), total: 1, etag: '"binary"' });
    await expect(journal.write({ path: 'Journal/binary.md', mode: 'append', content: 'y' }, signal())).rejects.toThrow('invalid_utf8');
    expect(store.writes).toHaveLength(0);
  });
});

describe('journal_write over MCP', () => {
  const connect = async (writesEnabled: boolean, store: JournalStore, writeToken: { granted: boolean }) => {
    const options = settings(writesEnabled);
    const client = new Client({ name: 'journal-test', version: '1' });
    client.onerror = () => {};
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { store, writer: store, verify: async () => owner,
        verifyScope: async (_authorization, scope) => { if (!writeToken.granted || scope !== `${options.resource}/write`) throw new AuthError(401); return owner; },
      })(new Request(input, init)),
    }));
    return { client, options };
  };
  it('is absent unless Journal writes are enabled', async () => {
    const { client } = await connect(false, new JournalStore(), { granted: true });
    try { expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('journal_write'); }
    finally { await client.close(); }
  });
  it('steps up to the shared write scope before touching storage', async () => {
    const store = new JournalStore(), writeToken = { granted: false };
    const { client, options } = await connect(true, store, writeToken);
    try {
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'journal_write');
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool?._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['openid', options.scope, `${options.resource}/write`] }]);
      const request = { name: 'journal_write', arguments: { path: 'Journal/Dashboard.md', mode: 'append', content: 'note' } };
      const denied = await client.callTool(request);
      expect(denied.isError).toBe(true); expect(denied._meta?.['mcp/www_authenticate']).toContain('/write');
      expect(store.writes).toHaveLength(0);
      writeToken.granted = true;
      expect((await client.callTool(request)).structuredContent).toMatchObject({ path: 'Journal/Dashboard.md', mode: 'append', created: false });
      const outside = await client.callTool({ ...request, arguments: { ...request.arguments, path: 'Learning/a.md' } });
      expect(outside).toMatchObject({ isError: true, content: [{ text: 'invalid_path' }] });
    } finally { await client.close(); }
  });
  it('challenges for the write scope when Journal is the only write feature', async () => {
    const options = settings(true);
    const fetch = createFetchHandler(options, { store: new JournalStore() });
    const metadata = await fetch(new Request(new URL('/.well-known/oauth-protected-resource/mcp', options.resource)));
    expect((await metadata.json()).scopes_supported).toEqual(['openid', options.scope, `${options.resource}/write`]);
  });
  it('reports a missing writer as disabled rather than hiding the tool', async () => {
    const options = settings(true);
    const client = new Client({ name: 'journal-test', version: '1' });
    client.onerror = () => {};
    await client.connect(new StreamableHTTPClientTransport(new URL(options.resource), {
      fetch: (input, init) => createFetchHandler(options, { store: new JournalStore(), verify: async () => owner, verifyScope: async () => owner })(new Request(input, init)),
    }));
    try {
      expect(await client.callTool({ name: 'journal_write', arguments: { path: 'Journal/a.md', mode: 'overwrite', content: 'x' } }))
        .toMatchObject({ isError: true, content: [{ text: 'journal_writes_disabled' }] });
    } finally { await client.close(); }
  });
});
