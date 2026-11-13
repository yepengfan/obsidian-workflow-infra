import fs from 'node:fs';
import { App } from 'aws-cdk-lib';
import { CognitoStack, cognitoSchema } from '../infra/cognito-stack.js';
import { storageSchema } from '../infra/storage-config.js';

const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
const settings = cognitoSchema.parse(JSON.parse(fs.readFileSync('config/cognito.json', 'utf8')));
new CognitoStack(new App(), 'ObsidianMcp', aws, settings);
