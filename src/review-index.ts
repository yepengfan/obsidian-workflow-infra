import type { PracticeDomain } from './practice-domains.js';
import type { ReviewSummary } from './practice-schema.js';

/** One indexed review row with the note revision (S3 ETag) it was built from. */
export type IndexedReview = ReviewSummary & { revision: string };

/**
 * Read port for the practice review index. Rows are an eventually consistent
 * projection of the review notes; the notes remain the source of truth.
 */
export interface ReviewIndex {
  /** Every active review of one domain, in any order. */
  activeReviews(domain: PracticeDomain, signal: AbortSignal): Promise<IndexedReview[]>;
}
