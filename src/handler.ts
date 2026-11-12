import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AuthFailure, createVerifier } from './auth.js';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';
import { createServer } from './mcp.js';
import { Notes, S3NotesStore, type NotesStore } from './notes.js';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createHandler(config: RuntimeConfig, store: NotesStore, verify = createVerifier(config), log: (entry: object) => void = console.info) {
  const base = new URL(config.resource).origin;
  const metadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const scopes = [config.oauth.scope, ...(config.oauth.requestOfflineAccess ? ['offline_access'] : [])];
  const notes = new Notes(config, store);
  async function fetchRequest(request: Request, signal: AbortSignal): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin && !config.allowedOrigins.includes(origin)) return json(403, { error: 'Origin not allowed' });
    if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
      return json(200, { resource: config.resource, authorization_servers: [config.oauth.issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] });
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'Not found' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id',
    } });
    try { await verify(request.headers.get('authorization')); }
    catch (error) {
      const failure = error instanceof AuthFailure ? error : new AuthFailure(401, 'invalid_token');
      return json(failure.status, { error: failure.code }, {
        'www-authenticate': `Bearer resource_metadata="${metadataUrl}", scope="${scopes.join(' ')}", error="${failure.code}"`,
      });
    }
    // Stateless request/response mode does not offer a persistent SSE stream or sessions.
    if (request.method !== 'POST') return json(405, { error: 'Use POST for stateless Streamable HTTP' }, { allow: 'POST, OPTIONS' });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) return json(413, { error: 'Request too large' });
    const server = createServer(notes, config, signal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // Consume the terminal JSON before closing the transport.
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return json(500, { error: 'Response exceeds limit' });
      return new Response(text || null, { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  }
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const started = Date.now();
    let response: Response;
    try {
      const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : undefined;
      if (body && body.byteLength > MAX_REQUEST_BYTES) response = json(413, { error: 'Request too large' });
      else {
        // Never derive resource/audience/discovery URLs from an untrusted Host header.
        const url = new URL(base);
        url.pathname = event.rawPath;
        const headers = new Headers();
        for (const [key, value] of Object.entries(event.headers)) if (value !== undefined) headers.set(key, value);
        const method = event.requestContext.http.method;
        response = await fetchRequest(new Request(url, { method, headers,
          body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        }), AbortSignal.timeout(18_000));
      }
    } catch { response = json(500, { error: 'Request failed' }); }
    const origin = event.headers.origin;
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-content-type-options', 'nosniff');
    if (origin && config.allowedOrigins.includes(origin)) {
      response.headers.set('access-control-allow-origin', origin);
      response.headers.set('vary', 'Origin');
      response.headers.set('access-control-expose-headers', 'WWW-Authenticate, MCP-Protocol-Version');
    }
    // Deliberately omit paths, queries, bodies, identities, headers and exception messages.
    log({ event: 'http_request', requestId: event.requestContext.requestId, status: response.status, durationMs: Date.now() - started });
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), isBase64Encoded: false };
  };
}

let cached: ReturnType<typeof createHandler> | undefined;
export async function handler(event: APIGatewayProxyEventV2) {
  if (!cached) {
    const config = loadRuntimeConfig(process.env);
    cached = createHandler(config, new S3NotesStore(config.bucket, new S3Client({ region: config.region, maxAttempts: 2, followRegionRedirects: false })));
  }
  return cached(event);
}
