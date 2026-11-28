import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { domainSchema, practiceDomains } from '../src/practice-domains.js';
import { parsePracticeNote } from '../src/practice-note.js';
import { REVIEW_ITEMS_PREFIX } from '../src/practice-schema.js';
import { passCriteria, reviewConfig } from '../src/practice-workflow.js';
import { migrateReview, type MigrationPolicy } from '../src/review-migration.js';

// Replays every review item in a local vault under the global schedule rule.
// Without --write it only reports. Run it on a temporary vault copy first.
const args = process.argv.slice(2);
const vault = args.find(arg => !arg.startsWith('--'));
const write = args.includes('--write');
const reportIndex = args.indexOf('--report');
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
if (!vault || (reportIndex >= 0 && !reportPath)) {
  console.error('Usage: migrate-review-schedule.ts <vault-dir> [--report <file.json>] [--write]');
  process.exit(2);
}

const note = async (relative: string) => parsePracticeNote(await readFile(path.join(vault, relative), 'utf8')).metadata;
const config = reviewConfig(await note('system/modules/practice-review/module.md'));
const policy: MigrationPolicy = {
  schedule: { intervals: config.schedule.intervals, stepBack: config.schedule.on_fail.step_back,
    retryDays: config.schedule.on_fail.retry_days, archiveAfterFinal: config.schedule.archive_after_final },
  criteria: Object.fromEntries(await Promise.all(domainSchema.options.map(async domain =>
    [domain, passCriteria((await note(practiceDomains[domain].module)).pass_criteria, config.shared_criteria)]))) as MigrationPolicy['criteria'],
  // A consumer's placement interval names the stage a passed placement moves to.
  placementStages: Object.fromEntries(domainSchema.options.flatMap(domain => {
    const interval = (config.consumers[domain] as { placement_interval?: unknown } | undefined)?.placement_interval;
    const stage = config.schedule.intervals.indexOf(interval as number) + 1;
    return stage ? [[domain, stage]] : [];
  })),
};

const folder = path.join(vault, REVIEW_ITEMS_PREFIX);
const names = (await readdir(folder)).filter(name => name.endsWith('.md')).sort();
async function run() {
  return Promise.all(names.map(async name => {
    const file = path.join(folder, name);
    return { file, ...migrateReview(name.slice(0, -3), await readFile(file, 'utf8'), policy) };
  }));
}

const results = await run();
const rows = results.map(result => result.row);
const errors = rows.filter(row => row.error);
const changed = results.filter(result => result.text !== undefined);
if (reportPath) await writeFile(reportPath, JSON.stringify({ vault: path.resolve(vault), schedule: policy.schedule, criteria: policy.criteria, rows }, null, 2) + '\n');
console.log(`${rows.length} items, ${changed.length} to change, ${errors.length} with errors.`);
for (const row of errors) console.log(`  ${row.id}: ${row.error}`);

if (write) {
  if (errors.length) {
    console.error('Nothing written: resolve the errors first.');
    process.exit(1);
  }
  for (const result of changed) {
    const temporary = `${result.file}.migrating`;
    await writeFile(temporary, result.text!);
    await rename(temporary, result.file);
  }
  const again = await run();
  if (again.some(result => result.text !== undefined || result.row.error)) {
    console.error('Verification failed: a second pass would still change notes.');
    process.exit(1);
  }
  console.log(`Wrote ${changed.length} notes; a second pass changes nothing.`);
}
