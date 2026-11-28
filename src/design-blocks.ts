import type { BlockMap } from './block-map.js';
import type { ConceptObservation } from './design-profile.js';
import { PracticeError } from './errors.js';

/**
 * System Design rules that read the block map: observations tagged with the
 * building block they concern, a problem's core blocks, and the blocks a
 * round answered weakly.
 */

type Tagged = Pick<ConceptObservation, 'block' | 'performance' | 'learner'>;

/** Every tagged block must be a block of the map. */
export function checkObservationBlocks(map: BlockMap, observations: readonly Tagged[]) {
  const blocks = new Set(map.blocks.map(block => block.id));
  if (observations.some(observation => observation.block !== undefined && !blocks.has(observation.block))) throw new PracticeError('unknown_block');
}

/**
 * `core_blocks_partial`, when the module judges it for a problem of the map,
 * must be met exactly when every core block of the problem has a learner
 * observation in the round and none of them is weak or uncovered.
 */
export function checkCoreBlocks(map: BlockMap, problemId: string, criteria: readonly { id: string; met: boolean }[], observations: readonly Tagged[]) {
  const problem = map.problems.find(candidate => candidate.id === problemId);
  if (!problem) throw new PracticeError('unknown_problem');
  const criterion = criteria.find(item => item.id === 'core_blocks_partial');
  if (!criterion) return;
  const answered = problem.core.every(block => {
    const own = observations.filter(observation => observation.learner && observation.block === block);
    return own.length > 0 && own.every(observation => observation.performance === 'mastered' || observation.performance === 'partial');
  });
  if (criterion.met !== answered) throw new PracticeError('core_blocks_mismatch');
}

/** The blocks a round's learner answered partially or weakly, in first-seen order. */
export function weakBlocks(observations: readonly Tagged[]) {
  return [...new Set(observations.flatMap(observation =>
    observation.learner && observation.block !== undefined && (observation.performance === 'partial' || observation.performance === 'weak') ? [observation.block] : []))];
}
