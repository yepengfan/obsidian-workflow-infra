import { describe, expect, it } from 'vitest';
import { loadBlockMap, parseBlockMap, type BlockMapSource } from '../src/block-map.js';
import { NoteError } from '../src/paths.js';

const sd = 'Learning/Practice/System-Design/';
const points = (prefix: string, count = 4) => Array.from({ length: count }, (_, index) => `- ${prefix}-${index + 1}: Point ${index + 1}`).join('\n');
const problems = (rows: string) => `## Problems\n\n| problem | note | core | uses |\n| --- | --- | --- | --- |\n${rows}`;
const valid = `---\ntags: [map]\n---\n# Blocks\n\nAnything here, even - a: list.\n\n## caching\nnote: [[Core Concepts/Caching]]\ncards: [[Patterns/Cache-Aside]], [[Patterns/TTL]]\n${points('c')}\n\n` +
  `## redis\nnote: [[Key Technologies/Redis]]\n${points('r', 8)}\n\n` + problems('| bitly | [[Question Breakdowns/Bitly]] | caching | redis |\n| yelp | [[Question Breakdowns/Yelp]] | redis, caching |  |\n');

describe('the block map', () => {
  it('parses blocks, their points and the problem table', () => {
    const parsed = parseBlockMap(valid);
    expect(parsed.errors).toEqual([]);
    expect('map' in parsed && parsed.map).toEqual({
      blocks: [
        { id: 'caching', title: 'Caching', note: sd + 'Core Concepts/Caching.md', cards: [sd + 'Patterns/Cache-Aside.md', sd + 'Patterns/TTL.md'],
          points: [1, 2, 3, 4].map(index => ({ id: `c-${index}`, text: `Point ${index}` })) },
        { id: 'redis', title: 'Redis', note: sd + 'Key Technologies/Redis.md', cards: [], points: [1, 2, 3, 4, 5, 6, 7, 8].map(index => ({ id: `r-${index}`, text: `Point ${index}` })) },
      ],
      problems: [
        { id: 'bitly', note: sd + 'Question Breakdowns/Bitly.md', core: ['caching'], uses: ['redis'] },
        { id: 'yelp', note: sd + 'Question Breakdowns/Yelp.md', core: ['redis', 'caching'], uses: [] },
      ],
    });
  });

  it('reports every error with its line instead of stopping at the first', () => {
    const text = [
      '## caching', 'note: [[Core Concepts/Caching]]', points('c', 3), '- c-1: Repeated', 'Stray prose',
      '## Bad_Id', 'note: [[Core Concepts/Other|alias]]', points('b'),
      '## caching', 'note: [[Core Concepts/Caching]]', points('d'),
      '## solo', points('s'), 'note: [[A]]', 'note: [[B]]', 'cards: Patterns/Plain',
      problems('| bitly | Bitly | | redis |\n| bitly | [[Question Breakdowns/Bitly]] | caching, caching | caching |\n| short | row |\n'),
      'after the table', '## extra',
    ].join('\n');
    const parsed = parseBlockMap(text);
    expect('map' in parsed).toBe(false);
    expect(parsed.errors).toEqual([
      'line 6: duplicate point "c-1" in block "caching"',
      'line 7: unexpected line in block "caching"',
      'line 8: invalid block id "Bad_Id"',
      'line 9: note must be a single [[link]] in block "Bad_Id"',
      'line 14: duplicate block "caching"',
      'line 26: second note in block "solo"',
      'line 27: cards must be [[links]] separated by commas in block "solo"',
      'line 32: problem "bitly" needs a single [[link]] note',
      'line 32: problem "bitly" needs at least one core block',
      'line 33: duplicate problem "bitly"',
      'line 33: problem "bitly" repeats a block in core',
      'line 33: problem "bitly" lists "caching" as both core and uses',
      'line 34: a problem row needs 4 cells',
      'line 36: only the problem table may follow the Problems heading',
      'line 37: no section may follow Problems',
      'line 14: blocks "caching" and "caching" link the same note',
      'line 32: problem "bitly" refers to unknown block "redis"',
    ]);
  });

  it.each([
    { name: 'a map without blocks', text: problems(''), error: 'the map defines no blocks' },
    { name: 'a map without a problem table', text: `## caching\nnote: [[Core Concepts/Caching]]\n${points('c')}\n`, error: 'the map has no Problems section' },
    { name: 'a table without its separator', text: `## caching\nnote: [[Core Concepts/Caching]]\n${points('c')}\n## Problems\n| problem | note | core | uses |\n`, error: 'the Problems section has no table' },
    { name: 'a block with too many points', text: `## caching\nnote: [[Core Concepts/Caching]]\n${points('c', 9)}\n` + problems(''), error: 'line 1: block "caching" has 9 points; it needs 4 to 8' },
    { name: 'a point without text', text: `## caching\nnote: [[Core Concepts/Caching]]\n${points('c')}\n- blank:    \n` + problems(''), error: 'line 7: point "blank" has no text' },
    { name: 'a block without a note', text: `## caching\n${points('c')}\n` + problems(''), error: 'line 1: block "caching" has no note' },
    { name: 'a link leaving the folder', text: `## caching\nnote: [[../Secrets]]\n${points('c')}\n` + problems(''), error: 'line 2: note must be a single [[link]] in block "caching"' },
    { name: 'a wrong table header', text: `## caching\nnote: [[Core Concepts/Caching]]\n${points('c')}\n## Problems\n| problem | core | uses |\n| --- | --- | --- |\n`,
      error: 'line 8: the problem table header must be | problem | note | core | uses |' },
  ])('rejects $name', ({ text, error }) => {
    expect(parseBlockMap(text).errors).toContain(error);
  });

  it('loads a map only when every linked note exists', async () => {
    const notes = new Set([sd + 'Core Concepts/Caching.md', sd + 'Key Technologies/Redis.md', sd + 'Patterns/Cache-Aside.md', sd + 'Patterns/TTL.md',
      sd + 'Question Breakdowns/Bitly.md', sd + 'Question Breakdowns/Yelp.md']);
    const listed: string[] = [];
    const source = (text: string | undefined): BlockMapSource => ({
      read: async () => { if (text === undefined) throw new NoteError('note_unavailable'); return { text }; },
      notesIn: async folder => { listed.push(folder); return [...notes].filter(path => path.startsWith(folder) && !path.slice(folder.length).includes('/')); },
    });
    await expect(loadBlockMap(source(valid))).resolves.toMatchObject({ blocks: [{ id: 'caching' }, { id: 'redis' }] });
    expect(listed.sort()).toEqual(['Core Concepts/', 'Key Technologies/', 'Patterns/', 'Question Breakdowns/'].map(folder => sd + folder));
    await expect(loadBlockMap(source(undefined))).rejects.toThrow('block_map_missing');
    await expect(loadBlockMap(source('## caching\n'))).rejects.toMatchObject({ code: 'invalid_block_map', details: expect.arrayContaining(['the map has no Problems section']) });
    notes.delete(sd + 'Patterns/TTL.md');
    await expect(loadBlockMap(source(valid))).rejects.toMatchObject({ code: 'invalid_block_map', details: ['linked note does not exist: Patterns/TTL'] });
  });
});
