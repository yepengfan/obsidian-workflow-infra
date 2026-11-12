import { z } from 'zod';
import { normalizePrefix } from './paths.js';

export const httpsUrl = z.string().url().refine((value) => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
}, 'Must be an HTTPS URL without credentials, query, or fragment');

export const oauthSchema = z.object({
  issuer: httpsUrl,
  jwksUri: httpsUrl,
  clientId: z.string().min(1).max(256),
  // An empty allowlist is intentional for first deployment: every user is denied.
  allowedSubjects: z.array(z.string().min(1).max(256)).max(10),
  scope: z.string().regex(/^[a-zA-Z0-9:_./-]+$/u),
  requestOfflineAccess: z.boolean().default(true),
}).strict();

export const deploymentSchema = z.object({
  account: z.string().regex(/^\d{12}$/u),
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/u),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
  prefix: z.string().transform(normalizePrefix),
  cognito: z.object({
    domainPrefix: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u).optional(),
    callbackUrls: z.array(httpsUrl).max(5).default([]),
    allowedSubjects: z.array(z.string().uuid()).max(10).default([]),
    resourceIdentifier: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u).default('obsidian-mcp'),
    scopeName: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/u).default('read'),
    accessTokenMinutes: z.number().int().min(5).max(60).default(15),
    refreshTokenDays: z.number().int().min(1).max(365).default(30),
  }).strict(),
  allowedOrigins: z.array(httpsUrl.refine((v) => new URL(v).origin === v)).max(10)
    .default(['https://chatgpt.com', 'https://chat.openai.com']),
  kmsKeyArn: z.string().regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/u).optional(),
}).strict();

export type DeploymentConfig = z.infer<typeof deploymentSchema>;
export type RuntimeConfig = Pick<DeploymentConfig, 'bucket' | 'prefix' | 'region' | 'allowedOrigins'> & {
  oauth: z.infer<typeof oauthSchema>;
  resource: string;
};

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const runtime = z.object({
    bucket: deploymentSchema.shape.bucket, prefix: deploymentSchema.shape.prefix,
    region: deploymentSchema.shape.region, oauth: oauthSchema,
    allowedOrigins: deploymentSchema.shape.allowedOrigins,
  }).parse({
    region: env.NOTES_REGION,
    bucket: env.NOTES_BUCKET,
    prefix: env.NOTES_PREFIX,
    oauth: JSON.parse(env.OAUTH_CONFIG ?? '{}') as unknown,
    allowedOrigins: JSON.parse(env.ALLOWED_ORIGINS ?? '[]') as unknown,
  });
  const resource = httpsUrl.parse(env.MCP_RESOURCE);
  if (new URL(resource).pathname !== '/mcp') throw new Error('Resource must end in /mcp');
  return { ...runtime, resource };
}
