import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { designSessionTemplate } from '../src/design-session.js';
import { validatePracticeWritePath } from '../src/practice-domains.js';

it('drafts matching progress and valid canvas files with no fabricated learner work', () => {
  const input = { topic: 'Design Dropbox', short_topic: 'Dropbox', source: 'Learner-selected problem' };
  const draft = designSessionTemplate(input, '2026-11-16');
  expect(designSessionTemplate(input, '2026-11-16')).toEqual(draft);
  expect(draft.saved).toBe(false);
  const [progress, canvas] = draft.files;
  expect(progress!.path).toBe('Learning/Practice/System-Design/Solutions/Dropbox-2026-11-16/progress.md');
  const metadata = parse(progress!.content.split('---\n')[1]!);
  expect(metadata).toMatchObject({ topic: input.topic, started: '2026-11-16', source: input.source, tags: ['system-design/wip'] });
  expect(metadata.excalidraw).toBe(`[[${canvas!.path.slice(0, -3)}]]`);
  expect(progress!.content.match(/⬜/gu)).toHaveLength(6);
  expect(progress!.content).toContain('## Next Session');
  const drawing = JSON.parse(canvas!.content.match(/```json\n([^]*?)\n```/u)![1]!);
  expect(drawing).toMatchObject({ type: 'excalidraw', version: 2, files: {} });
  const elements = drawing.elements as { id: string; text: string; y: number; height: number }[];
  expect(new Set(elements.map(element => element.id)).size).toBe(elements.length);
  expect(elements.map(element => element.text).filter(text => /^\d\. /u.test(text))).toHaveLength(6);
  elements.forEach((element, i) => {
    expect(canvas!.content).toContain(`${element.text} ^${element.id}`);
    if (i > 0) expect(element.y).toBeGreaterThan(elements[i - 1]!.y + elements[i - 1]!.height);
  });
  for (const file of draft.files) {
    expect(validatePracticeWritePath(file.path)).toBe('system-design');
    expect(Buffer.byteLength(file.content)).toBeLessThan(65536);
  }
});

it.each(['../Inbox', 'URL/Shortener', 'URL\\Shortener', 'Bad\nName', '.hidden', 'Bad|Name', 'Bad[Name]', 'Bad^Name'])('rejects unsafe session name %j', short_topic => {
  expect(() => designSessionTemplate({ topic: 'A topic', short_topic }, '2026-11-16')).toThrow();
});

it('quotes YAML safely and does not invent a problem source', () => {
  const draft = designSessionTemplate({ topic: 'URL: "shortener"\nwith redirects', short_topic: 'URL-Shortener' }, '2026-11-16');
  expect(parse(draft.files[0]!.content.split('---\n')[1]!)).not.toHaveProperty('source');
  expect(parse(draft.files[0]!.content.split('---\n')[1]!)).toMatchObject({ topic: 'URL: "shortener"\nwith redirects' });
});
