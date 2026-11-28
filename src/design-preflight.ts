import { z } from 'zod';
import type { BlockMap, Problem } from './block-map.js';
import { PracticeError } from './errors.js';
import { parsePracticeNote } from './practice-note.js';

/**
 * System Design rules for choosing and preparing a problem: the review state
 * of the blocks a problem uses, and the next problem of a learning roadmap.
 * Pure functions; the System Design module supplies the notes and items.
 */

/** A block's SD Blocks review as the core reports it, or null before the block's first recorded attempt. */
export interface BlockReview { status: string; stage: number; next_review: string | null; last_passed: boolean | null }

/**
 * Why a block needs attention before the problem: `not_enrolled` has no review
 * yet, `last_failed` failed its latest review. An archived block has finished
 * its schedule and is never a gap.
 */
export type BlockGap = 'not_enrolled' | 'last_failed';

export function blockGap(review: BlockReview | null): BlockGap | null {
  if (!review) return 'not_enrolled';
  return review.status === 'active' && review.last_passed === false ? 'last_failed' : null;
}

const noteTitle = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '');

/** The problem row named by its id or by its breakdown note's title, a path or file name; null when the map has none. */
export function findProblem(map: BlockMap, input: { problem?: string; breakdown?: string }): Problem | null {
  if ((input.problem === undefined) === (input.breakdown === undefined)) throw new PracticeError('provide_problem_or_breakdown');
  if (input.problem !== undefined) return map.problems.find(problem => problem.id === input.problem) ?? null;
  const title = noteTitle(input.breakdown!.trim()).toLowerCase();
  return map.problems.find(problem => noteTitle(problem.note).toLowerCase() === title) ?? null;
}

const roadmapEntrySchema = z.object({
  title: z.string().trim().min(1).max(200),
  phase: z.string().trim().max(200).optional(),
  focus: z.string().trim().max(500).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});
export type RoadmapEntry = z.infer<typeof roadmapEntrySchema>;

/** The `roadmap` list in a plan note's frontmatter; a note without valid frontmatter or list is `invalid_roadmap`. */
export function parseRoadmap(text: string): RoadmapEntry[] {
  let roadmap: unknown;
  try { roadmap = parsePracticeNote(text).metadata.roadmap; } catch { throw new PracticeError('invalid_roadmap'); }
  const parsed = z.array(roadmapEntrySchema).min(1).max(200).safeParse(roadmap);
  if (!parsed.success) throw new PracticeError('invalid_roadmap');
  return parsed.data;
}

/**
 * Progress through a roadmap. A problem is done once a finished session's
 * topic contains one of its aliases, or its title when it lists none, as the
 * plan's own dashboard counts it. The next problem is the first one not done.
 */
export function roadmapProgress(entries: readonly RoadmapEntry[], finishedTopics: readonly string[]) {
  const topics = finishedTopics.map(topic => topic.toLowerCase());
  const done = entries.map(entry => (entry.aliases?.length ? entry.aliases : [entry.title])
    .some(alias => topics.some(topic => topic.includes(alias.toLowerCase()))));
  const next = done.indexOf(false);
  return { completed: done.filter(Boolean).length, total: entries.length, next: next < 0 ? null : entries[next]! };
}
