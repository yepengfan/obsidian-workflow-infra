import { S3Client } from '@aws-sdk/client-s3';
import { environmentSettings, vaultWritesEnabled, type Settings } from './config.js';
import { createFetchHandler } from './handler.js';
import { S3NoteStore } from './s3.js';

export interface HttpEvent { rawPath: string; rawQueryString?: string; headers: Record<string, string | undefined>; requestContext: { http: { method: string } }; body?: string; isBase64Encoded?: boolean }
let warm: { settings: Settings; fetch: ReturnType<typeof createFetchHandler> } | undefined;
export async function handler(event: HttpEvent, context: { awsRequestId: string }) {
  try {
    if (!warm) {
      const settings = environmentSettings(process.env);
      const store = new S3NoteStore(new S3Client({ region: settings.region, maxAttempts: 2 }), settings.bucket);
      warm = { settings, fetch: createFetchHandler(settings, { store, writer: vaultWritesEnabled(settings) ? store : undefined, log: record => console.info(JSON.stringify(record)) }) };
    }
    if ((event.body?.length ?? 0) > warm.settings.limits.requestBytes * (event.isBase64Encoded ? 1.4 : 1)) return { statusCode: 413, body: '' };
    const body = event.body ? event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body) : undefined;
    if (body && body.length > warm.settings.limits.requestBytes) return { statusCode: 413, body: '' };
    const headers = Object.fromEntries(Object.entries(event.headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const request = new Request(`${new URL(warm.settings.resource).origin}${event.rawPath}${event.rawQueryString ? '?' + event.rawQueryString : ''}`, {
      method: event.requestContext.http.method, headers, ...(body ? { body } : {}),
    });
    const response = await warm.fetch(request, context.awsRequestId);
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  } catch { return { statusCode: 500, headers: { 'Cache-Control': 'no-store' }, body: '' }; }
}
