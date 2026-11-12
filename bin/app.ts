import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { deploymentSchema } from '../src/config.js';
import { ObsidianStack } from '../infra/stack.js';

const app = new App();
const configPath = String(app.node.tryGetContext('config') ?? process.env.DEPLOY_CONFIG ?? 'config/local.json');
const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const config = deploymentSchema.parse(raw);
if (!app.node.tryGetContext('preview') && /REPLACE|YOUR-TENANT|replace-with|111111111111/u.test(JSON.stringify(config))) {
  throw new Error('Replace example settings before deployment. For an offline preview use -c preview=true.');
}
new ObsidianStack(app, 'ObsidianS3Mcp', config);
