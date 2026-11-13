import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { STORAGE_STACK_NAME, storageSchema } from '../infra/storage-config.js';
import { StorageStack } from '../infra/storage-stack.js';

const app = new App();
const configPath = String(app.node.tryGetContext('storageConfig') ?? 'config/storage.json');
const config = storageSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
new StorageStack(app, STORAGE_STACK_NAME, config);
