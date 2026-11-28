import type { BlockMap } from './block-map.js';
import { checkCoreBlocks, checkCoreConcepts, checkObservationBlocks, weakBlocks } from './design-blocks.js';
import { PracticeError } from './errors.js';
import { NoteError } from './paths.js';
import type { ModuleAttempt, PracticeModule, ReviewSignals } from './practice-module.js';
import { blockItemId } from './sd-blocks.js';
import { addDays } from './srs/schedule.js';

/** What a round's weak block did to its SD Blocks review. */
export interface BlockSignal { block: string; item_id: string; result: 'pulled_forward' | 'reactivated' | 'unchanged' | 'not_enrolled' | 'sd_blocks_unavailable' }

/**
 * System Design rules behind the practice module contract that use the block
 * map: block-tagged observations, the problem's core blocks, and the signal
 * that brings a weakly answered block's review forward. The signal goes
 * through the core's `pullForward`; this module never calls SD Blocks.
 */
export class SystemDesignModule implements PracticeModule {
  constructor(private readonly signals: ReviewSignals, private readonly blockMap: () => Promise<BlockMap>) {}

  async attempt(_itemId: string, attempt: ModuleAttempt) {
    if (attempt.points?.length) throw new PracticeError('unsupported_practice_domain');
    // The round's evidence as the session stores it; a standalone review has none, so its judgment is not checked.
    const evidence = attempt.concept_observations;
    // Without a problem row, the item's concepts are its core blocks; that check needs no map.
    if (evidence && attempt.problem === undefined) checkCoreConcepts(attempt.concept_ids ?? [], attempt.criteria, evidence);
    if (attempt.problem === undefined && !evidence?.some(observation => observation.block !== undefined)) return undefined;
    const map = await this.blockMap();
    if (evidence) checkObservationBlocks(map, evidence);
    if (attempt.problem === undefined) return undefined;
    if (!map.problems.some(problem => problem.id === attempt.problem)) throw new PracticeError('unknown_problem');
    if (evidence) checkCoreBlocks(map, attempt.problem, attempt.criteria, evidence);
    return undefined;
  }

  /**
   * Brings each block the recorded round answered weakly forward to the day
   * after the round, reactivating an archived one.
   */
  async finish(_itemId: string, attempt: ModuleAttempt & { completed_on: string }) {
    // The service passes the round's stored observations, already parsed.
    const blocks = weakBlocks(attempt.concept_observations ?? []);
    if (!blocks.length) return {};
    const usable = await this.signals.available('sd-blocks');
    const block_signals: BlockSignal[] = [];
    for (const block of blocks) {
      const item_id = blockItemId(block);
      if (!usable) { block_signals.push({ block, item_id, result: 'sd_blocks_unavailable' }); continue; }
      try {
        block_signals.push({ block, item_id, result: await this.signals.pullForward(item_id, 'sd-blocks', addDays(attempt.completed_on, 1), attempt.completed_on) });
      } catch (error) {
        // An item id held by another domain cannot be the block's item.
        const missing = (error instanceof NoteError && error.code === 'note_unavailable') ||
          (error instanceof PracticeError && error.code === 'review_domain_mismatch');
        if (!missing) throw error;
        block_signals.push({ block, item_id, result: 'not_enrolled' });
      }
    }
    return { block_signals };
  }
}
