import { z } from 'zod';
import { practiceOptionsSchema } from './practice-options.js';

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
  metadataSearch: z.boolean().default(false),
  practice: practiceOptionsSchema.default({ enabled: false, writesEnabled: false, timeZone: 'Australia/Brisbane' }),
  journal: z.strictObject({ writesEnabled: z.boolean().default(false) }).default({ writesEnabled: false }),
  ownerGroup: z.string().regex(/^obsidian-mcp-[a-z0-9-]+$/u).max(128).default('obsidian-mcp-owners'),
  callbackUrls: z.array(z.url().refine(value => {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.hash && !url.search &&
      (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/u.test(url.pathname));
  }, 'Copy the exact ChatGPT production callback URI')).max(2).default([]),
  claudeCallbackUrls: z.array(z.literal('https://claude.ai/api/mcp/auth_callback')).max(1).default([]),
  allowedOrigins: z.array(z.url().refine(value => new URL(value).origin === value && value.startsWith('https://'))).max(5).default(['https://chatgpt.com']),
  limits: limitsSchema.default({ pageSize: 20, selectedNotes: 20, parallelReads: 4, searchBytesPerNote: 262144, readChunkBytes: 16384, requestBytes: 65536, responseBytes: 262144, deadlineMs: 5000 }),
});
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;
/** Any enabled write feature needs the shared write scope, IAM grant and writer port. */
export const vaultWritesEnabled = (options: Pick<RuntimeOptions, 'practice' | 'journal'>) =>
  options.practice.writesEnabled || options.journal.writesEnabled;
export type Settings = RuntimeOptions & { bucket: string; prefix: string; region: string; issuer: string; clientIds: string[]; resource: string; scope: string };

export function environmentSettings(env: NodeJS.ProcessEnv): Settings {
  const required = (name: string) => { const value = env[name]; if (!value) throw Error('Missing runtime configuration'); return value; };
  const resource = required('MCP_RESOURCE');
  const scope = required('OAUTH_SCOPE');
  const issuer = required('OAUTH_ISSUER');
  if (!/^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/mcp$/u.test(resource) ||
      !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/u.test(issuer)) throw Error('Invalid runtime origin');
  if (scope !== `${resource}/read`) throw Error('Invalid resource-bound read scope');
  // CloudFormation updates Lambda configuration and code separately. Accept the
  // previous single-client configuration during rollout/rollback only when the
  // new allowlist is absent; a present invalid allowlist must fail closed.
  const clientIds = env.OAUTH_CLIENT_IDS === undefined ? [required('OAUTH_CLIENT_ID')] : JSON.parse(required('OAUTH_CLIENT_IDS'));
  return { ...runtimeOptionsSchema.parse(JSON.parse(required('MCP_OPTIONS'))), bucket: required('NOTE_BUCKET'),
    prefix: env.NOTE_PREFIX ?? '', region: required('AWS_REGION'), issuer,
    clientIds: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/u).max(128)).min(1).max(2)
      .refine(ids => new Set(ids).size === ids.length, 'OAuth client IDs must be unique').parse(clientIds),
    resource, scope };
}
