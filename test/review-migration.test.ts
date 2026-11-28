import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.js';
import { migrateReview, type MigrationPolicy } from '../src/review-migration.js';
import { renderEntry } from '../src/srs/history.js';

const policy: MigrationPolicy = {
  schedule: { intervals: [1, 3, 7, 14, 30, 60], stepBack: 1, retryDays: 1, archiveAfterFinal: true },
  criteria: {
    algorithm: [{ id: 'no_substantive_help', rule: 'r' }, { id: 'tests_pass', rule: 'r' }],
    'system-design': [{ id: 'no_substantive_help', rule: 'r' }, { id: 'within_time_limit', rule: 'r' }, { id: 'all_steps_done', rule: 'r' }, { id: 'core_blocks_partial', rule: 'r' }],
    'sd-blocks': [{ id: 'no_substantive_help', rule: 'r' }, { id: 'points_answered', rule: 'r' }],
  },
  placementStages: { 'sd-blocks': 4 },
};
const legacy = (round: number, date: string, outcome: string) => `\n### ${date} · Round ${round}\n\n**${outcome}** · Next review 2099-01-01\n\nMy notes.\n`;
function note(metadata: Record<string, unknown>, history: string) {
  return '---\n' + stringify({ id: 'sysd-dropbox', domain: 'system-design', title: 'Design Dropbox', status: 'active', custom: 'kept',
    prompt: 'Design it.', review_count: 0, stage: 0, last_review: null, next_review: null, ...metadata }) + '---\n# Design Dropbox\n\n## Practice history\n' + history;
}

describe('review schedule migration', () => {
  it('replays legacy outcomes, rewrites only schedule fields and keeps the history', () => {
    const history = legacy(1, '2026-11-23', 'assisted') + legacy(2, '2026-11-24', 'assisted');
    const text = note({ stage: 1, review_count: 2, last_review: '2026-11-24', next_review: '2026-11-27', completed_design_rounds: 2, last_outcome: 'assisted' }, history);
    const { row, text: migrated } = migrateReview('sysd-dropbox', text, policy);
    expect(row.error).toBeUndefined();
    expect(row.after).toEqual({ stage: 0, next_review: '2026-11-25', last_review: '2026-11-24', review_count: 2, status: 'active',
      last_result: 'failed', unmet_criteria: ['no_substantive_help'] });
    expect(row.entries.map(entry => [entry.result, entry.unmet, entry.stage, entry.next_review])).toEqual([
      ['assisted', ['no_substantive_help'], 0, '2026-11-24'], ['assisted', ['no_substantive_help'], 0, '2026-11-25']]);
    const saved = parseFrontmatter(migrated!)!;
    expect(saved.body).toBe(parseFrontmatter(text)!.body);
    expect(saved.metadata).not.toHaveProperty('completed_design_rounds');
    expect(saved.metadata).not.toHaveProperty('last_outcome');
    expect(saved.metadata).toMatchObject({ custom: 'kept', prompt: 'Design it.' });
    expect(Object.keys(saved.metadata).slice(0, 5)).toEqual(['id', 'domain', 'title', 'status', 'custom']);
    expect(migrateReview('sysd-dropbox', migrated!, policy)).toEqual({ row: { ...row, before: row.after, changed: false } });
  });

  it('replays entries recorded after deployment with their own criteria', () => {
    const recorded = renderEntry({ date: '2026-11-29', round: 2, passed: false, nextReview: '2026-11-30', reflection: 'r',
      criteria: policy.criteria['system-design'].map(criterion => ({ id: criterion.id, met: criterion.id !== 'within_time_limit', evidence: 'e' })) });
    const { row } = migrateReview('sysd-dropbox', note({ review_count: 2 }, legacy(1, '2026-11-28', 'independent') + recorded), policy);
    expect(row.entries.map(entry => [entry.passed, entry.unmet, entry.stage])).toEqual([[true, [], 1], [false, ['within_time_limit'], 0]]);
    expect(row.after).toMatchObject({ stage: 0, next_review: '2026-11-30', last_result: 'failed', unmet_criteria: ['within_time_limit'] });
  });

  it('maps an incomplete legacy attempt to the module completion criterion', () => {
    const { row } = migrateReview('lc-1', note({ id: 'lc-1', domain: 'algorithm', review_count: 1 }, legacy(1, '2026-11-28', 'incomplete')), policy);
    expect(row.entries[0]).toMatchObject({ passed: false, unmet: ['tests_pass'] });
  });

  it('maps a System Design attempt recorded without an outcome to unproven independence', () => {
    const { row } = migrateReview('sysd-dropbox', note({ review_count: 1 }, legacy(1, '2026-11-28', 'completed')), policy);
    expect(row.entries[0]).toMatchObject({ passed: false, unmet: ['no_substantive_help'], stage: 0, next_review: '2026-11-29' });
  });

  it('keeps learner text that looks like a dated heading as content', () => {
    const history = legacy(1, '2026-11-27', 'independent').replace('My notes.', 'My notes.\n### 2026-01-02 notes\nMore.') + legacy(2, '2026-11-28', 'independent');
    const { row } = migrateReview('sysd-dropbox', note({ review_count: 2 }, history), policy);
    expect(row.error).toBeUndefined();
    expect(row.entries.map(entry => entry.stage)).toEqual([1, 2]);
  });

  it('replays a placement at the stage its module places familiar items', () => {
    const placed = renderEntry({ date: '2026-11-28', round: 1, passed: true, nextReview: '2026-12-12', placement: true, reflection: 'r',
      criteria: policy.criteria['sd-blocks'].map(criterion => ({ id: criterion.id, met: true, evidence: 'e' })), details: '#### Points\n\n- mastered `occ`: e\n' });
    const text = note({ id: 'sdb-caching', domain: 'sd-blocks', review_count: 1 }, placed);
    expect(migrateReview('sdb-caching', text, policy).row.entries).toMatchObject([{ passed: true, unmet: [], stage: 4, next_review: '2026-12-12' }]);
    expect(migrateReview('sdb-caching', text, { ...policy, placementStages: {} }).row.error).toBe('placement_not_supported');
  });

  it('leaves an unstarted item unstarted', () => {
    const { row } = migrateReview('sysd-dropbox', note({}, ''), policy);
    expect(row.after).toEqual({ stage: 0, next_review: null, last_review: null, review_count: 0, status: 'active' });
  });

  it.each([
    { name: 'a history that disagrees with review_count', text: note({ review_count: 2 }, legacy(1, '2026-11-28', 'assisted')), error: 'history_count_mismatch' },
    { name: 'an entry missing its result line', text: note({ review_count: 2 }, legacy(1, '2026-11-27', 'assisted') + '\n### 2026-11-28 · Round 2\n\nNo result.\n'), error: 'history_count_mismatch' },
    { name: 'an unknown legacy outcome', text: note({ review_count: 1 }, legacy(1, '2026-11-28', 'finished')), error: 'invalid_practice_history' },
    { name: 'a note under another id', text: note({ id: 'other' }, ''), error: 'review_id_mismatch' },
  ])('reports $name without changing the note', ({ text, error }) => {
    expect(migrateReview('sysd-dropbox', text, policy)).toEqual({ row: expect.objectContaining({ error, changed: false }) });
  });
});
