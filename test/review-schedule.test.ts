import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReviewSummary } from '../src/practice-schema.js';
import { designHistory, designRound, nextSchedule } from '../src/review-schedule.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/design-rounds.json', import.meta.url), 'utf8')) as {
  intervals: number[];
  retry_days: number;
  rounds: Array<{ date: string; outcome: string; attempt_id: string; completed_design_rounds: number; stage: number; next_review: string | null; status: 'active' | 'archived' }>;
};

function item(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    id: 'sysd-sample', domain: 'system-design', title: 'Sample design', status: 'active',
    review_count: 0, stage: 0, completed_design_rounds: 0, last_review: null, next_review: null,
    ...overrides,
  };
}

describe('system design completion schedule', () => {
  it('replays the shared six-round sample, including a late round, an incomplete attempt and the archive', () => {
    let current = item();
    for (const step of fixture.rounds) {
      const next = nextSchedule(current, step.outcome, step.date, fixture.intervals, fixture.retry_days, true);
      expect(next).toMatchObject({
        completed_design_rounds: step.completed_design_rounds,
        stage: step.stage,
        status: step.status,
        next_review: step.next_review,
      });
      current = { ...current, ...next };
    }
    expect(designRound(5)).toEqual({ next_round: 6, coaching_mode: 'mock_interview', summary_required: true });
  });

  it('recalculates an assisted third round to 2 December without trusting the stored date', () => {
    const body = [
      '### 2026-11-21 · Round 1', '', '**assisted** · Next review 2026-11-22', '',
      '### 2026-11-22 · Round 2', '', '**assisted** · Next review 2026-11-25', '',
      '### 2026-11-25 · Round 3', '', '**assisted** · Next review 2026-11-26', '',
    ].join('\n');
    expect(designHistory(item({
      id: 'sysd-url-shortener', title: 'Design a URL Shortener (Bitly)', review_count: 3, stage: 1,
      completed_design_rounds: 3, last_review: '2026-11-25', next_review: '2026-11-26',
    }), body, fixture.intervals, fixture.retry_days, true)).toMatchObject({
      completed_design_rounds: 3, stage: 2, next_review: '2026-12-02',
    });
  });
});

it.each([false, true])('archives the sixth System Design completion with generic archive flag %s', archiveAfterFinal => {
  const current = item({ completed_design_rounds: 5, review_count: 5, stage: 4,
    last_review: '2026-11-20', next_review: '2027-01-19' });
  const next = nextSchedule(current, 'assisted', '2026-11-21', fixture.intervals, fixture.retry_days, archiveAfterFinal);
  expect(next).toMatchObject({ status: 'archived', archived_on: '2026-11-21', next_review: null,
    completed_design_rounds: 6, review_count: 6 });
  expect(() => nextSchedule({ ...current, ...next }, 'incomplete', '2026-11-22', fixture.intervals, fixture.retry_days, archiveAfterFinal)).toThrow('review_archived');
});

it('keeps six as the terminal completion with a longer interval configuration', () => {
  expect(nextSchedule(item({ completed_design_rounds: 5, review_count: 5, stage: 4 }), 'completed',
    '2026-11-21', [...fixture.intervals, 120], fixture.retry_days)).toMatchObject({
    status: 'archived', completed_design_rounds: 6, next_review: null, archived_on: '2026-11-21',
  });
});

it('replays legacy Chinese outcomes alongside the internal completed marker', () => {
  const body = '### 2026-11-21 · 第 1 轮\n\n**提示后完成** · 下次复习 2026-11-22\n\n' +
    '### 2026-11-22 · Round 2\n\n**completed** · Next review 2026-11-25';
  expect(designHistory(item({ review_count: 2, last_review: '2026-11-22', next_review: '2026-11-23' }),
    body, fixture.intervals, fixture.retry_days)).toMatchObject({ completed_design_rounds: 2, next_review: '2026-11-25' });
});
