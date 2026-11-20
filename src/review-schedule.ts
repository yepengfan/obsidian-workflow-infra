import { dateSchema, type ReviewSummary } from './practice-schema.js';
import { PracticeError } from './errors.js';

export function calendarDay(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateSchema.parse(date.toISOString().slice(0, 10));
}
export function nextSchedule(item: ReviewSummary, outcome: string, day: string, intervals: number[], retry: number,
  archiveAfterFinal = false) {
  dateSchema.parse(day);
  if (item.last_review && day < item.last_review) throw new PracticeError('review_date_precedes_last_review');
  const stage = item.stage;
  const finalStage = intervals.length - 1;
  if (stage > finalStage) throw new PracticeError('invalid_review_stage');
  const active = { last_review: day, review_count: item.review_count + 1, status: 'active' as const };

  if (outcome !== 'independent') return { ...active, stage, next_review: addDays(day, retry) };
  if (!item.next_review) return { ...active, stage: 0, next_review: addDays(day, intervals[0]!) };
  if (day < item.next_review) return { ...active, stage, next_review: item.next_review };
  if (archiveAfterFinal && stage === finalStage) {
    return { ...active, stage, next_review: null, status: 'archived' as const, archived_on: day };
  }
  const nextStage = Math.min(stage + 1, finalStage);
  return { ...active, stage: nextStage, next_review: addDays(day, intervals[nextStage]!) };
}
