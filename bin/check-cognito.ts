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
console.log('Cognito discovery passed. Real PKCE, resource audience, refresh and ChatGPT connection tests are still required before private-note access.');
