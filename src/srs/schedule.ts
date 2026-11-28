import { PracticeError } from '../errors.js';
import { dateSchema, type ReviewSummary } from '../practice-schema.js';

/**
 * The one spaced-repetition rule every module follows. Stage 0 means the item
 * has never passed; stage N waits `intervals[N - 1]` days. The top stage is
 * `intervals.length`.
 */
export interface ScheduleConfig {
  readonly intervals: readonly number[];
  /** Stages a failed attempt drops, never below 0. */
  readonly stepBack: number;
  /** Days until a failed attempt is retried. */
  readonly retryDays: number;
  /** Whether passing at the top stage archives the item. */
  readonly archiveAfterFinal: boolean;
}

/** The review fields one recorded attempt changes. */
export type ScheduleChange = Pick<ReviewSummary, 'stage' | 'next_review' | 'last_review' | 'review_count' | 'status'> & { archived_on?: string };

export function calendarDay(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateSchema.parse(date.toISOString().slice(0, 10));
}

/**
 * Schedules one ended attempt from the day it was completed. Passing moves up
 * one stage, and passing at the top stage archives the item. Failing drops
 * `stepBack` stages and retries after `retryDays`. Early attempts count.
 */
export function nextSchedule(item: Pick<ReviewSummary, 'stage' | 'last_review' | 'review_count'>, passed: boolean, day: string, config: ScheduleConfig): ScheduleChange {
  dateSchema.parse(day);
  const top = config.intervals.length;
  if (item.last_review && day < item.last_review) throw new PracticeError('review_date_precedes_last_review');
  if (item.stage > top) throw new PracticeError('invalid_review_stage');
  const active = { last_review: day, review_count: item.review_count + 1, status: 'active' as const };
  if (!passed) {
    return { ...active, stage: Math.max(0, item.stage - config.stepBack), next_review: addDays(day, config.retryDays) };
  }
  if (item.stage === top && config.archiveAfterFinal) {
    return { ...active, stage: top, next_review: null, status: 'archived' as const, archived_on: day };
  }
  const stage = Math.min(item.stage + 1, top);
  return { ...active, stage, next_review: addDays(day, config.intervals[stage - 1]!) };
}
