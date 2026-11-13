import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; env?: Record<string, string>; run?: string };
const workflow = parse(fs.readFileSync('.github/workflows/apply-storage.yml', 'utf8')) as {
  jobs: { apply: { permissions: Record<string, string>; steps: Step[] } };
};
const execute = workflow.jobs.apply.steps.find((step) => step.name === 'Execute that existing change set without resynthesizing')!;

describe('Apply execution workflow', () => {
  it('supplies a read-only repository token to the execution step', () => {
    expect(workflow.jobs.apply.permissions.contents).toBe('read');
    expect(execute.env?.GH_TOKEN).toBe('${{ github.token }}');
  });

  it.each([
    { name: 'current main', live: 'a'.repeat(40), apiStatus: 0, succeeds: true },
    { name: 'main advanced while queued or before a rerun', live: 'b'.repeat(40), apiStatus: 0, succeeds: false },
    { name: 'GitHub API failure', live: '', apiStatus: 1, succeeds: false },
    { name: 'missing main SHA', live: '', apiStatus: 0, succeeds: false },
  ])('only executes the reviewed plan on $name', ({ live, apiStatus, succeeds }) => {
    const directory = fs.mkdtempSync(path.resolve('.apply-workflow-test-'));
    try {
      fs.writeFileSync(path.join(directory, 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
printf '%s\\n' "$LIVE_MAIN_SHA"
exit "$API_STATUS"
`, { mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'aws'), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALL_LOG"
`, { mode: 0o700 });
      const log = path.join(directory, 'calls');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', execute.run!], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log,
          LIVE_MAIN_SHA: live, API_STATUS: String(apiStatus), GITHUB_SHA: 'a'.repeat(40),
          GITHUB_REPOSITORY: 'owner/repository', CHANGE_SET_ARN: 'reviewed-arn', OPERATION: 'import',
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0).toBe(succeeds);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(calls).toEqual([
        'api repos/owner/repository/git/ref/heads/main --jq .object.sha',
        ...(succeeds ? [
          'cloudformation execute-change-set --change-set-name reviewed-arn',
          'cloudformation wait stack-import-complete --stack-name ObsidianWorkflowStorage',
          'cloudformation update-termination-protection --enable-termination-protection --stack-name ObsidianWorkflowStorage',
          'cloudformation describe-stack-resources --stack-name ObsidianWorkflowStorage',
        ] : []),
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
