import { PracticeError } from '../errors.js';
import { dateSchema, type ReviewSummary } from '../practice-schema.js';

/** The spaced-repetition settings every consumer schedules with. */
export interface ScheduleConfig {
  readonly intervals: readonly number[];
  readonly retryDays: number;
  readonly archiveAfterFinal: boolean;
}

/** The review fields one recorded attempt changes. */
export type ScheduleChange = Partial<ReviewSummary> & Pick<ReviewSummary, 'stage' | 'next_review' | 'last_review' | 'review_count' | 'status'>
  & { archived_on?: string };

/** Computes the next schedule after one attempt. The core has checked the date and stage first. */
export type Scheduler = (item: ReviewSummary, outcome: string, day: string, config: ScheduleConfig) => ScheduleChange;

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
 * Advances one stage after an on-time independent attempt, retries any other
 * outcome, and leaves an early independent attempt on its existing date.
 */
export const stageSchedule: Scheduler = (item, outcome, day, config) => {
  const { intervals, retryDays, archiveAfterFinal } = config;
  const stage = item.stage, finalStage = intervals.length - 1;
  const active = { last_review: day, review_count: item.review_count + 1, status: 'active' as const };
  if (outcome !== 'independent') return { ...active, stage, next_review: addDays(day, retryDays) };
  if (!item.next_review) return { ...active, stage: 0, next_review: addDays(day, intervals[0]!) };
  if (day < item.next_review) return { ...active, stage, next_review: item.next_review };
  if (archiveAfterFinal && stage === finalStage) {
    return { ...active, stage, next_review: null, status: 'archived' as const, archived_on: day };
  }
  const nextStage = Math.min(stage + 1, finalStage);
  return { ...active, stage: nextStage, next_review: addDays(day, intervals[nextStage]!) };
};

/** Checks the attempt date and stored stage, then applies the consumer's scheduler. */
export function nextSchedule(item: ReviewSummary, outcome: string, day: string, config: ScheduleConfig, scheduler: Scheduler = stageSchedule) {
  dateSchema.parse(day);
  if (item.last_review && day < item.last_review) throw new PracticeError('review_date_precedes_last_review');
  if (item.stage > config.intervals.length - 1) throw new PracticeError('invalid_review_stage');
  return scheduler(item, outcome, day, config);
}
