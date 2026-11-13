import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { STORAGE_STACK_NAME, storageSchema } from '../infra/storage-config.js';
import { StorageStack } from '../infra/storage-stack.js';

const app = new App();
const config = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
new StorageStack(app, STORAGE_STACK_NAME, config);
