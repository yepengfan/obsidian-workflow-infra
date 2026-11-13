import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const app = new App();
new GitHubTrustStack(app, 'ObsidianGitHubTrust',
  storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8'))),
  githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8'))));
