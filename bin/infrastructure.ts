import { mcpResources, mcpRolloutSchema } from '../infra/mcp-resources.js';
import { mcpDeploymentSchema } from '../infra/mcp-permissions.js';
import { mcpAppSchema } from '../infra/mcp-runtime.js';
import { buildRuntime } from './runtime-package.js';
import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { STORAGE_STACK_NAME, storageSchema } from '../infra/storage-config.js';
import { StorageStack } from '../infra/storage-stack.js';

const app = new App();
const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const options = mcpAppSchema.parse(JSON.parse(fs.readFileSync('config/mcp-runtime.json', 'utf8')));
const { stage } = mcpRolloutSchema.parse(JSON.parse(fs.readFileSync('config/mcp-deployment.json', 'utf8')));
const code = stage === 'runtime' ? await buildRuntime(app.outdir, process.env.SOURCE_SHA ?? 'local') : undefined;
const deployment = mcpDeploymentSchema.parse(mcpResources(aws, github.runtimeRoleName, options.notePrefix));
new StorageStack(app, STORAGE_STACK_NAME, aws);
new CognitoStack(app, 'ObsidianMcp', aws,
  cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8'))),
  stage === 'identity' ? undefined : deployment,
  code ? { options, code, noteBucket: aws.buckets.vault.name } : undefined);
// Included in the same reviewable assembly. CI cannot deploy its own IAM
// foundation; permission updates still use the approved local SSO procedure.
new GitHubTrustStack(app, 'ObsidianGitHubTrust', aws, github, deployment);
