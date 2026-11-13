import { runtimeOptionsSchema, type Settings } from '../src/config.js';
import type { CatalogPage, NoteChunk, NoteStore } from '../src/s3.js';

export const owner = '11111111-1111-4111-8111-111111111111';
export const runtimeSettings = (overrides: Partial<Settings> = {}): Settings => ({
  ...runtimeOptionsSchema.parse({ ownerSubjects: [owner] }), bucket: 'private-test-vault', prefix: 'Vault/', region: 'ap-southeast-2',
  issuer: 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Test', clientId: 'test-client',
  resource: 'https://example.execute-api.ap-southeast-2.amazonaws.com/mcp', scope: 'obsidian.notes/read', ...overrides,
});
export class MemoryStore implements NoteStore {
  calls: { kind: 'list' | 'read'; key: string; limit: number; cursor?: string; etag?: string }[] = [];
  page: CatalogPage = { folders: ['Vault/Folder/'], notes: [{ key: 'Vault/hello.md', size: 14 }], next: 's3-page-two' };
  files = new Map<string, string>([['Vault/hello.md', 'Hello 私人知识库']]);
  etag = '"version-one"'; active = 0; peak = 0;
  async list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted(); this.calls.push({ kind: 'list', key: prefix, limit, cursor });
    return cursor ? { folders: [], notes: [], next: undefined } : this.page;
  }
  async read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal): Promise<NoteChunk> {
    signal.throwIfAborted(); this.calls.push({ kind: 'read', key, limit: length, etag });
    this.active++; this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (!this.files.has(key) || (etag && etag !== this.etag)) throw Error('unavailable');
      const data = Buffer.from(this.files.get(key)!);
      return { bytes: data.subarray(offset, offset + length), total: data.length, etag: this.etag };
    } finally { this.active--; }
  }
}
