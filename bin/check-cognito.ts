import fs from 'node:fs';
import { z } from 'zod';
import { checkCognitoDiscovery } from '../infra/cognito-discovery.js';
import { cognitoSchema } from '../infra/cognito-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const settings = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));
const state = z.object({ Stacks: z.array(z.object({
  StackName: z.literal('ObsidianMcp'),
  StackStatus: z.enum(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']),
  Outputs: z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() })),
})).length(1) }).parse(JSON.parse(fs.readFileSync(process.argv[2] ?? 'cognito-stack.json', 'utf8')));
const outputs = Object.fromEntries(state.Stacks[0]!.Outputs.map(output => [output.OutputKey, output.OutputValue]));
const poolId = z.string().regex(new RegExp(`^${aws.region}_[A-Za-z0-9]+$`, 'u')).parse(outputs.UserPoolId);
if (outputs.PermissionPoolArn && outputs.PermissionPoolArn !== `arn:aws:cognito-idp:${aws.region}:${aws.account}:userpool/${poolId}`) throw new Error('Cognito permission export differs from the managed pool');
const issuer = `https://cognito-idp.${aws.region}.amazonaws.com/${poolId}`;
const domain = `https://${settings.domainPrefix}.auth.${aws.region}.amazoncognito.com`;
if (outputs.OAuthIssuer !== issuer || outputs.ManagedLoginDomain !== domain) throw new Error('Cognito outputs differ from expected versioned configuration');
await checkCognitoDiscovery(issuer, domain);
if (outputs.McpEndpoint) {
  const endpoint = z.url().parse(outputs.McpEndpoint);
  const url = new URL(endpoint);
  if (!new RegExp(`^https://[a-z0-9]+\\.execute-api\\.${aws.region}\\.amazonaws\\.com/mcp$`, 'u').test(endpoint)) throw new Error('Unexpected MCP endpoint');
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
  const metadataResponse = await fetch(metadataUrl, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!metadataResponse.ok) throw new Error('MCP resource discovery failed');
  const metadata = z.object({ resource: z.literal(endpoint), authorization_servers: z.array(z.string()).length(1), scopes_supported: z.array(z.string()) }).parse(await metadataResponse.json());
  if (metadata.authorization_servers[0] !== issuer || !metadata.scopes_supported.includes('obsidian.notes/read')) throw new Error('MCP discovery differs from the managed identity');
  const challenge = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'public-auth-check', version: '1' } } }),
  });
  await challenge.body?.cancel();
  if (challenge.status !== 401 || !challenge.headers.get('WWW-Authenticate')?.includes(`resource_metadata="${metadataUrl}"`)) throw new Error('Anonymous MCP request was not safely challenged');
  console.log('Public MCP metadata and anonymous authentication challenge passed; no note read was requested.');
}
console.log('Cognito discovery passed. Real PKCE, resource audience, refresh and ChatGPT connection tests are still required before private-note access.');
