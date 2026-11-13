import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { needs: string; environment: string; if?: string; permissions: Record<string, string>; steps: Step[] };
const workflow = parse(fs.readFileSync('.github/workflows/deploy-storage.yml', 'utf8')) as { jobs: Record<string, Job> };
const script = (job: string, name: string) => workflow.jobs[job]!.steps.find(step => step.name === name)!.run!;
const sha = 'a'.repeat(40);
const arn = 'arn:aws:cloudformation:ap-southeast-2:391824190072:changeSet/obsidian-mcp-create-456-1/example';
const resources = [
  { LogicalResourceId: 'UserPool', ResourceType: 'AWS::Cognito::UserPool', PhysicalResourceId: 'ap-southeast-2_Example' },
  { LogicalResourceId: 'UserPoolDomain', ResourceType: 'AWS::Cognito::UserPoolDomain', PhysicalResourceId: 'example' },
];
const plan = {
  Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
  StackId: 'arn:aws:cloudformation:ap-southeast-2:391824190072:stack/ObsidianMcp/example',
  Description: `repo=123 sha=${sha} operation=create`,
  Changes: resources.map(({ LogicalResourceId, ResourceType }) => ({ ResourceChange: { Action: 'Add', LogicalResourceId, ResourceType } })),
};

function execute(source: string, fixture: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.resolve('.cognito-workflow-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'config'));
    for (const file of ['storage.json', 'github.json']) fs.copyFileSync(`config/${file}`, path.join(directory, 'config', file));
    if (fixture.pinned) {
      const file = path.join(directory, 'config/github.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mcpUserPoolId: fixture.pinned }));
    }
    const fixtures = path.join(directory, 'fixtures.json');
    fs.writeFileSync(fixtures, JSON.stringify(fixture));
    const log = path.join(directory, 'calls');
    for (const tool of ['aws', 'gh', 'git']) fs.writeFileSync(path.join(directory, tool), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({tool:'${tool}',args})+'\\n');
function respond(key) {
  const value = fixture[key];
  if (value?.error) { console.error(value.error); process.exit(1); }
  console.log(JSON.stringify(value));
}
if ('${tool}' === 'git') { console.log(fixture.head ?? process.env.SOURCE_SHA); process.exit(0); }
if ('${tool}' === 'gh') {
  if (args[1].endsWith('/git/ref/heads/main')) {
    if (fixture.mainError) process.exit(1);
    console.log(fixture.main ?? process.env.SOURCE_SHA);
  } else respond('environment');
  process.exit(0);
}
switch (args[1]) {
  case 'describe-stacks': respond('stack'); break;
  case 'describe-stack-resources': respond('resources'); break;
  case 'create-change-set': console.log(process.env.CHANGE_SET_ARN); break;
  case 'describe-change-set': respond('plan'); break;
  case 'wait': process.exit(args[2] === 'change-set-create-complete' ? (fixture.waitExit ?? 0) : 0); break;
  case 'execute-change-set': case 'update-termination-protection': break;
  default: process.exit(90);
}
`, { mode: 0o700 });
    const output = path.join(directory, 'output'), summary = path.join(directory, 'summary');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', source], { cwd: directory, encoding: 'utf8', env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE: fixtures, CALL_LOG: log,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_REPOSITORY_ID: '123', SOURCE_SHA: sha,
      GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', CHANGE_SET_ARN: arn,
      ACCOUNT: '391824190072', REGION: 'ap-southeast-2', EXPECTED_ACCOUNT: '391824190072', EXPECTED_REGION: 'ap-southeast-2',
      EXECUTION_ROLE: 'arn:aws:iam::391824190072:role/obsidian-mcp-execution', OPERATION: 'create', ...extra,
    } });
    expect(result.error).toBeUndefined();
    const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { status: result.status, stderr: result.stderr, output: read(output), summary: read(summary),
      calls: read(log).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: string[] }) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe('Cognito plan and approved apply', () => {
  it('inherits the guarded main-only storage Plan and preserves separate native approval', () => {
    expect(workflow.jobs['plan-cognito']!.needs).toBe('plan');
    expect(workflow.jobs['plan-cognito']!.environment).toBe('production-plan');
    expect(workflow.jobs['apply-cognito']!.needs).toBe('plan-cognito');
    expect(workflow.jobs['apply-cognito']!.environment).toBe('production');
    expect(workflow.jobs['apply-cognito']!.if).toBe("needs.plan-cognito.outputs.has_changes == 'true'");
    for (const job of ['plan-cognito', 'apply-cognito']) {
      expect(workflow.jobs[job]!.permissions).toEqual({ contents: 'read', actions: 'read', 'id-token': 'write' });
      const checkout = workflow.jobs[job]!.steps.find(step => step.uses?.startsWith('actions/checkout@'))!;
      expect(checkout.with).toEqual({ ref: '${{ github.event.workflow_run.head_sha }}', 'persist-credentials': false });
    }
  });

  it.each(['plan-cognito', 'apply-cognito'])('rejects stale sources and missing reviewer before AWS authentication for %s', job => {
    const revision = script(job, 'Reject an outdated or mismatched verified revision');
    const review = script(job, 'Require native approval protection before AWS authentication');
    expect(execute(revision, { main: 'b'.repeat(40) }).status).not.toBe(0);
    expect(execute(revision, { mainError: true }).status).not.toBe(0);
    expect(execute(review, { environment: { protection_rules: [] } }).status).not.toBe(0);
    const result = execute(revision + '\n' + review, { environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }] } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.every(call => call.tool !== 'aws')).toBe(true);
  });

  it.each([
    { name: 'absent', stack: { error: 'An error occurred (ValidationError): Stack with id ObsidianMcp does not exist' }, operation: 'create' },
    { name: 'placeholder', stack: { Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] }, operation: 'create' },
    { name: 'complete', stack: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }, operation: 'update' },
    { name: 'access denied', stack: { error: '(AccessDenied) not authorized' }, operation: null },
    { name: 'timeout', stack: { error: 'Request timed out' }, operation: null },
    { name: 'rollback failed', stack: { Stacks: [{ StackStatus: 'ROLLBACK_FAILED' }] }, operation: null },
  ])('selects a safe operation for $name', ({ stack, operation }) => {
    const result = execute(script('plan-cognito', 'Select Cognito create or update from actual stack state'), { stack, resources: { StackResources: resources } });
    expect(result.status === 0, result.stderr).toBe(operation !== null);
    expect(result.output).toBe(operation ? `operation=${operation}\n` : '');
  });

  it('refuses replacement when a pinned pool is absent or bound to another stack', () => {
    const source = script('plan-cognito', 'Select Cognito create or update from actual stack state');
    expect(execute(source, { pinned: 'ap-southeast-2_Pinned', stack: { error: '(ValidationError) Stack with id ObsidianMcp does not exist' } }).status).not.toBe(0);
    expect(execute(source, { pinned: 'ap-southeast-2_Pinned', stack: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }, resources: { StackResources: resources } }).status).not.toBe(0);
    expect(execute(source, { stack: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }, resources: { StackResources: [] } }).status).not.toBe(0);
  });

  it.each([
    { operation: 'create', waitExit: 0, native: plan, pass: true, changes: true },
    { operation: 'update', waitExit: 1, native: { Status: 'FAILED', StatusReason: "The submitted information didn't contain changes.", Changes: [] }, pass: true, changes: false },
    { operation: 'create', waitExit: 1, native: { Status: 'FAILED', StatusReason: 'Access denied', Changes: [] }, pass: false, changes: false },
  ])('prepares $operation without executing and handles no-change precisely', ({ operation, waitExit, native, pass, changes }) => {
    const result = execute(script('plan-cognito', 'Create and summarize the unexecuted Cognito plan'), { plan: native, waitExit }, { OPERATION: operation });
    expect(result.status === 0, result.stderr).toBe(pass);
    const create = result.calls.find(call => call.args[1] === 'create-change-set')!.args;
    expect(create).toContain('AWS::Cognito::UserPool');
    expect(create).toContain('AWS::Cognito::UserPoolDomain');
    expect(create).toContain('arn:aws:iam::391824190072:role/obsidian-mcp-execution');
    expect(create).toContain(`repo=123 sha=${sha} operation=${operation}`);
    expect(result.calls.some(call => call.args[1] === 'execute-change-set')).toBe(false);
    if (pass) {
      expect(result.output).toContain(`has_changes=${changes}`);
      expect(result.summary).toContain(arn);
    }
  });

  const inspect = () => script('apply-cognito', 'Inspect the exact reviewed Cognito plan');
  const apply = () => script('apply-cognito', 'Execute the reviewed Cognito change set');
  it('executes only the exact reviewed ARN, protects the stack and waits for creation', () => {
    const result = execute(inspect() + '\n' + apply(), { plan, stack: { Stacks: [{ EnableTerminationProtection: true }] } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(call => call.tool === 'aws').map(call => call.args)).toEqual([
      ['cloudformation', 'describe-change-set', '--change-set-name', arn],
      ['cloudformation', 'update-termination-protection', '--enable-termination-protection', '--stack-name', 'ObsidianMcp'],
      ['cloudformation', 'execute-change-set', '--change-set-name', arn],
      ['cloudformation', 'wait', 'stack-create-complete', '--stack-name', 'ObsidianMcp'],
      ['cloudformation', 'describe-stacks', '--stack-name', 'ObsidianMcp'],
    ]);
  });

  it('uses UPDATE and its waiter for a non-replacing modification', () => {
    const updated = { ...plan, Description: `repo=123 sha=${sha} operation=update`,
      Changes: [{ ResourceChange: { Action: 'Modify', LogicalResourceId: 'UserPool', ResourceType: 'AWS::Cognito::UserPool', Replacement: 'False' } }] };
    const updateArn = arn.replace('-create-', '-update-');
    const result = execute(inspect() + '\n' + apply(), { plan: updated, stack: { Stacks: [{ EnableTerminationProtection: true }] } }, { OPERATION: 'update', CHANGE_SET_ARN: updateArn });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.find(call => call.args[1] === 'execute-change-set')!.args).toContain(updateArn);
    expect(result.calls.find(call => call.args[1] === 'wait')!.args).toContain('stack-update-complete');
  });

  it.each([
    { name: 'different source', patch: { Description: 'wrong source' } },
    { name: 'executed plan', patch: { ExecutionStatus: 'EXECUTE_COMPLETE' } },
    { name: 'wrong stack', patch: { StackId: plan.StackId.replace('ObsidianMcp', 'Other') } },
    { name: 'replacement', patch: { Changes: [{ ResourceChange: { ...plan.Changes[0]!.ResourceChange, Replacement: 'True' } }] } },
    { name: 'removal', patch: { Changes: [{ ResourceChange: { ...plan.Changes[0]!.ResourceChange, Action: 'Remove' } }] } },
    { name: 'IAM resource', patch: { Changes: [{ ResourceChange: { Action: 'Add', LogicalResourceId: 'Admin', ResourceType: 'AWS::IAM::Role' } }] } },
  ])('blocks $name without execution', ({ patch }) => {
    const result = execute(inspect() + '\n' + apply(), { plan: { ...plan, ...patch } });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(call => call.args[1] === 'execute-change-set')).toBe(false);
  });

  it('blocks execution if main advances after approval', () => {
    const result = execute(inspect() + '\n' + apply(), { plan, main: 'b'.repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.calls.some(call => call.args[1] === 'execute-change-set')).toBe(false);
  });
});
