import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each([
  { stage: 'identity', resources: 2 },
  { stage: 'code-storage', resources: 4 },
  { stage: 'runtime', resources: 17 },
])('synthesizes the $stage stage through the public command', ({ stage, resources }) => {
  const directory = fs.mkdtempSync(path.resolve('.infrastructure-entrypoint-test-'));
  try {
    const assembly = path.join(directory, 'cdk.out');
    fs.cpSync('config', path.join(directory, 'config'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'config/mcp-deployment.json'), JSON.stringify({ stage }));
    for (const file of ['package.json', 'cdk.json', '.nvmrc']) fs.copyFileSync(file, path.join(directory, file));
    for (const name of ['node_modules', 'bin', 'infra', 'src']) fs.symlinkSync(path.resolve(name), path.join(directory, name));
    const result = spawnSync('npm', ['run', 'synth', '--', '--output', assembly, '--quiet'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(assembly, 'manifest.json'), 'utf8'));
    const stacks = Object.entries(manifest.artifacts as Record<string, { type: string }>)
      .filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack').map(([name]) => name).sort();
    expect(stacks).toEqual(['ObsidianGitHubTrust', 'ObsidianMcp', 'ObsidianWorkflowStorage']);
    const template = (stack: string) => JSON.parse(fs.readFileSync(path.join(assembly, `${stack}.template.json`), 'utf8'));
    expect(Object.keys(template('ObsidianWorkflowStorage').Resources).sort()).toEqual(['Library', 'Vault']);
    expect(Object.keys(template('ObsidianMcp').Resources)).toHaveLength(resources);
    expect(template('ObsidianMcp').Metadata.McpDeploymentStage).toBe(stage);
    expect(template('ObsidianMcp').Outputs.PermissionPoolArn.Export.Name).toBe('ObsidianMcp:UserPoolArn');
    if (stage === 'runtime') {
      expect(template('ObsidianMcp').Resources.McpFunction.Properties.Code.S3Key).toMatch(/^releases\/[a-f0-9]{64}\.zip$/u);
      expect(fs.statSync(path.join(assembly, 'CodeBundle.zip')).size).toBeGreaterThan(0);
    } else {
      expect(fs.existsSync(path.join(assembly, 'CodeBundle.zip'))).toBe(false);
      expect(fs.existsSync(path.join(assembly, 'CodeBundle.json'))).toBe(false);
    }
    const ci = parse(fs.readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: { verify: { steps: { name?: string; run?: string }[] } } };
    const preview = ci.jobs.verify.steps.find(step => step.name === 'Publish the offline infrastructure preview in the run summary')!.run!;
    const summary = path.join(directory, 'summary.md');
    const rendered = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', preview], { cwd: directory, encoding: 'utf8',
      env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true', GITHUB_SHA: 'verified-source', GITHUB_STEP_SUMMARY: summary } });
    expect(rendered.status, rendered.stderr).toBe(0);
    const output = fs.readFileSync(summary, 'utf8');
    for (const stack of stacks) expect(output).toContain(stack);
    expect(output).toContain('verified-source');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
