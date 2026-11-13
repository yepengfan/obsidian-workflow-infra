import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { STORAGE_STACK_NAME, storageSchema } from '../infra/storage-config.js';
import { StorageStack } from '../infra/storage-stack.js';

const app = new App();
const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
new StorageStack(app, STORAGE_STACK_NAME, aws);
new CognitoStack(app, 'ObsidianMcp', aws,
  cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8'))));
// Included in the same reviewable assembly. CI cannot deploy its own IAM
// foundation; permission updates still use the approved local SSO procedure.
new GitHubTrustStack(app, 'ObsidianGitHubTrust', aws,
  githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8'))));
