import { describe, expect, it } from 'vitest';
import { judge } from '../src/srs/criteria.js';
import { parseHistory, renderEntry } from '../src/srs/history.js';
import { calendarDay, nextSchedule, type ScheduleConfig } from '../src/srs/schedule.js';

const rule: ScheduleConfig = { intervals: [1, 3, 7, 14, 30, 60], stepBack: 1, retryDays: 1, archiveAfterFinal: true };
const item = { stage: 0, review_count: 0, last_review: null as string | null };

describe('the global schedule rule', () => {
  it.each([
    { name: 'first pass leaves stage 0 and waits one day', prior: {}, passed: true, stage: 1, due: '2026-11-15' },
    { name: 'a pass waits the new stage interval', prior: { stage: 1 }, passed: true, stage: 2, due: '2026-11-17' },
    { name: 'stage 5 passes into the 60-day stage', prior: { stage: 5 }, passed: true, stage: 6, due: '2027-01-13' },
    { name: 'a fail steps back one stage and retries tomorrow', prior: { stage: 4 }, passed: false, stage: 3, due: '2026-11-15' },
    { name: 'a fail at stage 0 stays at 0', prior: {}, passed: false, stage: 0, due: '2026-11-15' },
  ])('$name', ({ prior, passed, stage, due }) => {
    expect(nextSchedule({ ...item, ...prior }, passed, '2026-11-14', rule)).toEqual({ stage, next_review: due, last_review: '2026-11-14', review_count: 1, status: 'active' });
  });

  it('archives a pass at the top stage and retries a fail there', () => {
    const top = { stage: 6, review_count: 9, last_review: '2026-09-15' };
    expect(nextSchedule(top, true, '2026-11-14', rule)).toEqual({ stage: 6, next_review: null, last_review: '2026-11-14', review_count: 10, status: 'archived', archived_on: '2026-11-14' });
    expect(nextSchedule(top, false, '2026-11-14', rule)).toMatchObject({ stage: 5, next_review: '2026-11-15', status: 'active' });
    expect(nextSchedule(top, true, '2026-11-14', { ...rule, archiveAfterFinal: false })).toMatchObject({ stage: 6, next_review: '2027-01-13', status: 'active' });
  });

  it('counts an early attempt from the day it ended', () => {
    // Due 2026-11-20 at stage 2; passing early on 11-14 still moves up and counts from 11-14.
    expect(nextSchedule({ stage: 2, review_count: 2, last_review: '2026-11-13' }, true, '2026-11-14', rule)).toMatchObject({ stage: 3, next_review: '2026-11-21' });
  });

  it('replays the documented examples', () => {
    const days = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-06', '2026-12-13', '2026-12-27', '2027-01-26'];
    let state = { ...item };
    const results = days.map((day, index) => {
      const change = nextSchedule(state, index > 0, day, rule);
      state = change;
      return [change.stage, change.next_review];
    });
    expect(results).toEqual([[0, '2026-12-02'], [1, '2026-12-03'], [2, '2026-12-06'], [3, '2026-12-13'], [4, '2026-12-27'], [5, '2027-01-26'], [6, '2027-03-27']]);
    const forgotten = nextSchedule(state, false, '2027-03-27', rule);
    expect(forgotten).toMatchObject({ stage: 5, next_review: '2027-03-28' });
    const recovered = nextSchedule(forgotten, true, '2027-03-28', rule);
    expect(recovered).toMatchObject({ stage: 6, next_review: '2027-05-27' });
    expect(nextSchedule(recovered, true, '2027-05-27', rule)).toMatchObject({ status: 'archived', archived_on: '2027-05-27' });
  });

  it('moves a passed placement straight to its stage and fails a placement like any attempt', () => {
    expect(nextSchedule(item, true, '2026-11-14', rule, 4)).toEqual({ stage: 4, next_review: '2026-11-28', last_review: '2026-11-14', review_count: 1, status: 'active' });
    expect(nextSchedule(item, false, '2026-11-14', rule, 4)).toEqual({ stage: 0, next_review: '2026-11-15', last_review: '2026-11-14', review_count: 1, status: 'active' });
    expect(() => nextSchedule({ ...item, review_count: 1, last_review: '2026-11-13' }, true, '2026-11-14', rule, 4)).toThrow('placement_requires_first_attempt');
    for (const stage of [0, 7, 1.5]) expect(() => nextSchedule(item, true, '2026-11-14', rule, stage)).toThrow('invalid_placement_stage');
  });

  it('refuses an earlier date than the last review and a stage above the top', () => {
    expect(() => nextSchedule({ ...item, last_review: '2026-11-15' }, true, '2026-11-14', rule)).toThrow('review_date_precedes_last_review');
    expect(() => nextSchedule({ ...item, stage: 7 }, true, '2026-11-14', rule)).toThrow('invalid_review_stage');
    expect(() => nextSchedule(item, true, '2026-02-30', rule)).toThrow();
  });

  it('uses the vault calendar rather than UTC and handles daylight saving', () => {
    expect(calendarDay('Australia/Brisbane', new Date('2026-11-14T15:00:00Z'))).toBe('2026-11-15');
    expect(calendarDay('America/New_York', new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
  });
});

describe('pass criteria', () => {
  const declared = [{ id: 'no_substantive_help', rule: 'No hints.' }, { id: 'tests_pass', rule: 'All tests pass.' }];
  const met = (id: string, value = true) => ({ id, met: value, evidence: 'Observed.' });

  it('passes only when every declared criterion is met', () => {
    expect(judge(declared, [met('tests_pass'), met('no_substantive_help')])).toEqual({ passed: true, unmet: [] });
    expect(judge(declared, [met('no_substantive_help', false), met('tests_pass')])).toEqual({ passed: false, unmet: ['no_substantive_help'] });
  });

  it.each([
    { name: 'a missing criterion', results: [met('tests_pass')] },
    { name: 'an undeclared criterion', results: [met('tests_pass'), met('no_substantive_help'), met('fast')] },
    { name: 'a repeated criterion', results: [met('tests_pass'), met('tests_pass')] },
    { name: 'a substitute criterion', results: [met('tests_pass'), met('fast')] },
  ])('rejects $name', ({ results }) => {
    expect(() => judge(declared, results)).toThrow('criteria_mismatch');
  });
});

describe('practice history', () => {
  const entry = (round: number, date: string, passed: boolean) => renderEntry({ date, round, passed, nextReview: passed ? '2026-12-01' : '2026-11-15',
    criteria: [{ id: 'no_substantive_help', met: passed, evidence: 'Asked for\nthe approach.' }, { id: 'tests_pass', met: true, evidence: 'Accepted.' }],
    reflection: 'My reflection.' });

  it('reads back rendered entries with their unmet criteria', () => {
    const body = '# Title\n\n## Practice history\n' + entry(1, '2026-11-14', false) + entry(2, '2026-11-15', true);
    expect(body).toContain('- Not met `no_substantive_help`: Asked for the approach.');
    expect(parseHistory(body).map(entry => ({ ...entry, text: undefined }))).toEqual([
      { date: '2026-11-14', round: 1, passed: false, result: 'Failed', unmet: ['no_substantive_help'], placement: false },
      { date: '2026-11-15', round: 2, passed: true, result: 'Passed', unmet: [], placement: false },
    ]);
    expect(parseHistory(body).map(row => row.text.trim())).toEqual([entry(1, '2026-11-14', false).trim(), entry(2, '2026-11-15', true).trim()]);
  });

  it('reads legacy outcomes, in English and Chinese, as passed or failed', () => {
    const body = '## Practice history\n\n### 2026-11-01 · 第 1 轮\n\n**独立完成** · 下次 2026-11-02\n\n' +
      '### 2026-11-02 · Round 2\n\n**assisted** · Next review 2026-11-03\n\n### 2026-11-03 · Round 3\n\n**incomplete** · Next review 2026-11-04\n\n' +
      '### 2026-11-04 · Round 4\n\n**completed** · Next review 2026-11-05\n\n### 2026-11-05 · 第 5 轮\n\n**已完成** · 下次 2026-11-06\n';
    expect(parseHistory(body).map(row => [row.round, row.result, row.passed, row.unmet])).toEqual([
      [1, '独立完成', true, null], [2, 'assisted', false, null], [3, 'incomplete', false, null], [4, 'completed', false, null], [5, '已完成', false, null]]);
  });

  it('reads criteria only from each entry\'s own block, never from learner text', () => {
    const tricky = '### 2026-01-02 notes\n- Not met `tests_pass`: I worried about this.\n**Failed** · not a result';
    const passed = renderEntry({ date: '2026-11-14', round: 1, passed: true, nextReview: '2026-11-15', reflection: tricky, submission: tricky, observations: tricky,
      criteria: [{ id: 'no_substantive_help', met: true, evidence: 'None.' }, { id: 'tests_pass', met: true, evidence: 'Accepted.' }] });
    const failed = renderEntry({ date: '2026-11-15', round: 2, passed: false, nextReview: '2026-11-16', reflection: tricky,
      criteria: [{ id: 'no_substantive_help', met: false, evidence: 'Hint.' }, { id: 'tests_pass', met: true, evidence: 'Accepted.' }] });
    expect(parseHistory('## Practice history\n' + passed + failed).map(entry => ({ ...entry, text: undefined }))).toEqual([
      { date: '2026-11-14', round: 1, passed: true, result: 'Passed', unmet: [], placement: false },
      { date: '2026-11-15', round: 2, passed: false, result: 'Failed', unmet: ['no_substantive_help'], placement: false },
    ]);
  });

  it('renders a module section after the criteria and reads a placement back', () => {
    const placed = renderEntry({ date: '2026-11-14', round: 1, passed: true, nextReview: '2026-11-28', placement: true, reflection: 'Mine.',
      criteria: [{ id: 'no_substantive_help', met: true, evidence: 'None.' }], details: '#### Points\n\n- mastered `occ`: Drew it.\n' });
    expect(placed).toContain('**Passed** · Placement · Next review 2026-11-28\n\n#### Pass criteria\n\n- Met `no_substantive_help`: None.\n\n#### Points\n\n- mastered `occ`: Drew it.\n\n#### My reflection');
    const [entry] = parseHistory(placed);
    expect(entry).toMatchObject({ round: 1, passed: true, unmet: [], placement: true });
    expect(() => renderEntry({ date: '2026-11-14', round: 1, passed: true, nextReview: null, reflection: 'r', criteria: [], details: 'no heading' }))
      .toThrow('invalid_history_details');
    expect(() => parseHistory(entry!.text + placed.replace('Round 1', 'Round 2'))).toThrow('invalid_practice_history');
  });

  it.each([
    { name: 'an unknown outcome', body: '### 2026-11-01 · Round 1\n\n**finished** · Next review 2026-11-02\n' },
    { name: 'a skipped round', body: '### 2026-11-01 · Round 2\n\n**assisted** · Next review 2026-11-02\n' },
    { name: 'a date going back', body: '### 2026-11-02 · Round 1\n\n**assisted** · x\n\n### 2026-11-01 · Round 2\n\n**assisted** · x\n' },
    { name: 'a heading copied out of sequence into learner text', body: '### 2026-11-01 · Round 1\n\n**assisted** · x\n\nMy notes:\n### 2026-11-01 · Round 5\n\n**independent** · x\n' },
    { name: 'a pass with an unmet criterion', body: '### 2026-11-01 · Round 1\n\n**Passed** · x\n\n#### Pass criteria\n\n- Not met `tests_pass`: no\n' },
    { name: 'a judged entry without its criteria block', body: '### 2026-11-01 · Round 1\n\n**Failed** · x\n\n- Not met `tests_pass`: no\n' },
  ])('rejects $name', ({ body }) => {
    expect(() => parseHistory(body)).toThrow('invalid_practice_history');
  });
});
