import { z } from 'zod';
import { PracticeError } from '../errors.js';

/** A pass criterion id, such as `no_substantive_help`. */
export const criterionIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u).max(64);

/** One condition a module declares; every one must hold for an attempt to pass. */
export interface PassCriterion {
  readonly id: string;
  readonly rule: string;
}

/** The agent's judgment of one criterion for one attempt. */
export const criterionResultSchema = z.strictObject({
  id: criterionIdSchema,
  met: z.boolean(),
  evidence: z.string().max(2000).refine(value => value.trim().length > 0),
});
export type CriterionResult = z.infer<typeof criterionResultSchema>;

/**
 * Checks that the results judge exactly the declared criteria, once each, and
 * computes the verdict. An attempt passes only when every criterion is met.
 */
export function judge(declared: readonly PassCriterion[], results: readonly CriterionResult[]) {
  const ids = results.map(result => result.id);
  if (new Set(ids).size !== ids.length || ids.length !== declared.length || declared.some(criterion => !ids.includes(criterion.id))) {
    throw new PracticeError('criteria_mismatch');
  }
  const unmet = declared.filter(criterion => !results.find(result => result.id === criterion.id)!.met).map(criterion => criterion.id);
  return { passed: unmet.length === 0, unmet };
}
