import { spawnSync } from 'node:child_process';
import { releaseKey, type DeploymentState } from '../src/artifact-retention.js';

export function awsJson(args: string[], allowMissingFunction = false): unknown {
  const result = spawnSync('aws', [...args, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', timeout: 15_000,
    maxBuffer: 1024 * 1024, env: { ...process.env, AWS_PAGER: '' } });
  if (result.error || result.status !== 0) {
    if (allowMissingFunction && !result.error && result.stderr.includes('(ResourceNotFoundException)')) return null;
    throw Error('AWS metadata read failed');
  }
  return JSON.parse(result.stdout);
}
export function requireCurrentMain() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? '')) throw Error('Trusted main workflow required');
  const result = spawnSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/main`, '--jq', '.object.sha'], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0 || result.stdout.trim() !== process.env.GITHUB_SHA) throw Error('Outdated retention revision');
}
type Inputs = { account: string; region: string; codeBucketName: string; functionName: string };
export function deployedCode(input: Inputs): DeploymentState {
  const args = ['--region', input.region];
  const stack = awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'ObsidianMcp', '--query', 'Stacks[0]', ...args]) as { StackId: string; StackStatus: string; LastUpdatedTime?: string; CreationTime: string };
  if (!stack.StackId?.startsWith(`arn:aws:cloudformation:${input.region}:${input.account}:stack/ObsidianMcp/`) ||
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE'].includes(stack.StackStatus)) throw Error('MCP stack is not stable');
  let template = awsJson(['cloudformation', 'get-template', '--stack-name', 'ObsidianMcp', '--template-stage', 'Original', '--query', 'TemplateBody', ...args]);
  if (typeof template === 'string') template = JSON.parse(template);
  const model = template as { Resources: Record<string, { Properties: Record<string, unknown> }> };
  if (model.Resources.CodeArtifacts?.Properties.BucketName !== input.codeBucketName) throw Error('Code bucket binding mismatch');
  const fn = model.Resources.McpFunction?.Properties;
  const config = awsJson(['lambda', 'get-function-configuration', '--function-name', input.functionName, '--query', '{hash:CodeSha256,state:State,updated:LastUpdateStatus}', ...args], true) as { hash: string; state: string; updated: string } | null;
  let key: string | null = null;
  if (fn) {
    const code = fn.Code as { S3Bucket?: unknown; S3Key?: unknown };
    key = releaseKey.parse(code.S3Key);
    if (fn.FunctionName !== input.functionName || JSON.stringify(code.S3Bucket) !== JSON.stringify({ Ref: 'CodeArtifacts' }) ||
        !config || config.state !== 'Active' || config.updated !== 'Successful' ||
        config.hash !== Buffer.from(key.slice(9, -4), 'hex').toString('base64')) throw Error('Native function code does not match the managed template');
  } else if (config) throw Error('Unmanaged retained function requires inspection');
  return { key, revision: JSON.stringify([stack.StackId, stack.LastUpdatedTime ?? stack.CreationTime, key, config?.hash]) };
}
