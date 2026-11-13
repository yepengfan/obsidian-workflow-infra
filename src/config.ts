import { z } from 'zod';

export const limitsSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(100).default(20),
  selectedNotes: z.number().int().min(1).max(20).default(20),
  parallelReads: z.number().int().min(1).max(8).default(4),
  searchBytesPerNote: z.number().int().min(1024).max(262144).default(262144),
  readChunkBytes: z.number().int().min(256).max(16384).default(16384),
  requestBytes: z.number().int().min(1024).max(65536).default(65536),
  responseBytes: z.number().int().min(8192).max(262144).default(262144),
  deadlineMs: z.number().int().min(1000).max(8000).default(5000),
});
export const runtimeOptionsSchema = z.strictObject({
  ownerSubjects: z.array(z.uuid()).max(5).default([]),
  callbackUrls: z.array(z.url().refine(value => {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.hash && !url.search &&
      (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/u.test(url.pathname));
  }, 'Copy the exact ChatGPT production callback URI')).max(2).default([]),
  allowedOrigins: z.array(z.url().refine(value => new URL(value).origin === value && value.startsWith('https://'))).max(5).default(['https://chatgpt.com']),
  limits: limitsSchema.default({ pageSize: 20, selectedNotes: 20, parallelReads: 4, searchBytesPerNote: 262144, readChunkBytes: 16384, requestBytes: 65536, responseBytes: 262144, deadlineMs: 5000 }),
});
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;
export type Settings = RuntimeOptions & { bucket: string; prefix: string; region: string; issuer: string; clientId: string; resource: string; scope: string };

export function environmentSettings(env: NodeJS.ProcessEnv): Settings {
  const required = (name: string) => { const value = env[name]; if (!value) throw Error('Missing runtime configuration'); return value; };
  const resource = required('MCP_RESOURCE');
  const issuer = required('OAUTH_ISSUER');
  if (!/^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/mcp$/u.test(resource) ||
      !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/u.test(issuer)) throw Error('Invalid runtime origin');
  return { ...runtimeOptionsSchema.parse(JSON.parse(required('MCP_OPTIONS'))), bucket: required('NOTE_BUCKET'),
    prefix: env.NOTE_PREFIX ?? '', region: required('AWS_REGION'), issuer, clientId: required('OAUTH_CLIENT_ID'),
    resource, scope: required('OAUTH_SCOPE') };
}
