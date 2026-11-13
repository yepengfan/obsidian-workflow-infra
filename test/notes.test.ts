import { describe, expect, it } from 'vitest';
import { Notes, listInput, readInput, searchInput } from '../src/notes.js';
import { owner, MemoryStore, runtimeSettings } from './runtime-fixtures.js';

describe('caller-selected note retrieval', () => {
  it('lists exactly one child page, binds pagination context and never reads bodies', async () => {
    const store = new MemoryStore(); const settings = runtimeSettings();
    const notes = new Notes(store, settings, owner, AbortSignal.timeout(1000));
    const first = await notes.list(listInput.parse({ folder: '', limit: 100 }));
    expect(first).toMatchObject({ scope: 'direct_children', complete: false, folders: [{ path: 'Folder/' }], notes: [{ path: 'hello.md' }] });
    expect(store.calls).toEqual([{ kind: 'list', key: 'Vault/', limit: 20, cursor: undefined }]);
    await notes.list({ folder: '', cursor: first.nextCursor });
    expect(store.calls[1]?.cursor).toBe('s3-page-two');
    await expect(notes.list({ folder: 'Folder/', cursor: first.nextCursor })).rejects.toThrow('invalid_cursor');
    await expect(notes.list({ folder: '', limit: 1, cursor: first.nextCursor })).rejects.toThrow('invalid_cursor');
    expect(store.calls).toHaveLength(2);
  });
  it('searches filenames within one direct-child metadata page only', async () => {
    const store = new MemoryStore(); store.page.notes.push({ key: 'Vault/other.md', size: 1 });
    const notes = new Notes(store, runtimeSettings(), owner, AbortSignal.timeout(1000));
    const result = await notes.search(searchInput.parse({ mode: 'filename', folder: '', query: 'HELLO' }));
    expect(result).toMatchObject({ complete: false, notes: [{ path: 'hello.md' }] });
    expect(store.calls.map(call => call.kind)).toEqual(['list']);
  });
  it('searches only the explicit selection with bounded parallelism and complete status per note', async () => {
    const store = new MemoryStore();
    const settings = runtimeSettings(); settings.limits.parallelReads = 2; settings.limits.searchBytesPerNote = 1024;
    for (let index = 0; index < 8; index++) store.files.set(`Vault/${index}.md`, index === 7 ? 'x'.repeat(2048) : 'hello 私人');
    const notes = new Notes(store, settings, owner, AbortSignal.timeout(1000));
    const result = await notes.search(searchInput.parse({ mode: 'body', query: '私人', paths: Array.from({ length: 8 }, (_, i) => `${i}.md`) }));
    expect(result).toMatchObject({ scope: 'selected_notes', complete: false, results: expect.arrayContaining([{ path: '7.md', status: 'too_large' }]) });
    expect(store.calls).toHaveLength(8); expect(store.calls.every(call => call.kind === 'read' && call.limit === 1024)).toBe(true);
    expect(store.peak).toBe(2); expect(store.calls.some(call => call.key === 'Vault/hello.md')).toBe(false);
  });
  it.each([
    { mode: 'body', query: 'x', paths: [] }, { mode: 'body', query: 'x', folder: '' },
    { mode: 'body', query: 'x', paths: ['hello.md'], folder: '' }, { mode: 'all', query: 'x' },
    { mode: 'filename', query: 'x', folder: '', recursive: true },
  ])('rejects scan and automatic expansion requests: %j', input => { expect(searchInput.safeParse(input).success).toBe(false); });
  it.each(['../private.md', '/private.md', 'Notes/../private.md', 'a\\b.md', 'a//b.md', 'secret.txt', 'a\u0000.md'])('rejects %j before any read', async path => {
    const store = new MemoryStore(); const notes = new Notes(store, runtimeSettings(), owner, AbortSignal.timeout(1000));
    await expect(notes.read(readInput.parse({ path }))).rejects.toThrow('invalid_path'); expect(store.calls).toHaveLength(0);
  });
  it('validates the entire selected batch before reading any note', async () => {
    const store = new MemoryStore(); const notes = new Notes(store, runtimeSettings(), owner, AbortSignal.timeout(1000));
    await expect(notes.search(searchInput.parse({ mode: 'body', query: 'x', paths: ['hello.md', '../bad.md'] }))).rejects.toThrow('invalid_path');
    expect(store.calls).toHaveLength(0);
  });
  it('reads UTF-8 chunks without losing split characters, pins versions and binds cursors to notes', async () => {
    const store = new MemoryStore(); const settings = runtimeSettings(); settings.limits.readChunkBytes = 256;
    const text = 'a'.repeat(255) + '知识库🪴'.repeat(30); store.files.set('Vault/hello.md', text);
    const notes = new Notes(store, settings, owner, AbortSignal.timeout(1000));
    let current = await notes.read({ path: 'hello.md' }); let joined = current.text;
    expect(current.text).toBe('a'.repeat(255));
    const firstCursor = current.nextCursor;
    while (!current.complete) { current = await notes.read({ path: 'hello.md', cursor: current.nextCursor }); joined += current.text; }
    expect(joined).toBe(text); expect(store.calls.slice(1).every(call => call.etag === store.etag)).toBe(true);
    await expect(notes.read({ path: 'other.md', cursor: firstCursor })).rejects.toThrow('invalid_cursor');
    store.etag = '"updated"'; await expect(notes.read({ path: 'hello.md', cursor: firstCursor })).rejects.toThrow();
  });
  it('does not accept another owner pagination context or a forged outside-prefix listing', async () => {
    const store = new MemoryStore(); const settings = runtimeSettings();
    const first = await new Notes(store, settings, owner, AbortSignal.timeout(1000)).list({ folder: '' });
    await expect(new Notes(store, settings, 'other', AbortSignal.timeout(1000)).list({ folder: '', cursor: first.nextCursor })).rejects.toThrow('invalid_cursor');
    store.page = { folders: [], notes: [{ key: 'Outside/secret.md', size: 1 }] };
    await expect(new Notes(store, settings, owner, AbortSignal.timeout(1000)).list({ folder: '' })).rejects.toThrow('note_unavailable');
  });
});
