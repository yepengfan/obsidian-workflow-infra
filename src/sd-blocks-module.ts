import type { z } from 'zod';
import type { BlockMap } from './block-map.js';
import { BLOCK_MAP, practiceDomains } from './practice-domains.js';
import type { ItemState, ModuleAttempt, PracticeModule, PracticeModulePorts } from './practice-module.js';
import { REVIEW_ITEMS_PREFIX } from './practice-schema.js';
import { blockItemId, blockReviewCanvas, blocksOverview, type blockTemplateSchema, checkPoints, checkPointsAnswered, itemBlock, pointRotation,
  renderPoints } from './sd-blocks.js';
import { PracticeError } from './errors.js';
import { parseHistory } from './srs/history.js';

const ROOT = practiceDomains['sd-blocks'].root;

/** SD Blocks behind the practice module contract: the block map, point results and review canvases. */
export class SdBlocksModule implements PracticeModule {
  constructor(private readonly ports: PracticeModulePorts, private readonly blockMap: () => Promise<BlockMap>) {}

  /** Each block's item state. Items missing from the active index, archived or newly added, are read from their notes. */
  private async items() {
    const [names, active] = await Promise.all([this.ports.notesIn(REVIEW_ITEMS_PREFIX + blockItemId('')), this.ports.activeReviews('sd-blocks')]);
    const states = new Map<string, ItemState>(active.map(row => [row.id, { id: row.id, status: row.status, stage: row.stage, next_review: row.next_review }]));
    const unindexed = names.map(path => path.slice(REVIEW_ITEMS_PREFIX.length, -3)).filter(id => id.length && !states.has(id));
    for (let index = 0; index < unindexed.length; index += 4) {
      for (const item of await Promise.all(unindexed.slice(index, index + 4).map(id => this.ports.item(id)))) {
        if (item.domain === 'sd-blocks') states.set(item.id, { id: item.id, status: item.status, stage: item.stage, next_review: item.next_review });
      }
    }
    return states;
  }

  async check() { await this.blockMap(); }

  async workflow() {
    try {
      return { blocks: blocksOverview(await this.blockMap(), await this.items()) };
    } catch {
      this.ports.signal.throwIfAborted();
      return { blocks: null };
    }
  }

  async review(itemId: string, body: string) {
    const block = itemBlock(await this.blockMap(), itemId);
    return { block: { id: block.id, title: block.title, note: block.note, cards: block.cards, points: pointRotation(block, parseHistory(body)) } };
  }

  async add(itemId: string) { itemBlock(await this.blockMap(), itemId); }

  async attempt(itemId: string, attempt: ModuleAttempt) {
    if (attempt.problem !== undefined || attempt.concept_observations?.length) throw new PracticeError('unsupported_practice_domain');
    checkPoints(itemBlock(await this.blockMap(), itemId), attempt.points);
    checkPointsAnswered(attempt.criteria, attempt.points!);
    return renderPoints(attempt.points!);
  }

  /** `Blocks.md` and every note it links, all under System Design. */
  async reads() {
    const map = await this.blockMap();
    return new Set([BLOCK_MAP, ...map.blocks.flatMap(block => [block.note, ...block.cards]), ...map.problems.map(problem => problem.note)]);
  }

  canvas(path: string) { return path.startsWith(ROOT + 'Reviews/') && path.endsWith('.excalidraw.md'); }

  /** An unsaved canvas for one review of a block of the map. */
  async template(input: z.infer<typeof blockTemplateSchema>) {
    return blockReviewCanvas(itemBlock(await this.blockMap(), blockItemId(input.block)), input, this.ports.today());
  }
}
