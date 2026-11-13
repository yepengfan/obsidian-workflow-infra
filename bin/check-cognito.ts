import fs from 'node:fs';
import { z } from 'zod';
import { checkCognitoDiscovery } from '../infra/cognito-discovery.js';
import { cognitoSchema } from '../infra/cognito-stack.js';
import { storageSchema } from '../infra/storage-config.js';
import { githubSchema } from '../infra/github-stack.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const settings = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const state = z.object({ Stacks: z.array(z.object({
  StackName: z.literal('ObsidianMcp'),
  StackStatus: z.enum(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']),
  Outputs: z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() })),
})).length(1) }).parse(JSON.parse(fs.readFileSync(process.argv[2] ?? 'cognito-stack.json', 'utf8')));
const outputs = Object.fromEntries(state.Stacks[0]!.Outputs.map(output => [output.OutputKey, output.OutputValue]));
const poolId = z.string().regex(new RegExp(`^${aws.region}_[A-Za-z0-9]+$`, 'u')).parse(outputs.UserPoolId);
if (github.mcpUserPoolId && poolId !== github.mcpUserPoolId) throw new Error('Cognito pool differs from pinned IAM configuration');
const issuer = `https://cognito-idp.${aws.region}.amazonaws.com/${poolId}`;
const domain = `https://${settings.domainPrefix}.auth.${aws.region}.amazoncognito.com`;
if (outputs.OAuthIssuer !== issuer || outputs.ManagedLoginDomain !== domain) throw new Error('Cognito outputs differ from expected versioned configuration');
await checkCognitoDiscovery(issuer, domain);
console.log('Cognito discovery passed. Pool-ID pinning and real PKCE, resource audience, refresh and ChatGPT connection tests are still required before private-note access.');
