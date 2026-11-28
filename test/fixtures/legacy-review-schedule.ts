/** The review schedule before the SRS core split, kept as the parity oracle for test/review-parity.test.ts. */
import { dateSchema, type ReviewSummary } from '../../src/practice-schema.js';
import { PracticeError } from '../../src/errors.js';

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
export function designRound(completed: number) {
  const next_round = completed + 1;
  const coaching_mode = completed < 2 ? 'guided' : 'mock_interview';
  return { next_round, coaching_mode, summary_required: completed === 5 };
}

export function designHistory(item: ReviewSummary, body: string, intervals: number[], retry: number, archiveAfterFinal = false) {
  if (item.domain !== 'system-design') return {};
  const entries = [...body.matchAll(/^### (\d{4}-\d{2}-\d{2}) · (?:Round (\d+)|第 (\d+) 轮)\s*\n\*\*(independent|assisted|incomplete|completed|独立完成|提示后完成|未完成)\*\* · /gmu)];
  if (entries.length !== item.review_count || entries.some((m, i) => Number(m[2] ?? m[3]) !== i + 1)) {
    return { completed_design_rounds: item.completed_design_rounds ?? 0 };
  }
  const translations: Record<string, string> = { '独立完成': 'independent', '提示后完成': 'assisted', '未完成': 'incomplete' };
  let replay: ReviewSummary = { ...item, status: 'active', stage: 0, review_count: 0, completed_design_rounds: 0, next_review: null, last_review: null };
  for (const entry of entries) {
    if (replay.status === 'archived') break;
    const outcome = translations[entry[4]!] ?? entry[4]!;
    replay = { ...replay, ...nextSchedule(replay, outcome, entry[1]!, intervals, retry, archiveAfterFinal) };
  }
  const progress = { completed_design_rounds: replay.completed_design_rounds! };
  if (entries.length && item.status === 'active' && (replay.status === 'archived' || replay.last_review === item.last_review)) {
    return { ...progress, stage: replay.stage, next_review: replay.next_review,
      status: replay.status, ...(replay.status === 'archived' ? { archived_on: replay.last_review } : {}) };
  }
  return progress;
}

export function nextSchedule(item: ReviewSummary, outcome: string, day: string, intervals: number[], retry: number,
  archiveAfterFinal = false) {
  dateSchema.parse(day);
  if (item.last_review && day < item.last_review) throw new PracticeError('review_date_precedes_last_review');
  const stage = item.stage;
  const finalStage = intervals.length - 1;
  if (stage > finalStage) throw new PracticeError('invalid_review_stage');
  const completed = item.domain === 'system-design' ? item.completed_design_rounds ?? 0 : undefined;
  const active = { ...(completed === undefined ? {} : { completed_design_rounds: completed + Number(outcome !== 'incomplete') }), last_review: day, review_count: item.review_count + 1, status: 'active' as const };

  if (completed !== undefined) {
    if (item.status === 'archived' || completed >= 6) throw new PracticeError('review_archived');
    if (outcome === 'incomplete') return { ...active, stage, next_review: addDays(day, retry) };
    if (completed === 5) return { ...active, stage, next_review: null, status: 'archived' as const, archived_on: day };
    const learningStage = Math.min(completed, finalStage);
    return { ...active, stage: learningStage, next_review: addDays(day, intervals[learningStage]!) };
  }
  if (outcome !== 'independent') return { ...active, stage, next_review: addDays(day, retry) };
  if (!item.next_review) return { ...active, stage: 0, next_review: addDays(day, intervals[0]!) };
  if (day < item.next_review) return { ...active, stage, next_review: item.next_review };
  if (archiveAfterFinal && stage === finalStage) {
    return { ...active, stage, next_review: null, status: 'archived' as const, archived_on: day };
  }
  const nextStage = Math.min(stage + 1, finalStage);
  return { ...active, stage: nextStage, next_review: addDays(day, intervals[nextStage]!) };
}
