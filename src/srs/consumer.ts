import type { ReviewSummary } from '../practice-schema.js';
import { stageSchedule, type ScheduleConfig, type Scheduler } from './schedule.js';

/** The attempt fields a consumer may inspect before the core records it. */
export interface ReviewAttempt {
  readonly attempt_id: string;
  readonly outcome?: string;
  readonly submission?: string;
  readonly concept_observations?: readonly unknown[];
}

/** A stored review item as consumers see it. */
export type ReviewItem = ReviewSummary & { readonly attempt_ids: readonly string[] };

/** Corrects a stored schedule from the note's practice history. */
export type HistoryCorrection = (item: ReviewSummary, body: string, config: ScheduleConfig) => Partial<ReviewSummary>;

/**
 * How one module uses spaced repetition. A module starts from
 * `stageReviewConsumer` and replaces only the behavior it changes.
 */
export interface ReviewConsumer {
  /** Frontmatter added to a new review item. */
  initialState(): Record<string, unknown>;
  /** Outcome recorded when an attempt omits one; null requires an outcome. */
  readonly defaultOutcome: string | null;
  readonly schedule: Scheduler;
  /**
   * Applied whenever an item is read, so such items are always confirmed
   * against their notes. Null when the stored schedule is authoritative.
   */
  readonly correctHistory: HistoryCorrection | null;
  /** Fields shown with an item in the queue and when it is opened for review. */
  present(item: ReviewSummary): Record<string, unknown>;
  /** Rejects an attempt before it is recorded. */
  beforeRecord(item: ReviewItem, attempt: ReviewAttempt): Promise<void>;
}

/** The core behavior: the stage schedule, a required outcome and no extra fields. */
export const stageReviewConsumer: ReviewConsumer = Object.freeze({
  initialState: () => ({}),
  defaultOutcome: null,
  schedule: stageSchedule,
  correctHistory: null,
  present: () => ({}),
  beforeRecord: async () => {},
});

/** The registered consumers, keyed by the review domain they own. */
export type ReviewConsumers<Domain extends string> = Readonly<Record<Domain, ReviewConsumer>>;
