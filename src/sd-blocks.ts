import { z } from 'zod';
import type { Block, BlockMap } from './block-map.js';
import { textCanvas } from './design-canvas.js';
import { PracticeError } from './errors.js';
import { practiceDomains } from './practice-domains.js';
import { attemptIdSchema, slugSchema } from './practice-schema.js';
import type { HistoryEntry } from './srs/history.js';

/**
 * SD Blocks module rules: each block of the map is one review item, and each
 * review records how every point it examined was answered. Those results
 * decide which points the next review examines.
 */

const ITEM_PREFIX = 'sdb-';
const RESULTS = ['mastered', 'partial', 'weak'] as const;
type PointResult = (typeof RESULTS)[number];

export const blockPointResultSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64),
  result: z.enum(RESULTS),
  evidence: z.string().max(2000).refine(value => value.trim().length > 0),
});
export type BlockPointResult = z.infer<typeof blockPointResultSchema>;

export const blockItemId = (block: string) => ITEM_PREFIX + block;

/** The block an item reviews; an item id that names no block of the map is refused. */
export function itemBlock(map: BlockMap, itemId: string): Block {
  const block = itemId.startsWith(ITEM_PREFIX) ? map.blocks.find(candidate => candidate.id === itemId.slice(ITEM_PREFIX.length)) : undefined;
  if (!block) throw new PracticeError('unknown_block');
  return block;
}

/** Checks that an attempt judged one or more of the block's points, once each. */
export function checkPoints(block: Block, points: readonly BlockPointResult[] | undefined) {
  if (!points?.length) throw new PracticeError('block_points_required');
  const ids = points.map(point => point.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !block.points.some(point => point.id === id))) throw new PracticeError('block_points_mismatch');
}

/** `points_answered`, when the module judges it, must be met exactly when every examined point was mastered. */
export function checkPointsAnswered(criteria: readonly { id: string; met: boolean }[], points: readonly BlockPointResult[]) {
  const answered = criteria.find(criterion => criterion.id === 'points_answered');
  if (answered && answered.met !== points.every(point => point.result === 'mastered')) throw new PracticeError('points_answered_mismatch');
}

const HEADING = '#### Points';
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** The history section that records the examined points; `pointHistory` reads it back. */
export function renderPoints(points: readonly BlockPointResult[]) {
  return `${HEADING}\n\n${points.map(point => `- ${point.result} \`${point.id}\`: ${oneLine(point.evidence)}`).join('\n')}\n`;
}

/** The points one entry examined, read only from its own Points section, before any learner text. */
function entryPoints(entry: HistoryEntry) {
  const start = entry.text.indexOf(`\n${HEADING}\n`);
  const reflection = entry.text.indexOf('\n#### My reflection\n');
  if (start < 0 || (reflection >= 0 && reflection < start)) return [];
  const rest = entry.text.slice(start + HEADING.length + 2);
  const end = rest.search(/^#{1,4} /mu);
  return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/^- (mastered|partial|weak) `([a-z0-9-]+)`: /gmu)]
    .map(match => ({ id: match[2]!, result: match[1] as PointResult }));
}

export interface PointRotation {
  id: string; text: string;
  /** How many reviews examined the point. */
  examined: number;
  last_result: PointResult | null;
  last_examined: string | null;
}

/**
 * The block's points in the order the next review should examine them:
 * points never examined, then those last answered weak, then partial, then
 * mastered; within each, the least recently examined first, then map order.
 * Recency follows the history's entry order, so two reviews on one day keep
 * their order.
 */
export function pointRotation(block: Block, history: readonly HistoryEntry[]): PointRotation[] {
  const state = new Map(block.points.map(point => [point.id, { id: point.id, text: point.text, examined: 0,
    last_result: null as PointResult | null, last_examined: null as string | null }]));
  const lastEntry = new Map<string, number>();
  history.forEach((entry, index) => {
    for (const point of entryPoints(entry)) {
      const current = state.get(point.id);
      // A point removed from the map keeps its history but is no longer examined.
      if (!current) continue;
      Object.assign(current, { examined: current.examined + 1, last_result: point.result, last_examined: entry.date });
      lastEntry.set(point.id, index);
    }
  });
  const rank = (point: PointRotation) => point.last_result === null ? -1 : RESULTS.length - 1 - RESULTS.indexOf(point.last_result);
  const order = block.points.map(point => point.id);
  return [...state.values()].sort((a, b) => rank(a) - rank(b) || (lastEntry.get(a.id) ?? -1) - (lastEntry.get(b.id) ?? -1) ||
    order.indexOf(a.id) - order.indexOf(b.id));
}

export interface BlockItemState { id: string; status: string; stage: number; next_review: string | null }

/** Every block in map order with its review item, or null before the block's first recorded attempt. */
export function blocksOverview(map: BlockMap, items: ReadonlyMap<string, BlockItemState>) {
  return map.blocks.map(block => ({ id: block.id, title: block.title, note: block.note, points: block.points.length,
    item_id: blockItemId(block.id), item: items.get(blockItemId(block.id)) ?? null }));
}

export const blockTemplateSchema = z.strictObject({
  block: slugSchema, attempt_id: attemptIdSchema,
  scenario: z.string().trim().min(1).max(1500).refine(value =>
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.replaceAll('\n', '')) && !value.includes('%%') && !value.includes('```'),
  'Use plain text without control characters, %% or code fences'),
});

/** An unsaved canvas for one block review, showing its scenario. Each attempt has its own file. */
export function blockReviewCanvas(block: Block, input: z.infer<typeof blockTemplateSchema>, day: string) {
  const { attempt_id, scenario } = blockTemplateSchema.parse(input);
  const path = `${practiceDomains['sd-blocks'].root}Reviews/${block.id}/${day}-${attempt_id}.excalidraw.md`;
  return { saved: false, canvas: { path, drawing: textCanvas([`Block review: ${block.title}`, `Scenario\n${scenario}`], 'sdb-template') } };
}
