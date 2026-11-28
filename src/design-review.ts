import { PracticeError } from './errors.js';
import { summaryCitesExistingObservations, type StoredObservation } from './design-profile.js';
import type { ReviewSummary } from './practice-schema.js';
import { stageReviewConsumer, type ReviewAttempt, type ReviewConsumer, type ReviewItem } from './srs/consumer.js';
import { addDays, nextSchedule, type ScheduleConfig, type Scheduler } from './srs/schedule.js';

/** Rounds 1 and 2 are guided, rounds 3 to 6 are mock interviews, and round 6 closes the topic. */
const FINAL_ROUND = 6;
const GUIDED_ROUNDS = 2;

export function designRound(completed: number) {
  const next_round = completed + 1;
  const coaching_mode = completed < GUIDED_ROUNDS ? 'guided' : 'mock_interview';
  return { next_round, coaching_mode, summary_required: completed === FINAL_ROUND - 1 };
}

/**
 * Advances one round for every ended attempt, from its actual completion
 * date, and archives the topic after the final round.
 */
export const designSchedule: Scheduler = (item, outcome, day, { intervals, retryDays }) => {
  const stage = item.stage, finalStage = intervals.length - 1;
  const completed = item.completed_design_rounds ?? 0;
  const active = { completed_design_rounds: completed + Number(outcome !== 'incomplete'), last_review: day, review_count: item.review_count + 1, status: 'active' as const };
  if (item.status === 'archived' || completed >= FINAL_ROUND) throw new PracticeError('review_archived');
  if (outcome === 'incomplete') return { ...active, stage, next_review: addDays(day, retryDays) };
  if (completed === FINAL_ROUND - 1) return { ...active, stage, next_review: null, status: 'archived' as const, archived_on: day };
  const learningStage = Math.min(completed, finalStage);
  return { ...active, stage: learningStage, next_review: addDays(day, intervals[learningStage]!) };
};

/**
 * Replays the note's round history so items saved under an earlier schedule
 * read with the current one. A history that does not match the stored count
 * only reports the stored completed rounds.
 */
export function designHistory(item: ReviewSummary, body: string, config: ScheduleConfig) {
  const entries = [...body.matchAll(/^### (\d{4}-\d{2}-\d{2}) · (?:Round (\d+)|第 (\d+) 轮)\s*\n\*\*(independent|assisted|incomplete|completed|独立完成|提示后完成|未完成)\*\* · /gmu)];
  if (entries.length !== item.review_count || entries.some((m, i) => Number(m[2] ?? m[3]) !== i + 1)) {
    return { completed_design_rounds: item.completed_design_rounds ?? 0 };
  }
  const translations: Record<string, string> = { '独立完成': 'independent', '提示后完成': 'assisted', '未完成': 'incomplete' };
  let replay: ReviewSummary = { ...item, status: 'active', stage: 0, review_count: 0, completed_design_rounds: 0, next_review: null, last_review: null };
  for (const entry of entries) {
    if (replay.status === 'archived') break;
    const outcome = translations[entry[4]!] ?? entry[4]!;
    replay = { ...replay, ...nextSchedule(replay, outcome, entry[1]!, config, designSchedule) };
  }
  const progress = { completed_design_rounds: replay.completed_design_rounds! };
  if (entries.length && item.status === 'active' && (replay.status === 'archived' || replay.last_review === item.last_review)) {
    return { ...progress, stage: replay.stage, next_review: replay.next_review,
      status: replay.status, ...(replay.status === 'archived' ? { archived_on: replay.last_review } : {}) };
  }
  return progress;
}

/**
 * The closing round must cite observations already saved for the topic
 * instead of adding new ones.
 */
export async function checkFinalSummary(item: ReviewItem, attempt: ReviewAttempt, observations: () => Promise<StoredObservation[]>) {
  const outcome = attempt.outcome ?? 'completed';
  if (item.status !== 'active' || outcome === 'incomplete' ||
    (item.completed_design_rounds ?? 0) !== FINAL_ROUND - 1 || item.attempt_ids.includes(attempt.attempt_id)) return;
  if (attempt.concept_observations?.length) throw new PracticeError('final_round_rejects_new_observations');
  if (!summaryCitesExistingObservations(attempt.submission, await observations())) throw new PracticeError('final_summary_required');
}

/** System Design's use of spaced repetition: one completed round per attempt. */
export function designReviewConsumer(observations: () => Promise<StoredObservation[]>): ReviewConsumer {
  return {
    ...stageReviewConsumer,
    initialState: () => ({ completed_design_rounds: 0 }),
    defaultOutcome: 'completed',
    schedule: designSchedule,
    correctHistory: designHistory,
    present: item => designRound(item.completed_design_rounds ?? 0),
    beforeRecord: (item, attempt) => checkFinalSummary(item, attempt, observations),
  };
}
