import type { StoredObservation } from './design-profile.js';
import { designReviewConsumer } from './design-review.js';
import type { PracticeDomain } from './practice-domains.js';
import { stageReviewConsumer, type ReviewConsumers } from './srs/consumer.js';

/** Every module that uses spaced repetition, and the hooks it adds to the core. */
export function practiceReviewConsumers(deps: { designObservations(): Promise<StoredObservation[]> }): ReviewConsumers<PracticeDomain> {
  return {
    algorithm: stageReviewConsumer,
    'system-design': designReviewConsumer(deps.designObservations),
  };
}
