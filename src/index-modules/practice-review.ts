import { z } from 'zod';
import { dateSchema, REVIEW_ITEMS_PREFIX, reviewSummarySchema } from '../practice-schema.js';
import type { IndexedModule } from './types.js';

/** Unstarted items sort before every real date in the queue index. */
export const UNSTARTED_SORT = '0000-00-00';

const row = reviewSummarySchema.extend({ archived_on: dateSchema.nullable().default(null) });
export type PracticeReviewRow = z.output<typeof row>;

export const practiceReviewIndex: IndexedModule<PracticeReviewRow> = {
  id: 'practice-review',
  sourcePrefix: REVIEW_ITEMS_PREFIX,
  matches: relativeKey => /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u.exec(relativeKey)?.[1],
  metadata: row,
  key: item => item.id,
  indexes: {
    // One domain's active queue, oldest due first: Query queue_pk = "<domain>#active".
    queue: { partition: item => `${item.domain}#${item.status}`, sort: item => item.next_review ?? UNSTARTED_SORT },
  },
};
