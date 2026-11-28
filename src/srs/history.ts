import { PracticeError } from '../errors.js';
import type { CriterionResult } from './criteria.js';

/** One ended attempt as recorded in a review item's practice history. */
export interface HistoryEntry {
  readonly date: string;
  readonly round: number;
  readonly passed: boolean;
  /** The recorded result word, such as `Passed` or a legacy outcome like `assisted`. */
  readonly result: string;
  /** Criteria judged unmet; null for a legacy entry recorded as an outcome. */
  readonly unmet: readonly string[] | null;
}

/**
 * Legacy outcomes, recorded before pass criteria, and whether each passed.
 * `completed` is the default once written when an attempt omitted its outcome;
 * its independence was never recorded, so it does not pass.
 */
export const LEGACY_OUTCOMES: Readonly<Record<string, boolean>> = Object.freeze({
  independent: true, '独立完成': true,
  assisted: false, '提示后完成': false,
  incomplete: false, '未完成': false,
  completed: false, '已完成': false,
});

const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** Renders one recorded attempt. `parseHistory` reads it back. */
export function renderEntry(input: { date: string; round: number; passed: boolean; nextReview: string | null; criteria: readonly CriterionResult[];
  reflection: string; submission?: string; observations?: string }) {
  let entry = `\n\n### ${input.date} · Round ${input.round}\n\n**${input.passed ? 'Passed' : 'Failed'}** · ${input.nextReview === null ? 'Archived' : `Next review ${input.nextReview}`}\n\n`;
  entry += '#### Pass criteria\n\n' + input.criteria.map(item => `- ${item.met ? 'Met' : 'Not met'} \`${item.id}\`: ${oneLine(item.evidence)}`).join('\n') + '\n';
  entry += `\n#### My reflection\n\n${input.reflection}\n`;
  if (input.submission) entry += `\n#### Submission\n\n${input.submission}\n`;
  if (input.observations) entry += `\n#### Feedback\n\n${input.observations}\n`;
  return entry;
}

const HEADING = /^### (\d{4}-\d{2}-\d{2}) · (?:Round (\d+)|第 (\d+) 轮)[ \t]*\n\s*\*\*([^*\n]+)\*\* · /gmu;
const CRITERION = /^- (Met|Not met) `([a-z0-9_]+)`: /gmu;
const CRITERIA_BLOCK = '\n#### Pass criteria\n';

/** The criterion lines of one entry: only its own Pass criteria block, never learner text. */
function criteriaBlock(section: string) {
  const start = section.indexOf(CRITERIA_BLOCK);
  if (start < 0) throw new PracticeError('invalid_practice_history');
  const rest = section.slice(start + CRITERIA_BLOCK.length);
  const end = rest.search(/^#{1,4} /mu);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Reads every attempt in a practice history, oldest first. An attempt starts
 * at a full entry heading followed by its result line; other lines, including
 * learner text that looks like a heading, are content. Rounds must count up
 * from 1 and dates must not go back. Callers that need every attempt compare
 * the count with the item's `review_count`.
 */
export function parseHistory(body: string): HistoryEntry[] {
  const matches = [...body.matchAll(HEADING)];
  return matches.map((match, index) => {
    const round = Number(match[2] ?? match[3]), result = match[4]!;
    const date = match[1]!, previous = matches[index - 1]?.[1];
    if (round !== index + 1 || (previous !== undefined && date < previous)) throw new PracticeError('invalid_practice_history');
    if (result === 'Passed' || result === 'Failed') {
      const section = body.slice(match.index, matches[index + 1]?.index ?? body.length);
      const unmet = [...criteriaBlock(section).matchAll(CRITERION)].filter(line => line[1] === 'Not met').map(line => line[2]!);
      if ((result === 'Passed') !== (unmet.length === 0)) throw new PracticeError('invalid_practice_history');
      return { date, round, passed: result === 'Passed', result, unmet };
    }
    if (!Object.hasOwn(LEGACY_OUTCOMES, result)) throw new PracticeError('invalid_practice_history');
    return { date, round, passed: LEGACY_OUTCOMES[result]!, result, unmet: null };
  });
}
