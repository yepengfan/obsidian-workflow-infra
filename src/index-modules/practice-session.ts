import { z } from 'zod';
import { practiceDomains } from '../practice-domains.js';
import type { IndexedModule } from './types.js';

const tags = ['system-design/planned', 'system-design/wip', 'system-design/done'];
const metadata = z.object({
  topic: z.string().trim().min(1).max(500),
  started: z.iso.date().nullish(),
  round_completed_on: z.iso.date().nullish(),
  tags: z.union([z.string(), z.array(z.string())]),
}).transform(value => {
  const states = (Array.isArray(value.tags) ? value.tags : [value.tags]).filter(tag => tags.includes(tag));
  return { topic: value.topic, started: value.started ?? null, round_completed_on: value.round_completed_on ?? null, states };
}).refine(value => value.states.length === 1, 'Expected one session status')
  .transform(({ topic, started, round_completed_on, states }) => ({ topic, started, round_completed_on, status: states[0]!.split('/')[1]! }));

export const solutions = practiceDomains['system-design'].root + 'Solutions/';
export const practiceSessionIndex: IndexedModule<z.output<typeof metadata>> = {
  id: 'practice-session',
  sourcePrefix: solutions,
  childNote: 'progress.md',
  matches: key => /^([^/]+)\/progress\.md$/u.exec(key)?.[1],
  metadata,
  detail: body => ({ current_step: /^\|\s*([^|\n]+?)\s*\|\s*🔄[^|\n]*\|/mu.exec(body)?.[1]?.trim() ?? null }),
  indexes: { status: { partition: row => row.round_completed_on ? 'done' : row.status, sort: row => row.started ?? '0000-00-00' } },
};
