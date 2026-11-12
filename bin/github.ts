import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { z } from 'zod';
import { GitHubTrustStack } from '../infra/github-stack.js';

const app = new App();
const config = z.object({
  account: z.string().regex(/^\d{12}$/u), region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/u),
  repositorySubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+(?:@\d+)?\/[A-Za-z0-9_.-]+(?:@\d+)?$/u),
  createProvider: z.boolean().default(false), bootstrapQualifier: z.string().regex(/^[a-z0-9]+$/u).default('hnb659fds'),
}).strict().parse(JSON.parse(fs.readFileSync(String(app.node.tryGetContext('githubConfig') ?? 'config/github.local.json'), 'utf8')));
new GitHubTrustStack(app, 'ObsidianGitHubTrust', config);
