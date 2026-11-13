import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; id?: string; run?: string };
const workflow = parse(fs.readFileSync('.github/workflows/deploy-storage.yml', 'utf8')) as {
  on: { workflow_run: { workflows: string[]; branches: string[]; types: string[] } };
  jobs: { plan: { steps: Step[] }; apply: { needs: string; environment: string; steps: Step[] } };
};
const step = (name: string) => workflow.jobs.plan.steps.find(s => s.name === name)!.run!;
function execute(script: string, fixture: Record<string, unknown>, extra: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.resolve('.deployment-test-'));
  const callLog = path.join(directory, 'calls');
  const output = path.join(directory, 'output');
  const summary = path.join(directory, 'summary');
  fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(fixture));
  fs.mkdirSync(path.join(directory, 'config'));
  fs.copyFileSync('config/import-resources.json', path.join(directory, 'config/import-resources.json'));
  for (const tool of ['aws', 'gh']) {
    fs.writeFileSync(path.join(directory, tool), `#!/bin/bash
printf '%s %s\\n' '${tool}' "$*" >> "$CALL_LOG"
case "$*" in
  'cloudformation describe-stacks '*) key=stack ;;
  'cloudformation describe-stack-resources '*) key=resources ;;
  'cloudformation create-change-set '*) printf '%s\\n' 'arn:reviewed-plan'; exit 0 ;;
  'cloudformation wait '*) exit "$(jq -r '.waitExit // 0' fixture.json)" ;;
  'cloudformation describe-change-set '*) key=plan ;;
  api*) key=environment ;;
  *) exit 90 ;;
esac
error=$(jq -r --arg key "$key" '.[$key].error // empty' fixture.json)
if [[ -n "$error" ]]; then printf '%s\\n' "$error" >&2; exit 1; fi
jq --arg key "$key" '.[$key]' fixture.json
`, { mode: 0o700 });
  }
  try {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: directory, encoding: 'utf8', env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: callLog,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: 'owner/repo', GITHUB_REPOSITORY_OWNER: 'owner',
        GITHUB_REPOSITORY_ID: '123', SOURCE_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', EXECUTION_ROLE: 'fixed-execution-role',
        ACCOUNT: '391824190072', REGION: 'ap-southeast-2', ...extra,
      },
    });
    expect(result.error).toBeUndefined();
    const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { status: result.status, stderr: result.stderr, calls: read(callLog), output: read(output), summary: read(summary) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const mapping = JSON.parse(fs.readFileSync('config/import-resources.json', 'utf8')) as {
  LogicalResourceId: string; ResourceIdentifier: { BucketName: string };
}[];
const resources = { StackResources: mapping.map(r => ({
  LogicalResourceId: r.LogicalResourceId, ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: r.ResourceIdentifier.BucketName,
})) };

describe('automatic storage deployment', () => {
  it('uses completed main CI and native production approval, connecting Apply to Plan', () => {
    expect(workflow.on.workflow_run).toEqual({ workflows: ['CI'], branches: ['main'], types: ['completed'] });
    expect(workflow.jobs.apply.needs).toBe('plan');
    expect(workflow.jobs.apply.environment).toBe('production');
  });

  it.each([
    { name: 'owner is required', rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }], pass: true },
    { name: 'only branch restrictions', rules: [{ type: 'branch_policy' }], pass: false },
    { name: 'different reviewer', rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'other' } }] }], pass: false },
    { name: 'no rules', rules: [], pass: false },
  ])('requires the actual approval configuration when $name', ({ rules, pass }) => {
    const result = execute(step('Require native approval protection before AWS authentication'), { environment: { protection_rules: rules } });
    expect(result.status === 0).toBe(pass);
    expect(result.calls.trim()).toBe('gh api repos/owner/repo/environments/production');
  });

  it.each([
    { name: 'absent stack', stack: { error: 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ObsidianWorkflowStorage does not exist' }, operation: 'import' },
    { name: 'unexecuted first plan', stack: { Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] }, operation: 'import' },
    ...['IMPORT_COMPLETE', 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].map(status => ({ name: status, stack: { Stacks: [{ StackStatus: status }] }, operation: 'update' })),
    { name: 'access denied', stack: { error: 'An error occurred (AccessDenied) when calling the DescribeStacks operation' }, operation: null },
    { name: 'API timeout', stack: { error: 'Request timed out' }, operation: null },
    { name: 'import in progress', stack: { Stacks: [{ StackStatus: 'IMPORT_IN_PROGRESS' }] }, operation: null },
    { name: 'rollback failure', stack: { Stacks: [{ StackStatus: 'ROLLBACK_FAILED' }] }, operation: null },
  ])('selects the operation safely for $name', ({ stack, operation }) => {
    const result = execute(step('Select import or update from actual stack state'), { stack, resources });
    expect(result.status === 0).toBe(operation !== null);
    expect(result.output).toBe(operation ? `operation=${operation}\n` : '');
  });

  it('rejects an existing stack bound to a different bucket', () => {
    const wrong = structuredClone(resources);
    wrong.StackResources[0]!.PhysicalResourceId = 'unexpected-bucket';
    const result = execute(step('Select import or update from actual stack state'), { stack: { Stacks: [{ StackStatus: 'IMPORT_COMPLETE' }] }, resources: wrong });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it.each([
    { name: 'import plan', operation: 'import', waitExit: 0, reason: '', status: 'CREATE_COMPLETE', pass: true, changes: true },
    { name: 'unchanged update', operation: 'update', waitExit: 1, reason: "The submitted information didn't contain changes. Submit different information to create a change set.", status: 'FAILED', pass: true, changes: false },
    { name: 'validation failure', operation: 'update', waitExit: 1, reason: 'The submitted information did not satisfy resource constraints', status: 'FAILED', pass: false, changes: false },
    { name: 'failed import', operation: 'import', waitExit: 1, reason: "The submitted information didn't contain changes.", status: 'FAILED', pass: false, changes: false },
  ])('publishes the actual plan and only tolerates an unchanged update for $name', ({ operation, waitExit, reason, status, pass, changes }) => {
    const result = execute(step('Create and summarize the unexecuted native plan'), { waitExit, plan: { Status: status, StatusReason: reason, Changes: changes ? [{ ResourceChange: { Action: 'Import', LogicalResourceId: 'Vault', ResourceType: 'AWS::S3::Bucket' } }] : [] } }, { OPERATION: operation });
    expect(result.status === 0).toBe(pass);
    expect(result.calls).not.toContain('execute-change-set');
    expect(result.calls).toContain(`--change-set-type ${operation.toUpperCase()}`);
    expect(result.calls).toContain(`repo=123 sha=${'a'.repeat(40)} operation=${operation}`);
    if (pass) {
      expect(result.output).toContain(`has_changes=${changes}\n`);
      expect(result.summary).toContain('arn:reviewed-plan');
      expect(result.summary).toContain('obsidian-vault-sync-391824190072');
      if (changes) expect(result.summary).toContain('| Import | Vault | AWS::S3::Bucket | n/a |');
      else expect(result.summary).toContain('Apply is skipped');
    } else expect(result.summary).toBe('');
  });
});
