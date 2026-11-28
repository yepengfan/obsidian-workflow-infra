import { PracticeError } from './errors.js';
import { domainSchema, type PracticeDomain } from './practice-domains.js';
import { parsePracticeNote } from './practice-note.js';
import { reviewSummarySchema } from './practice-schema.js';
import type { PassCriterion } from './srs/criteria.js';
import { parseHistory, type HistoryEntry } from './srs/history.js';
import { serializeNote } from './srs/review-items.js';
import { nextSchedule, type ScheduleConfig } from './srs/schedule.js';

/**
 * One-off migration of review items to the global schedule rule. Every item
 * is replayed from its practice history and only its frontmatter is
 * rewritten; the history text stays as recorded.
 */

/** The criteria a legacy outcome leaves unmet, per the agreed conversion. */
const COMPLETION_CRITERIA: Record<PracticeDomain, string> = { algorithm: 'tests_pass', 'system-design': 'all_steps_done' };
/** Legacy outcomes that ended without proven independence; `incomplete` misses the completion criterion instead. */
const HELP_OUTCOMES = new Set(['assisted', '提示后完成', 'completed', '已完成']);
const SCHEDULE_FIELDS = ['stage', 'next_review', 'last_review', 'review_count', 'status', 'archived_on', 'last_result', 'unmet_criteria'] as const;
/** Fields the global rule replaces. */
const RETIRED_FIELDS = ['last_outcome', 'completed_design_rounds'] as const;

export interface MigrationPolicy {
  readonly schedule: ScheduleConfig;
  readonly criteria: Readonly<Record<PracticeDomain, readonly PassCriterion[]>>;
}

export interface MigratedEntry {
  date: string; round: number; result: string; passed: boolean; unmet: readonly string[];
  stage: number; next_review: string | null;
}

export interface MigrationRow {
  id: string; domain: string; title: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  entries: MigratedEntry[];
  changed: boolean;
  /** Set when the item cannot be migrated; nothing is written. */
  error?: string;
}

function unmetCriteria(entry: HistoryEntry, domain: PracticeDomain, declared: readonly PassCriterion[]) {
  if (entry.unmet) return entry.unmet;
  if (entry.passed) return [];
  const missing = HELP_OUTCOMES.has(entry.result) ? 'no_substantive_help' : COMPLETION_CRITERIA[domain];
  if (!declared.some(criterion => criterion.id === missing)) throw new PracticeError('invalid_pass_criteria');
  return [missing];
}

const pick = (metadata: Record<string, unknown>) =>
  Object.fromEntries([...SCHEDULE_FIELDS, ...RETIRED_FIELDS].filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]]));

/** Replays one review note. Returns its report row and, when it changes, the migrated note text. */
export function migrateReview(id: string, text: string, policy: MigrationPolicy): { row: MigrationRow; text?: string } {
  const { metadata, body } = parsePracticeNote(text);
  const row: MigrationRow = { id, domain: String(metadata.domain ?? ''), title: String(metadata.title ?? ''), before: pick(metadata), after: {}, entries: [], changed: false };
  try {
    const summary = reviewSummarySchema.parse(metadata);
    if (summary.id !== id) throw new PracticeError('review_id_mismatch');
    const domain = domainSchema.parse(summary.domain);
    const history = parseHistory(body);
    if (history.length !== summary.review_count) throw new PracticeError('history_count_mismatch');
    let state = { stage: 0, review_count: 0, last_review: null as string | null };
    let schedule: ReturnType<typeof nextSchedule> | undefined;
    for (const entry of history) {
      schedule = nextSchedule(state, entry.passed, entry.date, policy.schedule);
      state = schedule;
      row.entries.push({ date: entry.date, round: entry.round, result: entry.result, passed: entry.passed,
        unmet: unmetCriteria(entry, domain, policy.criteria[domain]), stage: schedule.stage, next_review: schedule.next_review });
    }
    const migrated: Record<string, unknown> = { ...metadata };
    for (const key of [...SCHEDULE_FIELDS, ...RETIRED_FIELDS]) delete migrated[key];
    const last = row.entries.at(-1);
    Object.assign(migrated, schedule ?? { stage: 0, next_review: null, last_review: null, review_count: 0, status: 'active' },
      last ? { last_result: last.passed ? 'passed' : 'failed', unmet_criteria: [...last.unmet] } : {});
    // Keep the original key order for fields that already existed.
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(metadata)) if (Object.hasOwn(migrated, key)) ordered[key] = migrated[key];
    for (const key of Object.keys(migrated)) if (!Object.hasOwn(ordered, key)) ordered[key] = migrated[key];
    row.after = pick(ordered);
    const output = serializeNote(ordered, body);
    row.changed = output !== text;
    return { row, ...(row.changed ? { text: output } : {}) };
  } catch (error) {
    row.error = error instanceof PracticeError ? error.code : error instanceof Error ? error.message : String(error);
    return { row };
  }
}
