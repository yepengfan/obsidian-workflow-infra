import { mcpResources } from '../infra/mcp-resources.js';
import { mcpAppSchema } from '../infra/mcp-runtime.js';
import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { githubSchema, GitHubTrustStack } from '../infra/github-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const app = new App();
const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
const options = mcpAppSchema.parse(JSON.parse(fs.readFileSync('config/mcp-runtime.json', 'utf8')));
new GitHubTrustStack(app, 'ObsidianGitHubTrust', aws, github,
  mcpResources(aws, github.runtimeRoleName, options.notePrefix));
