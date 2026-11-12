import type { RuntimeConfig } from '../src/config.js';
import type { NotesStore, ObjectPage } from '../src/notes.js';

export const config: RuntimeConfig = {
  bucket: 'private-test-vault', prefix: 'vault/', region: 'ap-southeast-2',
  resource: 'https://mcp.example.com/mcp', allowedOrigins: ['https://chatgpt.com'],
  oauth: { issuer: 'https://issuer.example.com/', jwksUri: 'https://issuer.example.com/jwks', clientId: 'chatgpt-client', allowedSubjects: ['owner'], scope: 'notes:read', requestOfflineAccess: true },
};

export class MemoryStore implements NotesStore {
  reads: string[] = [];
  lists: { prefix: string; cursor?: string; count: number; after?: string }[] = [];
  constructor(public files = new Map<string, string>([
    ['vault/Projects/中文.md', '# 中文笔记\nPrivate body about TypeScript'],
    ['vault/daily.md', '# Daily\nAWS CDK Lambda journal'],
    ['vault/image.png', 'binary'],
  ])) {}
  async list(prefix: string, cursor: string | undefined, count: number, signal: AbortSignal, after?: string): Promise<ObjectPage> {
    signal.throwIfAborted();
    this.lists.push({ prefix, cursor, count, after });
    const all = [...this.files].filter(([key]) => key.startsWith(prefix) && (!after || Buffer.compare(Buffer.from(key), Buffer.from(after)) > 0))
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const offset = cursor ? Number(cursor) : 0;
    return {
      objects: all.slice(offset, offset + count).map(([key, body]) => ({ key, size: Buffer.byteLength(body) })),
      nextCursor: offset + count < all.length ? String(offset + count) : undefined,
    };
  }
  async read(key: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.reads.push(key);
    const body = this.files.get(key);
    if (body === undefined) throw new Error('NoSuchKey with private details');
    return body;
  }
}
