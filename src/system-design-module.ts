import type { BlockMap } from './block-map.js';
import { checkCoreBlocks, checkObservationBlocks, weakBlocks } from './design-blocks.js';
import { conceptObservationSchema } from './design-profile.js';
import { PracticeError } from './errors.js';
import { NoteError } from './paths.js';
import type { ModuleAttempt, PracticeModule, PracticeModulePorts } from './practice-module.js';
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
  constructor(private readonly ports: PracticeModulePorts, private readonly blockMap: () => Promise<BlockMap>) {}

  async attempt(_itemId: string, attempt: ModuleAttempt) {
    if (attempt.points?.length) throw new PracticeError('unsupported_practice_domain');
    const observations = (attempt.concept_observations ?? []).map(item => conceptObservationSchema.parse(item));
    if (attempt.problem === undefined && !observations.some(observation => observation.block !== undefined)) return undefined;
    const map = await this.blockMap();
    checkObservationBlocks(map, observations);
    if (attempt.problem !== undefined) checkCoreBlocks(map, attempt.problem, attempt.criteria, observations);
    return undefined;
  }

  /** Brings each weakly answered block's review forward to the day after the round, reactivating an archived one. */
  async finish(_itemId: string, attempt: ModuleAttempt & { completed_on: string }) {
    const blocks = weakBlocks((attempt.concept_observations ?? []).map(item => conceptObservationSchema.parse(item)));
    if (!blocks.length) return {};
    const usable = await this.ports.available('sd-blocks');
    const block_signals: BlockSignal[] = [];
    for (const block of blocks) {
      const item_id = blockItemId(block);
      if (!usable) { block_signals.push({ block, item_id, result: 'sd_blocks_unavailable' }); continue; }
      try {
        block_signals.push({ block, item_id, result: await this.ports.pullForward(item_id, addDays(attempt.completed_on, 1), attempt.completed_on) });
      } catch (error) {
        if (!(error instanceof NoteError) || error.code !== 'note_unavailable') throw error;
        block_signals.push({ block, item_id, result: 'not_enrolled' });
      }
    }
    return { block_signals };
  }
}
