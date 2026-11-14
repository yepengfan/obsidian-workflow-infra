import fs from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

// Workflow YAML is the machine-consumed public contract. Assert its semantics.
it('queues cleanup and infrastructure deployment under one uncancellable mutex', () => {
  for (const name of ['artifact-retention', 'plan-and-apply']) {
    const workflow = parse(fs.readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
    expect(workflow.concurrency).toEqual({ group: 'obsidian-infrastructure-production', queue: 'max', 'cancel-in-progress': false });
  }
});
it('uses scheduled reviewed-policy cleanup and defaults manual execution to preview', () => {
  const workflow = parse(fs.readFileSync('.github/workflows/artifact-retention.yml', 'utf8'));
  expect(workflow.on.schedule).toEqual([{ cron: '23 4 * * *' }]);
  expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.cleanup).toMatchObject({
    if: "github.ref == 'refs/heads/main'", environment: 'production-plan',
    'timeout-minutes': 10, permissions: { contents: 'read', 'id-token': 'write' },
  });
  const steps = workflow.jobs.cleanup.steps as { uses?: string; with?: Record<string, unknown> }[];
  const credentials = steps.find(s => s.uses?.startsWith('aws-actions/configure-aws-credentials@'))!;
  expect(credentials.with).toEqual({
    'role-to-assume': '${{ steps.config.outputs.roleArn }}',
    'aws-region': '${{ steps.config.outputs.region }}', 'allowed-account-ids': '${{ steps.config.outputs.account }}',
  });
  expect(steps.find(s => s.uses?.startsWith('actions/upload-artifact@'))?.with).toMatchObject({
    'retention-days': 7, path: 'code-retention-result.json',
  });
});
