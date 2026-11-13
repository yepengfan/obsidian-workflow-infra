import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each([
  { entry: 'storage', stack: 'ObsidianWorkflowStorage', type: 'AWS::S3::Bucket', count: 2 },
  { entry: 'github', stack: 'ObsidianGitHubTrust', type: 'AWS::IAM::OIDCProvider', count: 1 },
  { entry: 'cognito', stack: 'ObsidianMcp', type: 'AWS::Cognito::UserPool', count: 1 },
])('synthesizes $entry from the fixed versioned configuration', ({ entry, stack, type, count }) => {
  const directory = fs.mkdtempSync(path.resolve('.entrypoint-test-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', `bin/${entry}.ts`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CDK_OUTDIR: directory,
        CDK_CONTEXT_JSON: JSON.stringify({ storageConfig: 'missing-storage.json', githubConfig: 'missing-github.json' }),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const template = JSON.parse(fs.readFileSync(path.join(directory, `${stack}.template.json`), 'utf8')) as {
      Resources: Record<string, { Type: string }>; Parameters?: Record<string, unknown>; Rules?: Record<string, unknown>;
    };
    expect(Object.values(template.Resources).filter((resource) => resource.Type === type)).toHaveLength(count);
    expect(Buffer.byteLength(JSON.stringify(template))).toBeLessThanOrEqual(51_200);
    expect(template.Parameters).toBeUndefined();
    expect(template.Rules).toBeUndefined();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
