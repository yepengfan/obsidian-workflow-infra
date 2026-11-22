import { z } from 'zod';

/** Practice review schemas shared by the MCP runtime and the index declaration. */
export const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(120);
export const dateSchema = z.iso.date().refine(value => !value.startsWith('0000-'), { message: 'Year must be between 0001 and 9999' });
export const reviewSummarySchema = z.object({ id: slugSchema, domain: z.enum(['algorithm', 'system-design', 'behavioral']), title: z.string().min(1).max(200), status: z.enum(['active', 'archived']),
  review_count: z.number().int().nonnegative(), stage: z.number().int().nonnegative(),
  completed_design_rounds: z.number().int().nonnegative().optional(),
  last_review: dateSchema.nullable(), next_review: dateSchema.nullable() });
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export const REVIEW_ITEMS_PREFIX = 'Learning/Practice/Review/Items/';
