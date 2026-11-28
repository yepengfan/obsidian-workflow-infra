import { z } from 'zod';

/** Practice review schemas shared by the MCP runtime and the index declaration. */
/** A stable concept identifier, such as `caching.cache-aside`. */
export const conceptIdSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u).max(80);
export const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(120);
export const dateSchema = z.iso.date().refine(value => !value.startsWith('0000-'), { message: 'Year must be between 0001 and 9999' });
/** Any domain slug parses; only a registered consumer makes a domain usable. */
export const reviewSummarySchema = z.object({ id: slugSchema, domain: slugSchema, title: z.string().min(1).max(200), status: z.enum(['active', 'archived']),
  review_count: z.number().int().nonnegative(), stage: z.number().int().nonnegative(),
  last_review: dateSchema.nullable(), next_review: dateSchema.nullable() });
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export const REVIEW_ITEMS_PREFIX = 'Learning/Practice/Review/Items/';
