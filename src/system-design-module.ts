import type { BlockMap } from './block-map.js';
import { checkCoreBlocks, checkCoreConcepts, checkObservationBlocks, weakBlocks } from './design-blocks.js';
import { blockGap, type BlockReview, findProblem, parseRoadmap, roadmapProgress } from './design-preflight.js';
import { OperationError, PracticeError } from './errors.js';
import { NoteError, validPath } from './paths.js';
import { practiceDomains } from './practice-domains.js';
import type { ModuleAttempt, PracticeModule, PracticeModulePorts, ReviewSignals } from './practice-module.js';
import { parsePracticeNote } from './practice-note.js';
import { blockItemId } from './sd-blocks.js';
import { addDays } from './srs/schedule.js';

const MODULE = practiceDomains['system-design'].module;

/** The `roadmap` setting as a vault note path; anything else is `invalid_roadmap`. */
function roadmapPath(setting: unknown) {
  if (typeof setting !== 'string' || !setting.endsWith('.md')) throw new PracticeError('invalid_roadmap');
  try { return validPath(setting); } catch { throw new PracticeError('invalid_roadmap'); }
}

/** Read access to saved System Design sessions, given only to this module. */
export interface SessionHistory {
  /** The topics of System Design sessions whose round has ended. */
  finishedSessions(): Promise<readonly { topic: string }[]>;
}

/** What a round's weak block did to its SD Blocks review. */
export interface BlockSignal { block: string; item_id: string; result: 'pulled_forward' | 'reactivated' | 'unchanged' | 'not_enrolled' | 'sd_blocks_unavailable' }

/**
 * System Design rules behind the practice module contract that use the block
 * map: block-tagged observations, the problem's core blocks, the signal that
 * brings a weakly answered block's review forward, the review state of a
 * problem's blocks before it starts, and the next problem of the learning
 * roadmap. Signals and item states go through the core's public interface;
 * this module never calls SD Blocks.
 */
export class SystemDesignModule implements PracticeModule {
  constructor(private readonly ports: PracticeModulePorts, private readonly signals: ReviewSignals, private readonly history: SessionHistory,
    private readonly blockMap: () => Promise<BlockMap>) {}

  /** The roadmap's next problem with its pre-problem check, for choosing new practice. */
  async workflow() { return { roadmap: await this.roadmap() }; }

  /**
   * The problem's core and supporting blocks with their SD Blocks reviews and
   * gaps, found by its id or breakdown note. A problem without a row returns no
   * blocks. While SD Blocks is unusable, the blocks are listed without reviews.
   */
  async preflight(input: { problem?: string; breakdown?: string }) {
    const map = await this.blockMap();
    const row = findProblem(map, input);
    if (!row) return { problem: null, note: null, sd_blocks: null, blocks: [], core_gaps: null };
    const usable = await this.signals.available('sd-blocks');
    const title = (id: string) => map.blocks.find(block => block.id === id)!.title;
    const listed = [...row.core.map(id => ({ id, title: title(id), role: 'core' as const })), ...row.uses.map(id => ({ id, title: title(id), role: 'uses' as const }))];
    const reviews: (BlockReview | null | undefined)[] = [];
    for (let index = 0; usable && index < listed.length; index += 4) {
      reviews.push(...await Promise.all(listed.slice(index, index + 4).map(block => this.blockReview(blockItemId(block.id)))));
    }
    const blocks = listed.map((block, index) => {
      // Undefined while SD Blocks is unusable; null when the block has no item.
      const review = usable ? reviews[index] : undefined;
      return { ...block, item_id: blockItemId(block.id), review: review ?? null, gap: review === undefined ? null : blockGap(review) };
    });
    return { problem: row.id, note: row.note, sd_blocks: usable ? 'available' : 'unavailable', blocks,
      core_gaps: usable ? blocks.filter(block => block.role === 'core' && block.gap !== null).length : null };
  }

  /** A block item's review, or null when no SD Blocks item exists under its id. */
  private async blockReview(id: string): Promise<BlockReview | null> {
    try {
      const item = await this.ports.item(id);
      return item.domain === 'sd-blocks' ? { status: item.status, stage: item.stage, next_review: item.next_review, last_passed: item.last_passed } : null;
    } catch (error) {
      if (error instanceof NoteError && error.code === 'note_unavailable') return null;
      throw error;
    }
  }

  /**
   * The learning roadmap named by the module's `roadmap` setting, a plan note
   * whose frontmatter lists the problems in order. Null when none is set; a
   * roadmap that cannot be used reports why, as the error's code, instead of
   * failing the workflow.
   */
  private async roadmap() {
    let plan: string | null = null;
    try {
      const setting = parsePracticeNote((await this.ports.read(MODULE)).text).metadata.roadmap;
      if (setting === undefined || setting === null) return null;
      plan = roadmapPath(setting);
      const entries = parseRoadmap((await this.ports.read(plan)).text);
      const { completed, total, next } = roadmapProgress(entries, (await this.history.finishedSessions()).map(session => session.topic));
      return { status: 'ready' as const, plan, completed, total, next: next && { ...next, preflight: await this.nextPreflight(next.title) } };
    } catch (error) {
      this.ports.signal.throwIfAborted();
      return { status: 'unavailable' as const, plan, reason: error instanceof OperationError ? error.code : 'note_unavailable' };
    }
  }

  /** The next problem's check, or the reason it is unavailable, such as an invalid block map. */
  private async nextPreflight(title: string) {
    try { return await this.preflight({ breakdown: title }); } catch (error) {
      this.ports.signal.throwIfAborted();
      return { error: error instanceof OperationError ? error.code : 'note_unavailable' };
    }
  }

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
