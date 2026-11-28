import { describe, expect, it } from 'vitest';
import { OperationError } from '../src/errors.js';
import type { PracticeDomain } from '../src/practice-domains.js';
import type { ReviewSummary } from '../src/practice-schema.js';
import { practiceReviewConsumers } from '../src/review-consumers.js';
import { stageReviewConsumer } from '../src/srs/consumer.js';
import { addDays, nextSchedule } from '../src/srs/schedule.js';
import * as legacy from './fixtures/legacy-review-schedule.js';

/** Deterministic PRNG so a failure reproduces from its seed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const consumers = practiceReviewConsumers({ designObservations: async () => [] });
const outcomes: Record<PracticeDomain, string[]> = {
  algorithm: ['independent', 'assisted', 'incomplete'],
  'system-design': ['independent', 'assisted', 'incomplete', 'completed'],
};
const intervalSets = [[1, 3, 7, 14, 60], [1, 3, 7, 14, 30, 60], [2, 5]];

function outcomeOf(run: () => unknown) {
  try { return { value: run() }; }
  catch (error) { return { error: error instanceof OperationError ? error.code : String(error) }; }
}

function start(domain: PracticeDomain): ReviewSummary {
  return { id: 'parity', domain, title: 'Parity', status: 'active', review_count: 0, stage: 0,
    ...(domain === 'system-design' ? { completed_design_rounds: 0 } : {}), last_review: null, next_review: null };
}

function scenario(domain: PracticeDomain, seed: number) {
  const next = random(seed), pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const intervals = pick(intervalSets), retryDays = pick([1, 2]), archiveAfterFinal = next() < 0.5;
  const attempts = Array.from({ length: 1 + Math.floor(next() * 12) }, () => ({ outcome: pick(outcomes[domain]), offset: Math.floor(next() * 26) - 5 }));
  return { intervals, retryDays, archiveAfterFinal, attempts };
}

describe('SRS core parity with the pre-split schedule', () => {
  it.each(['algorithm', 'system-design'] as const)('schedules %s attempts exactly as before', domain => {
    let steps = 0;
    for (let seed = 1; seed <= 4000; seed++) {
      const { intervals, retryDays, archiveAfterFinal, attempts } = scenario(domain, seed);
      const config = { intervals, retryDays, archiveAfterFinal };
      let item = start(domain), day = '2026-11-01';
      for (const { outcome, offset } of attempts) {
        day = addDays(item.next_review ?? day, offset);
        const before = outcomeOf(() => legacy.nextSchedule(item, outcome, day, intervals, retryDays, archiveAfterFinal));
        const after = outcomeOf(() => nextSchedule(item, outcome, day, config, consumers[domain].schedule));
        expect(after, `seed ${seed}, step ${steps}`).toEqual(before);
        steps++;
        if (!('value' in before)) break;
        item = { ...item, ...before.value as Partial<ReviewSummary> };
        if (item.status === 'archived') break;
      }
    }
    expect(steps).toBeGreaterThan(10000);
  });

  it('replays System Design histories and labels rounds exactly as before', () => {
    const consumer = consumers['system-design'];
    for (let seed = 1; seed <= 3000; seed++) {
      const { intervals, retryDays, archiveAfterFinal, attempts } = scenario('system-design', seed);
      const config = { intervals, retryDays, archiveAfterFinal };
      let stored = start('system-design'), day = '2026-11-01', body = '# Parity\n\n## Practice history\n';
      for (const [index, { outcome, offset }] of attempts.entries()) {
        day = addDays(stored.last_review ?? day, Math.abs(offset));
        const change = outcomeOf(() => legacy.nextSchedule(stored, outcome, day, intervals, retryDays, archiveAfterFinal));
        if (!('value' in change)) break;
        // Store a schedule from an older policy so the replay has something to correct.
        stored = { ...stored, ...change.value as Partial<ReviewSummary>, stage: Math.min(index, intervals.length - 1) };
        body += `\n\n### ${day} · Round ${index + 1}\n\n**${outcome}** · Next review ${stored.next_review}\n`;
        for (const reviewCount of [stored.review_count, stored.review_count + 1]) {
          const item = { ...stored, review_count: reviewCount };
          expect(consumer.correctHistory!(item, body, config), `seed ${seed}`)
            .toEqual(legacy.designHistory(item, body, intervals, retryDays, archiveAfterFinal));
        }
        expect(consumer.present(stored)).toEqual(legacy.designRound(stored.completed_design_rounds!));
        if (stored.status === 'archived') break;
      }
    }
  });

  it('keeps Algorithm free of history replay and round labels', () => {
    expect(consumers.algorithm).toBe(stageReviewConsumer);
    expect(stageReviewConsumer.correctHistory).toBeNull();
    expect(stageReviewConsumer.present(start('algorithm'))).toEqual({});
  });
});
