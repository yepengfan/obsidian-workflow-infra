import { PracticeError } from './errors.js';
import { NoteError, validPath } from './paths.js';
import { BLOCK_MAP, practiceDomains } from './practice-domains.js';

/** One examinable point of a block, such as `occ` in Dealing with Contention. */
export interface BlockPoint { readonly id: string; readonly text: string }
export interface Block {
  readonly id: string;
  /** The article's file name. */
  readonly title: string;
  /** Vault path of the block's article. */
  readonly note: string;
  /** Vault paths of pattern cards filed under the block as examples. */
  readonly cards: readonly string[];
  readonly points: readonly BlockPoint[];
}
export interface Problem {
  readonly id: string;
  readonly note: string;
  /** Blocks the problem cannot be designed without. */
  readonly core: readonly string[];
  readonly uses: readonly string[];
}
export interface BlockMap { readonly blocks: readonly Block[]; readonly problems: readonly Problem[] }

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const POINT = /^- ([^:\s]+): (.+)$/u;
const LINK = /^\[\[([^[\]|#^]+)\]\]$/u;
const PROBLEMS = 'Problems';
const HEADER = ['problem', 'note', 'core', 'uses'];
const MIN_POINTS = 4, MAX_POINTS = 8;
const SD_ROOT = practiceDomains['system-design'].root;

/** Resolves an Obsidian link relative to the System Design folder, or null when it is not a plain note link. */
function linkPath(value: string) {
  const match = LINK.exec(value.trim());
  if (!match || match[1]!.trim() !== match[1]) return null;
  try { return validPath(`${SD_ROOT}${match[1]}.md`); } catch (error) {
    if (error instanceof NoteError) return null;
    throw error;
  }
}
const cells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
const idList = (cell: string) => cell === '' ? [] : cell.split(',').map(id => id.trim());

/**
 * Parses `Blocks.md` strictly: one `## <block-id>` section per block with its
 * `note`, optional `cards` and 4 to 8 `- <point-id>: <text>` lines, then a
 * `## Problems` table. Text before the first section is free. Returns every
 * error rather than the first.
 */
export function parseBlockMap(text: string): { map: BlockMap; errors: readonly [] } | { errors: readonly string[] } {
  const lines = text.split(/\r?\n/u);
  const errors: string[] = [];
  const fail = (index: number, message: string) => { errors.push(`line ${index + 1}: ${message}`); };
  let start = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    start = end < 0 ? lines.length : end + 1;
    if (end < 0) fail(0, 'unclosed frontmatter');
  }
  type Draft = { id: string; line: number; note?: string; cards?: string[]; points: BlockPoint[] };
  const blocks: Draft[] = [], problems: (Problem & { line: number })[] = [];
  let section: 'preamble' | 'block' | 'problems' | 'done' = 'preamble', table = 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('## ')) {
      const name = line.slice(3).trim();
      if (section === 'problems' || section === 'done') { fail(index, 'no section may follow Problems'); section = 'done'; continue; }
      if (name === PROBLEMS) { section = 'problems'; continue; }
      if (!ID.test(name) || name.length > 80) fail(index, `invalid block id "${name}"`);
      else if (blocks.some(block => block.id === name)) fail(index, `duplicate block "${name}"`);
      blocks.push({ id: name, line: index, points: [] });
      section = 'block';
      continue;
    }
    if (section === 'preamble' || section === 'done' || line.trim() === '') continue;
    if (section === 'block') {
      const block = blocks.at(-1)!;
      const field = /^(note|cards): (.*)$/u.exec(line);
      const point = POINT.exec(line);
      if (field?.[1] === 'note') {
        if (block.note !== undefined) fail(index, `second note in block "${block.id}"`);
        const path = linkPath(field[2]!);
        if (!path) fail(index, `note must be a single [[link]] in block "${block.id}"`);
        block.note = path ?? '';
      } else if (field?.[1] === 'cards') {
        if (block.cards !== undefined) fail(index, `second cards line in block "${block.id}"`);
        const paths = field[2]!.split(',').map(linkPath);
        if (!paths.length || paths.some(path => path === null)) fail(index, `cards must be [[links]] separated by commas in block "${block.id}"`);
        block.cards = paths.filter(path => path !== null);
      } else if (point) {
        const [, id, value] = point;
        if (!ID.test(id!) || id!.length > 64) fail(index, `invalid point id "${id}" in block "${block.id}"`);
        else if (block.points.some(item => item.id === id)) fail(index, `duplicate point "${id}" in block "${block.id}"`);
        else if (value!.trim().length > 300) fail(index, `point "${id}" is longer than 300 characters`);
        block.points.push({ id: id!, text: value!.trim() });
      } else fail(index, `unexpected line in block "${block.id}"`);
      continue;
    }
    // Problems table: header, separator, then one row per problem.
    if (!line.trim().startsWith('|')) { fail(index, 'only the problem table may follow the Problems heading'); continue; }
    const row = cells(line);
    if (table === 0) {
      if (row.join('|') !== HEADER.join('|')) fail(index, `the problem table header must be | ${HEADER.join(' | ')} |`);
    } else if (table === 1) {
      if (row.length !== HEADER.length || row.some(cell => !/^:?-{3,}:?$/u.test(cell))) fail(index, 'the problem table needs a separator row');
    } else if (row.length !== HEADER.length) fail(index, `a problem row needs ${HEADER.length} cells`);
    else {
      const [id, noteCell, coreCell, usesCell] = row as [string, string, string, string];
      const note = linkPath(noteCell);
      if (!ID.test(id) || id.length > 120) fail(index, `invalid problem id "${id}"`);
      else if (problems.some(problem => problem.id === id)) fail(index, `duplicate problem "${id}"`);
      if (!note) fail(index, `problem "${id}" needs a single [[link]] note`);
      const core = idList(coreCell), uses = idList(usesCell);
      if (!core.length) fail(index, `problem "${id}" needs at least one core block`);
      for (const [column, ids] of [['core', core], ['uses', uses]] as const) {
        if (new Set(ids).size !== ids.length) fail(index, `problem "${id}" repeats a block in ${column}`);
      }
      for (const block of new Set(core.filter(block => uses.includes(block)))) fail(index, `problem "${id}" lists "${block}" as both core and uses`);
      problems.push({ id, note: note ?? '', core, uses, line: index });
    }
    table++;
  }
  if (!blocks.length) errors.push('the map defines no blocks');
  if (section !== 'problems' && section !== 'done') errors.push('the map has no Problems section');
  else if (table < 2) errors.push('the Problems section has no table');
  const notes = new Map<string, string>();
  for (const block of blocks) {
    if (block.note === undefined) fail(block.line, `block "${block.id}" has no note`);
    else if (block.note && notes.has(block.note)) fail(block.line, `blocks "${notes.get(block.note)}" and "${block.id}" link the same note`);
    else if (block.note) notes.set(block.note, block.id);
    if (block.points.length < MIN_POINTS || block.points.length > MAX_POINTS) {
      fail(block.line, `block "${block.id}" has ${block.points.length} points; it needs ${MIN_POINTS} to ${MAX_POINTS}`);
    }
  }
  const defined = new Set(blocks.map(block => block.id));
  for (const problem of problems) {
    for (const id of [...problem.core, ...problem.uses]) if (!defined.has(id)) fail(problem.line, `problem "${problem.id}" refers to unknown block "${id}"`);
  }
  if (errors.length) return { errors };
  return { errors: [], map: {
    blocks: blocks.map(({ id, note, cards, points }) => ({ id, title: note!.slice(note!.lastIndexOf('/') + 1, -3), note: note!, cards: cards ?? [], points })),
    problems: problems.map(({ id, note, core, uses }) => ({ id, note, core, uses })),
  } };
}

/** Narrow read access the loader needs: one note, and the note paths directly inside a folder. */
export interface BlockMapSource {
  read(path: string): Promise<{ text: string }>;
  notesIn(folder: string): Promise<readonly string[]>;
}

/**
 * Reads and checks the block map: it must exist, parse, and link only to
 * notes that exist. Throws `block_map_missing`, or `invalid_block_map` with every error as details.
 */
export async function loadBlockMap(source: BlockMapSource): Promise<BlockMap> {
  let text: string;
  try { ({ text } = await source.read(BLOCK_MAP)); } catch (error) {
    if (error instanceof NoteError && error.code === 'note_unavailable') throw new PracticeError('block_map_missing');
    throw error;
  }
  const parsed = parseBlockMap(text);
  if (!('map' in parsed)) throw new PracticeError('invalid_block_map', parsed.errors);
  const { map } = parsed;
  const links = [...map.blocks.flatMap(block => [block.note, ...block.cards]), ...map.problems.map(problem => problem.note)];
  const folders = [...new Set(links.map(path => path.slice(0, path.lastIndexOf('/') + 1)))];
  const existing = new Set((await Promise.all(folders.map(folder => source.notesIn(folder)))).flat());
  const missing = [...new Set(links.filter(path => !existing.has(path)))];
  if (missing.length) throw new PracticeError('invalid_block_map', missing.map(path => `linked note does not exist: ${path.slice(SD_ROOT.length, -3)}`));
  return map;
}
