import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { needs?: string; if?: string; environment: string; permissions: Record<string, string>; steps: Step[] };
const workflow = parse(fs.readFileSync('.github/workflows/plan-and-apply.yml', 'utf8')) as {
  name: string; on: { workflow_run: unknown }; jobs: Record<string, Job>;
};
const source = 'a'.repeat(40), account = '391824190072', region = 'ap-southeast-2';
const storage = 'ObsidianWorkflowStorage', cognito = 'ObsidianMcp';
const arn = (stack: string, operation: string) => `arn:aws:cloudformation:${region}:${account}:changeSet/${stack === storage ? 'obsidian-storage' : 'obsidian-mcp'}-${operation}-456-1/example`;
const resources = {
  storage: JSON.parse(fs.readFileSync('config/import-resources.json', 'utf8')).map((r: { LogicalResourceId: string; ResourceType: string; ResourceIdentifier: { BucketName: string } }) => ({ LogicalResourceId: r.LogicalResourceId, ResourceType: r.ResourceType, PhysicalResourceId: r.ResourceIdentifier.BucketName })),
  cognito: [{ LogicalResourceId: 'UserPool', ResourceType: 'AWS::Cognito::UserPool', PhysicalResourceId: `${region}_Example` }, { LogicalResourceId: 'UserPoolDomain', ResourceType: 'AWS::Cognito::UserPoolDomain', PhysicalResourceId: 'example' }],
};
const nativePlan = (stack: string, operation: string) => ({
  Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
  StackId: `arn:aws:cloudformation:${region}:${account}:stack/${stack}/example`,
  Description: `repo=123 sha=${source} operation=${operation}`,
  Changes: (stack === storage ? resources.storage : resources.cognito).map(({ LogicalResourceId, ResourceType }: { LogicalResourceId: string; ResourceType: string }) => ({ ResourceChange: {
    Action: operation === 'import' ? 'Import' : operation === 'create' ? 'Add' : 'Modify', LogicalResourceId, ResourceType, Replacement: 'False',
  } })),
});
const manifest = () => ({ schemaVersion: 1, sourceSha: source, repositoryId: '123', account, region, stacks: [
  { name: storage, operation: 'update', arn: arn(storage, 'update'), hasChanges: true },
  { name: cognito, operation: 'create', arn: arn(cognito, 'create'), hasChanges: true },
] });
type StackState = { Stacks: { StackStatus: string; EnableTerminationProtection?: boolean }[] } | { error: string };
const defaults = () => ({
  storage: { stack: { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', EnableTerminationProtection: true }] } as StackState, resources: { StackResources: structuredClone(resources.storage) }, plan: nativePlan(storage, 'update'), waitExit: 0 },
  cognito: { stack: { error: '(ValidationError) Stack with id ObsidianMcp does not exist' } as StackState, resources: { StackResources: structuredClone(resources.cognito) }, plan: nativePlan(cognito, 'create'), waitExit: 0 },
});
const step = (job: string, name: string) => workflow.jobs[job]!.steps.find(s => s.name === name)!.run!;
type Call = { tool: string; args: string[] };
function execute(script: string, fixture: Record<string, unknown> = {}, plan = manifest()) {
  const dir = fs.mkdtempSync(path.resolve('.infrastructure-deployment-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'config'));
    for (const file of ['storage.json', 'github.json', 'import-resources.json']) fs.copyFileSync(`config/${file}`, path.join(dir, 'config', file));
    if (fixture.pinned) {
      const file = path.join(dir, 'config/github.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mcpUserPoolId: fixture.pinned }));
    }
    fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ ...defaults(), ...fixture }));
    fs.writeFileSync(path.join(dir, 'infrastructure-plan.json'), JSON.stringify(plan));
    for (const tool of ['aws', 'gh', 'git', 'npm', 'sleep']) fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), fixture = JSON.parse(fs.readFileSync('fixture.json','utf8'));
const calls = fs.existsSync('calls') ? fs.readFileSync('calls','utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
fs.appendFileSync('calls',JSON.stringify({tool:'${tool}',args})+'\\n');
const value = flag => args[args.indexOf(flag)+1];
function respond(result) { if(result?.error) { console.error(result.error);process.exit(1); } console.log(JSON.stringify(result)); }
if('${tool}'==='git') { console.log(fixture.head ?? process.env.SOURCE_SHA); process.exit(0); }
if('${tool}'==='sleep') process.exit(0);
if('${tool}'==='npm') process.exit(fixture.discoveryExit ?? 0);
if('${tool}'==='gh') {
  if(args[1].endsWith('/git/ref/heads/main')) {
    if(fixture.mainError) process.exit(1);
    const count = calls.filter(c=>c.tool==='gh').length;
    console.log(fixture.advanceAfterFirst && count>0 ? 'b'.repeat(40) : (fixture.main ?? process.env.SOURCE_SHA));
  } else respond(fixture.environment);
  process.exit(0);
}
const target = (value('--stack-name') ?? value('--change-set-name') ?? '').includes('ObsidianMcp') || args.join(' ').includes('obsidian-mcp-') ? 'cognito' : 'storage';
const item=fixture[target];
switch(args[1]) {
  case 'describe-stacks': {
    const executed=calls.some(c=>c.tool==='aws' && c.args[1]==='execute-change-set' && c.args.join(' ').includes(target==='cognito'?'obsidian-mcp-':'obsidian-storage-'));
    respond(executed ? {Stacks:[{StackStatus:'UPDATE_COMPLETE',EnableTerminationProtection:true}]} : item.stack);break;
  }
  case 'describe-stack-resources':respond(item.resources);break;
  case 'create-change-set':console.log('arn:aws:cloudformation:ap-southeast-2:391824190072:changeSet/'+value('--change-set-name')+'/example');break;
  case 'describe-change-set':respond(item.plan);break;
  case 'wait':process.exit(args[2]==='change-set-create-complete'?(item.waitExit??0):(item.applyWaitExit??0));break;
  case 'execute-change-set':case 'update-termination-protection':break;
  case 'detect-stack-drift':console.log('drift-id');break;
  case 'describe-stack-drift-detection-status':respond(fixture.drift??{DetectionStatus:'DETECTION_COMPLETE',StackDriftStatus:'IN_SYNC'});break;
  default:process.exit(90);
}
`, { mode: 0o700 });
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, ACCOUNT: account, REGION: region, SOURCE_SHA: source,
      STORAGE_EXECUTION_ROLE: `arn:aws:iam::${account}:role/obsidian-workflow-storage-execution`,
      MCP_EXECUTION_ROLE: `arn:aws:iam::${account}:role/obsidian-mcp-execution`,
      GITHUB_REPOSITORY_ID: '123', GITHUB_REPOSITORY: 'owner/repo', GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_OUTPUT: path.join(dir, 'output'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    } });
    expect(result.error).toBeUndefined();
    const read = (file: string) => fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
    return { status: result.status, stderr: result.stderr, calls: read('calls').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call), output: read('output'), summary: read('summary'), plan: JSON.parse(read('infrastructure-plan.json')) as ReturnType<typeof manifest> };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const planScript = `bash ${JSON.stringify(path.resolve('bin/plan-infrastructure.sh'))}`;
const applyScript = `bash ${JSON.stringify(path.resolve('bin/apply-infrastructure.sh'))}`;
const executions = (calls: Call[]) => calls.filter(c => c.tool === 'aws' && c.args[1] === 'execute-change-set');

describe('one infrastructure plan and approval', () => {
  it('has one shared Plan and one native approval/apply for the whole infrastructure', () => {
    expect(workflow.name).toBe('plan and apply');
    expect(workflow.on.workflow_run).toEqual({ workflows: ['validate'], branches: ['main'], types: ['completed'] });
    expect(Object.keys(workflow.jobs).sort()).toEqual(['apply', 'plan']);
    expect(workflow.jobs.apply!.needs).toBe('plan');
    expect(workflow.jobs.apply!.environment).toBe('production');
    expect(workflow.jobs.apply!.if).toBe("needs.plan.outputs.has_changes == 'true'");
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: 'read', actions: 'read', 'id-token': 'write' });
      expect(job.steps.find(s => s.uses?.startsWith('actions/checkout@'))!.with).toEqual({ ref: '${{ github.event.workflow_run.head_sha }}', 'persist-credentials': false });
    }
    expect(workflow.jobs.plan!.steps.filter(s => s.run === 'npm run synth')).toHaveLength(1);
  });
  it.each(['plan', 'apply'])('keeps stale-source and native-reviewer guards before authentication for %s', job => {
    const revision = step(job, 'Reject an outdated or mismatched verified revision');
    const approval = step(job, 'Require native approval protection before AWS authentication');
    expect(execute(revision, { main: 'b'.repeat(40) }).status).not.toBe(0);
    expect(execute(revision, { mainError: true }).status).not.toBe(0);
    expect(execute(approval, { environment: { protection_rules: [] } }).status).not.toBe(0);
    const result = execute(revision + '\n' + approval, { environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'owner' } }] }] } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(c => c.tool === 'aws')).toBe(false);
  });
  it('produces one source-bound plan containing every deployment stack without executing', () => {
    const result = execute(planScript);
    expect(result.status, result.stderr).toBe(0);
    expect(result.plan.stacks.map(s => s.name)).toEqual([storage, cognito]);
    expect(result.output).toContain('has_changes=true');
    expect(result.summary).toContain(storage); expect(result.summary).toContain(cognito);
    for (const bucket of resources.storage) expect(result.summary).toContain(bucket.PhysicalResourceId);
    expect(executions(result.calls)).toEqual([]);
    const creates = result.calls.filter(c => c.args[1] === 'create-change-set');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.args).toContain('AWS::S3::Bucket'); expect(creates[1]!.args).toContain('AWS::Cognito::UserPool');
    expect(creates[0]!.args).toContain('file://cdk.out/ObsidianWorkflowStorage.template.json');
    expect(creates[1]!.args).toContain(`repo=123 sha=${source} operation=create`);
  });
  it.each(['absent', 'placeholder'])('imports original storage and creates identity on %s state', kind => {
    const fixture = defaults();
    for (const [key, stack] of [['storage', storage], ['cognito', cognito]] as const) fixture[key].stack = kind === 'absent' ? { error: `(ValidationError) Stack with id ${stack} does not exist` } as typeof fixture[typeof key]['stack'] : { Stacks: [{ StackStatus: 'REVIEW_IN_PROGRESS' }] } as typeof fixture[typeof key]['stack'];
    fixture.storage.plan = nativePlan(storage, 'import');
    const result = execute(planScript, fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.plan.stacks.map(s => s.operation)).toEqual(['import', 'create']);
    expect(result.calls.find(c => c.args[1] === 'create-change-set')!.args).toContain('file://config/import-resources.json');
  });
  it.each(['access denied', 'timeout', 'wrong bucket', 'wrong pool', 'failed state'])('fails the entire Plan on %s', kind => {
    const fixture = defaults();
    if (kind === 'access denied' || kind === 'timeout') fixture.cognito.stack = { error: kind };
    if (kind === 'wrong bucket') fixture.storage.resources.StackResources[0]!.PhysicalResourceId = 'wrong-bucket';
    if (kind === 'wrong pool') { fixture.cognito.stack = { Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] } as typeof fixture.cognito.stack; fixture.cognito.resources.StackResources = []; }
    if (kind === 'failed state') fixture.storage.stack = { Stacks: [{ StackStatus: 'ROLLBACK_FAILED' }] };
    const result = execute(planScript, fixture);
    expect(result.status).not.toBe(0); expect(result.output).toBe(''); expect(executions(result.calls)).toEqual([]);
  });
  it('refuses pinned pool recreation or rebinding', () => {
    expect(execute(planScript, { pinned: `${region}_Pinned` }).status).not.toBe(0);
    const fixture = defaults(); fixture.cognito.stack = { Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] } as typeof fixture.cognito.stack;
    expect(execute(planScript, { ...fixture, pinned: `${region}_Pinned` }).status).not.toBe(0);
  });
  it('skips approval only when every native UPDATE is unchanged', () => {
    const fixture = defaults();
    fixture.cognito.stack = { Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] } as typeof fixture.cognito.stack;
    for (const key of ['storage', 'cognito'] as const) { fixture[key].waitExit = 1; fixture[key].plan = { Status: 'FAILED', StatusReason: "The submitted information didn't contain changes.", Changes: [] } as unknown as typeof fixture[typeof key]['plan']; }
    const result = execute(planScript, fixture);
    expect(result.status, result.stderr).toBe(0); expect(result.output).toContain('has_changes=false');
    expect(result.plan.stacks.every(s => !s.hasChanges)).toBe(true);
  });
  it('does not treat a native plan permission failure as no changes', () => {
    const fixture = defaults(); fixture.storage.waitExit = 1;
    fixture.storage.plan = { Status: 'FAILED', StatusReason: 'Access denied', Changes: [] } as unknown as typeof fixture.storage.plan;
    const result = execute(planScript, fixture); expect(result.status).not.toBe(0); expect(result.output).toBe('');
  });
  it('validates all changed plans before executing their exact ARNs and correct waiters', () => {
    const result = execute(applyScript); expect(result.status, result.stderr).toBe(0);
    expect(executions(result.calls).map(c => c.args.at(-1))).toEqual(manifest().stacks.map(s => s.arn));
    const first = result.calls.findIndex(c => c.args[1] === 'execute-change-set');
    expect(result.calls.slice(0, first).filter(c => c.args[1] === 'describe-change-set')).toHaveLength(2);
    expect(result.calls.filter(c => c.args[1] === 'wait').map(c => c.args[2])).toEqual(['stack-update-complete', 'stack-create-complete']);
    expect(result.calls.some(c => c.args[1] === 'detect-stack-drift')).toBe(true);
  });
  it('preserves first adoption as IMPORT of the original buckets', () => {
    const plan = manifest(); plan.stacks[0]!.operation = 'import'; plan.stacks[0]!.arn = arn(storage, 'import');
    const fixture = defaults(); fixture.storage.plan = nativePlan(storage, 'import');
    const result = execute(applyScript, fixture, plan); expect(result.status, result.stderr).toBe(0);
    expect(executions(result.calls)[0]!.args.at(-1)).toBe(arn(storage, 'import'));
    expect(result.calls.find(c => c.args[1] === 'wait')!.args[2]).toBe('stack-import-complete');
  });
  it('rejects attempts to create a new S3 bucket before any stack executes', () => {
    const fixture = defaults(); fixture.storage.plan.Changes[0]!.ResourceChange.Action = 'Add';
    const result = execute(applyScript, fixture); expect(result.status).not.toBe(0); expect(executions(result.calls)).toEqual([]);
  });
  it.each(['source', 'stack', 'status', 'replacement', 'removal', 'IAM', 'conditional'])('rejects a bad second plan (%s) before any execution', kind => {
    const fixture = defaults(); const p = fixture.cognito.plan;
    if (kind === 'source') p.Description = 'wrong';
    if (kind === 'stack') p.StackId = p.StackId.replace(cognito, 'Other');
    if (kind === 'status') p.ExecutionStatus = 'EXECUTE_COMPLETE';
    if (kind === 'replacement' || kind === 'conditional') p.Changes[0]!.ResourceChange.Replacement = kind === 'replacement' ? 'True' : 'Conditional';
    if (kind === 'removal') p.Changes[0]!.ResourceChange.Action = 'Remove';
    if (kind === 'IAM') p.Changes[0]!.ResourceChange.ResourceType = 'AWS::IAM::Role';
    const result = execute(applyScript, fixture); expect(result.status).not.toBe(0); expect(executions(result.calls)).toEqual([]);
  });
  it.each(['sha', 'account', 'region', 'missing', 'duplicate', 'IAM stack', 'wrong ARN'])('rejects a mismatched combined manifest: %s', kind => {
    const plan = manifest();
    if (kind === 'sha') plan.sourceSha = 'b'.repeat(40);
    if (kind === 'account') plan.account = '111122223333';
    if (kind === 'region') plan.region = 'us-east-1';
    if (kind === 'missing') plan.stacks.pop();
    if (kind === 'duplicate') plan.stacks[1]!.name = storage;
    if (kind === 'IAM stack') plan.stacks[1]!.name = 'ObsidianGitHubTrust';
    if (kind === 'wrong ARN') plan.stacks[1]!.arn = arn(cognito, 'create').replace(account, '111122223333');
    const result = execute(applyScript, {}, plan); expect(result.status).not.toBe(0); expect(executions(result.calls)).toEqual([]);
  });
  it('executes only changed stacks from the full plan', () => {
    const plan = manifest(); plan.stacks[0]!.hasChanges = false;
    const result = execute(applyScript, {}, plan); expect(result.status, result.stderr).toBe(0);
    expect(executions(result.calls).map(c => c.args.at(-1))).toEqual([arn(cognito, 'create')]);
  });
  it.each([false, true])('rejects stale main before each execution (partial completion: %s)', advanceAfterFirst => {
    const result = execute(applyScript, advanceAfterFirst ? { advanceAfterFirst } : { main: 'b'.repeat(40) });
    expect(result.status).not.toBe(0); expect(executions(result.calls)).toHaveLength(advanceAfterFirst ? 1 : 0);
  });
  it.each(['DRIFTED', 'FAILED', 'TIMEOUT'])('keeps the bounded storage drift check for %s', kind => {
    const drift = kind === 'TIMEOUT' ? { DetectionStatus: 'DETECTION_IN_PROGRESS' } : { DetectionStatus: kind === 'FAILED' ? 'DETECTION_FAILED' : 'DETECTION_COMPLETE', StackDriftStatus: kind };
    const result = execute(applyScript, { drift }); expect(result.status).not.toBe(0);
    expect(result.calls.filter(c => c.args[1] === 'describe-stack-drift-detection-status').length).toBeLessThanOrEqual(30);
  }, 30_000);
  it.each([false, true])('bounds discovery retries after Apply (Cognito changed: %s)', changed => {
    const plan = manifest(); plan.stacks[1]!.hasChanges = changed;
    const result = execute(step('apply', 'Check actual OAuth discovery after infrastructure Apply'), { discoveryExit: 1 }, plan);
    expect(result.status).not.toBe(0);
    expect(result.calls.filter(c => c.tool === 'npm')).toHaveLength(changed ? 6 : 1);
    expect(result.summary).toContain('NOT established');
  });
});
