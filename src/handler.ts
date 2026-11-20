import type { McpSkill } from './skill.js';
import { serveMcpRequest } from './mcp-request.js';
import { configuredSkills } from './skills.js';
import { randomUUID } from 'node:crypto';
import { AuthError, requiredScopes, tokenVerifier } from './auth.js';
import type { Settings } from './config.js';
import type { NoteStore, NoteWriter } from './note-store.js';

type DenialReason = 'origin_or_host' | 'authentication' | 'owner_group';
type Audit = { event: 'mcp_request'; requestId: string; status: number; durationMs: number; denialReason?: DenialReason };
type Dependencies = { store: NoteStore; writer?: NoteWriter; skills?: readonly McpSkill[]; verifyScope?: (authorization: string | null, scope: string) => Promise<string>; verify?: (authorization: string | null) => Promise<string>; log?: (record: Audit) => void };

export function createFetchHandler(settings: Settings, dependencies: Dependencies) {
  const skills = configuredSkills(settings, dependencies.skills);
  const scopes = requiredScopes(settings, skills.flatMap(skill => skill.scopes));
  const origin = new URL(settings.resource).origin;
  const verify = dependencies.verify ?? tokenVerifier(settings);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  // MCP clients such as Claude request only the challenge scopes and cannot step up later.
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${scopes.join(' ')}"`;
  return async (request: Request, requestId: string = randomUUID()): Promise<Response> => {
    const started = Date.now();
    let denialReason: DenialReason | undefined;
    const serve = async (): Promise<Response> => {
      const url = new URL(request.url);
      const presentedOrigin = request.headers.get('origin');
      if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== new URL(origin).host) ||
        (presentedOrigin && !settings.allowedOrigins.includes(presentedOrigin))) {
        denialReason = 'origin_or_host';
        return new Response(null, { status: 403 });
      }
      if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
        return Response.json({ resource: settings.resource, authorization_servers: [settings.issuer], scopes_supported: scopes, bearer_methods_supported: ['header'], resource_name: 'Private Obsidian notes' });
      }
      if (url.pathname !== '/mcp') return new Response(null, { status: 404 });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
      } });
      let owner: string;
      try { owner = await verify(request.headers.get('authorization')); }
      catch (error) {
        const status = error instanceof AuthError ? error.status : 401;
        denialReason = status === 403 ? 'owner_group' : 'authentication';
        return new Response(null, { status, headers: { 'WWW-Authenticate': challenge } });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS' } });
      return serveMcpRequest(request, skills, challenge, {
        settings, store: dependencies.store, writer: dependencies.writer, owner,
        authorizeScope: async scope => {
          const verifyScope = dependencies.verifyScope ?? ((authorization, required) => tokenVerifier(settings, undefined, required)(authorization));
          const scopedOwner = await verifyScope(request.headers.get('authorization'), scope);
          if (scopedOwner !== owner) throw new AuthError(403);
        },
      });
    };
    let response: Response;
    try { response = await serve(); } catch { response = new Response(null, { status: 500 }); }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    const presentedOrigin = request.headers.get('origin');
    if (presentedOrigin && settings.allowedOrigins.includes(presentedOrigin)) {
      response.headers.set('Access-Control-Allow-Origin', presentedOrigin);
      response.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
      response.headers.set('Vary', 'Origin');
    }
    dependencies.log?.({ event: 'mcp_request', requestId, status: response.status, durationMs: Date.now() - started,
      ...(denialReason ? { denialReason } : {}) });
    return response;
  };
}
