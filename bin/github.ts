import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const app = new App();
const read = (name: string, fallback: string) => JSON.parse(fs.readFileSync(String(app.node.tryGetContext(name) ?? fallback), 'utf8'));
new GitHubTrustStack(app, 'ObsidianGitHubTrust', storageSchema.parse(read('storageConfig', 'config/storage.json')),
  githubSchema.parse(read('githubConfig', 'config/github.json')));
