import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NoteError } from './paths.js';

export interface CatalogPage { folders: string[]; notes: { key: string; size: number; modified?: string }[]; next?: string }
export interface NoteChunk { bytes: Uint8Array; total: number; etag: string }
export interface NoteStore {
  list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal): Promise<CatalogPage>;
  read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal): Promise<NoteChunk>;
}
export class S3NoteStore implements NoteStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}
  async list(prefix: string, limit: number, cursor: string | undefined, signal: AbortSignal): Promise<CatalogPage> {
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', MaxKeys: limit, ContinuationToken: cursor }), { abortSignal: signal });
    if (result.IsTruncated && !result.NextContinuationToken) throw new NoteError('note_unavailable');
    return { folders: (result.CommonPrefixes ?? []).flatMap(item => item.Prefix ? [item.Prefix] : []),
      notes: (result.Contents ?? []).flatMap(item => item.Key && item.Size !== undefined ? [{ key: item.Key, size: item.Size, modified: item.LastModified?.toISOString() }] : []),
      next: result.IsTruncated ? result.NextContinuationToken : undefined };
  }
  async read(key: string, offset: number, length: number, etag: string | undefined, signal: AbortSignal): Promise<NoteChunk> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}`, IfMatch: etag }), { abortSignal: signal });
      const range = result.ContentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
      const total = range ? Number(range[3]) : result.ContentLength;
      if (!result.Body || !result.ETag || total === undefined || !Number.isSafeInteger(total) || total < 0 ||
        (range ? Number(range[1]) !== offset : offset !== 0) || (result.ContentLength ?? length + 1) > length) {
        await result.Body?.transformToWebStream().cancel(); throw new NoteError('note_unavailable');
      }
      const parts: Buffer[] = []; let size = 0;
      const reader = result.Body.transformToWebStream().getReader();
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          const data = Buffer.from(next.value); size += data.length;
          if (size > length) throw new NoteError('note_unavailable');
          parts.push(data);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {});
      }
      if (size !== result.ContentLength) throw new NoteError('note_unavailable');
      return { bytes: Buffer.concat(parts), total, etag: result.ETag };
    } catch (error) {
      // S3 answers Range requests for empty files with 416. Confirm only that key.
      if (offset === 0 && error instanceof Error && '$metadata' in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 416) {
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, IfMatch: etag }), { abortSignal: signal });
        if (head.ContentLength === 0 && head.ETag) return { bytes: new Uint8Array(), total: 0, etag: head.ETag };
      }
      throw new NoteError(signal.aborted ? 'timeout' : 'note_unavailable');
    }
  }
}
