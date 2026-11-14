import { mcpResources } from '../infra/mcp-resources.js';
import { githubSchema } from '../infra/github-stack.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { storageSchema } from '../infra/storage-config.js';
import { bundleSchema, publishCode, validateCode } from './runtime-package.js';
import { deployedCode, requireCurrentMain } from './code-deployment-state.js';
import { protectionTags, protectRelease, releaseRollback } from '../src/artifact-retention.js';

try {
  const directory = process.argv[2];
  const source = process.env.SOURCE_SHA;
  if (!directory || !source || !/^[a-f0-9]{40}$/u.test(source)) throw Error('Verified source and artifact directory required');
  const aws = storageSchema.parse(JSON.parse(await fs.readFile('config/storage.json', 'utf8')));
  const github = githubSchema.parse(JSON.parse(await fs.readFile('config/github.json', 'utf8')));
  const deployment = mcpResources(aws, github.runtimeRoleName);
  const template = JSON.parse(await fs.readFile(path.join(directory, 'ObsidianMcp.template.json'), 'utf8'));
  const bucket = template.Resources.CodeArtifacts.Properties.BucketName;
  // The exact reviewed native template is downloaded from this run's Plan artifact.
  if (bucket !== deployment.codeBucketName) throw Error('Unexpected code bucket');
  const metadata = bundleSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'CodeBundle.json'), 'utf8')));
  if (template.Resources.McpFunction.Properties.Code.S3Key !== metadata.key) throw Error('Code key differs from the reviewed template');
  const bytes = await fs.readFile(path.join(directory, 'CodeBundle.zip'));
  validateCode(metadata, bytes, source);
  requireCurrentMain();
  if (source !== process.env.GITHUB_SHA) throw Error('Artifact source is not current main');
  const current = deployedCode({ ...aws, ...deployment });
  const client = new S3Client({ region: aws.region, maxAttempts: 2 });
  try {
    const prior = await releaseRollback(client, bucket, metadata.key, current.key);
    const head = await publishCode(client, bucket, metadata, bytes, source, protectionTags(prior));
    if (!head.VersionId) throw Error('Versioned code object required');
    requireCurrentMain();
    await protectRelease(client, bucket, metadata.key, prior, head.VersionId);
  } finally { client.destroy(); }
  console.log('Immutable code artifact uploaded and checksum verified.');
} catch {
  console.error('Code artifact publication failed. No infrastructure change set was executed by this command. Inspect the approved run before retrying.');
  process.exitCode = 1;
}
