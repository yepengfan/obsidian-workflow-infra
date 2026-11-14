import fs from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { storageSchema } from '../infra/storage-config.js';
import { githubSchema } from '../infra/github-stack.js';
import { mcpResources } from '../infra/mcp-resources.js';
import { retainCode } from '../src/artifact-retention.js';
import { awsJson, deployedCode, requireCurrentMain } from './code-deployment-state.js';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--apply', '--dry-run'].includes(arg))) throw Error('Use --dry-run or --apply');
  const apply = args[0] === '--apply';
  const aws = storageSchema.parse(JSON.parse(fs.readFileSync('config/storage.json', 'utf8')));
  const github = githubSchema.parse(JSON.parse(fs.readFileSync('config/github.json', 'utf8')));
  const deployment = { ...aws, ...mcpResources(aws, github.runtimeRoleName) };
  const identity = awsJson(['sts', 'get-caller-identity']) as { Account: string; Arn: string };
  if (identity.Account !== aws.account) throw Error('Wrong AWS account');
  if (apply) {
    requireCurrentMain();
    if (!identity.Arn.startsWith(`arn:aws:sts::${aws.account}:assumed-role/${github.codeRetentionRoleName}/`)) throw Error('Dedicated code-retention role required');
  }
  const client = new S3Client({ region: aws.region, maxAttempts: 2 });
  try {
    const receipt = await retainCode(client, async () => {
      if (apply) requireCurrentMain();
      return deployedCode(deployment);
    }, { bucket: deployment.codeBucketName, policy: aws.retention, apply,
      report: value => fs.writeFileSync('code-retention-result.json', JSON.stringify(value, null, 2) + '\n') });
    const output = JSON.stringify(receipt, null, 2);
    fs.writeFileSync('code-retention-result.json', output + '\n');
    console.log(output);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Code artifact retention\n\n${aws.retention.unusedCodeDays}-day unused window; deployed and rollback keys protected. Mode: ${apply ? 'apply' : 'dry-run'}.\n\n\`\`\`json\n${output}\n\`\`\`\n\nDelete markers and unclassified objects are reported, not deleted.\n`);
  } finally { client.destroy(); }
} catch {
  console.error('Code retention stopped. Inspect the run and AWS before retrying; earlier code-version operations may have completed. No note bucket was accessed.');
  process.exitCode = 1;
}
