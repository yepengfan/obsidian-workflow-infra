import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AuthError } from './auth.js';
import { OperationError } from './errors.js';
import type { McpSkill, SkillContext } from './skill.js';

function toolResult(signal: AbortSignal, limit: number, challenge: string) {
  return async (work: () => Promise<object>) => {
    try {
      signal.throwIfAborted();
      const value = await work();
      const response = { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { ...value } };
      if (Buffer.byteLength(JSON.stringify(response)) > limit) throw new OperationError('result_too_large');
      return response;
    } catch (error) {
      if (error instanceof AuthError) return { isError: true, content: [{ type: 'text' as const, text: 'authentication_required' }],
        ...(error.status === 401 ? { _meta: { 'mcp/www_authenticate': challenge } } : {}) };
      const code = signal.aborted ? 'timeout' : error instanceof OperationError ? error.code : 'note_unavailable';
      return { isError: true, content: [{ type: 'text' as const, text: code }] };
    }
  };
}

type RequestContext = Pick<SkillContext, 'settings' | 'store' | 'writer' | 'owner' | 'authorizeScope'>;

export async function serveMcpRequest(request: Request, skills: readonly McpSkill[], challenge: string,
  { settings, store, writer, owner, authorizeScope }: RequestContext) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(settings.limits.deadlineMs)]);
  const server = new McpServer({ name: 'obsidian-s3-mcp', version: '1.0.0' }, {
    instructions: skills.map(skill => skill.instructions).join(' '),
  });
  const result = toolResult(signal, settings.limits.responseBytes, challenge);
  for (const skill of skills) skill.register({ server, store, writer, settings, owner, signal, result,
    authorizeScope: async scope => {
      if (!skill.scopes.includes(scope)) throw new AuthError(403);
      await authorizeScope(scope);
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: settings.limits.requestBytes });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Fully consume the JSON body before closing this invocation's transport.
    const body = await response.text();
    if (Buffer.byteLength(body) > settings.limits.responseBytes) return new Response(null, { status: 413 });
    return new Response(body, { status: response.status, headers: response.headers });
  } finally { await server.close(); }
}
