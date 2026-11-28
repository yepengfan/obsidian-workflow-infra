import type { BlockMap } from './block-map.js';
import type { ConceptObservation } from './design-profile.js';
import { PracticeError } from './errors.js';

/**
 * System Design rules that read the block map: observations tagged with the
 * building block they concern, a problem's core blocks, and the blocks a
 * round answered weakly.
 */

type Tagged = Pick<ConceptObservation, 'block' | 'concept_id' | 'performance' | 'learner'>;

/** Every tagged block must be a block of the map. */
export function checkObservationBlocks(map: BlockMap, observations: readonly Tagged[]) {
  const blocks = new Set(map.blocks.map(block => block.id));
  if (observations.some(observation => observation.block !== undefined && !blocks.has(observation.block))) throw new PracticeError('unknown_block');
}

type Criteria = readonly { id: string; met: boolean }[];

/**
 * `core_blocks_partial`, when the module judges it, must be met exactly when
 * every required id has a learner observation in the round and none of them
 * is weak or uncovered. `idOf` reads the id an observation answers.
 */
function checkCoreAnswered(required: readonly string[], idOf: (observation: Tagged) => string | undefined, criteria: Criteria, observations: readonly Tagged[]) {
  const criterion = criteria.find(item => item.id === 'core_blocks_partial');
  if (!criterion) return;
  const answered = required.every(id => {
    const own = observations.filter(observation => observation.learner && idOf(observation) === id);
    return own.length > 0 && own.every(observation => observation.performance === 'mastered' || observation.performance === 'partial');
  });
  if (criterion.met !== answered) throw new PracticeError('core_blocks_mismatch');
}

/** For a problem of the map, the required ids are its core blocks, answered by block-tagged observations. */
export function checkCoreBlocks(map: BlockMap, problemId: string, criteria: Criteria, observations: readonly Tagged[]) {
  const problem = map.problems.find(candidate => candidate.id === problemId);
  if (!problem) throw new PracticeError('unknown_problem');
  checkCoreAnswered(problem.core, observation => observation.block, criteria, observations);
}

/**
 * For a problem without a map row, the item's concepts stand in for its core
 * blocks. An item without concepts has nothing to check.
 */
export function checkCoreConcepts(concepts: readonly string[], criteria: Criteria, observations: readonly Tagged[]) {
  if (concepts.length) checkCoreAnswered(concepts, observation => observation.concept_id, criteria, observations);
}

/** The blocks a round's learner answered partially or weakly, in first-seen order. */
export function weakBlocks(observations: readonly Tagged[]) {
  return [...new Set(observations.flatMap(observation =>
    observation.learner && observation.block !== undefined && (observation.performance === 'partial' || observation.performance === 'weak') ? [observation.block] : []))];
}
