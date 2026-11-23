import { stringify } from 'yaml';
import { z } from 'zod';
import { practiceDomains } from './practice-domains.js';

export const designSessionSchema = z.strictObject({
  topic: z.string().trim().min(1).max(200).refine(value =>
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) && !value.includes('%%') && !value.includes('```'),
    'Use a single-line topic without control characters, %% or code fences'),
  // Keep Unicode filename validation server-side; property escapes are not
  // portable across the regex engines used to import JSON Schema metadata.
  short_topic: z.string().min(1).max(80).refine(value => /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(value),
    'Start with a letter or digit; use only letters, digits, spaces, underscores and hyphens'),
  source: z.string().trim().min(1).max(500).optional(),
});

const steps = ['Requirements', 'Core Entities', 'API / Interface', 'Data Flow', 'High-Level Design', 'Deep Dives'];

/** Build drafts only. No storage, arbitrary script execution, or learner content. */
export function designSessionTemplate(input: z.infer<typeof designSessionSchema>, day: string) {
  const { topic, short_topic: name, source } = designSessionSchema.parse(input);
  const folder = `${practiceDomains['system-design'].root}Solutions/${name}-${day}`;
  const canvas = `${folder}/${name}.excalidraw.md`;
  const progress = `---\n${stringify({ topic, started: day, ...(source ? { source } : {}), excalidraw: `[[${canvas.slice(0, -3)}]]`, tags: ['system-design/wip'] })}---\n\n# ${topic.replace(/[\r\n]/gu, ' ')}\n\n![[${canvas.slice(0, -3)}]]\n\n## Progress\n\n| Step | Status | Notes |\n| --- | --- | --- |\n${steps.map((step, i) => `| ${i + 1}. ${step} | ⬜ | |`).join('\n')}\n\n## Pending Questions\n\n## Key Learnings\n\n## Next Session\n\nStart Step 1: Requirements.\n`;
  // Native draft of the canonical six-step canvas, without running its CLI.
  const requirements = ['1. Requirements', 'Functional Requirements\n1.\n2.\n3.',
    'Non-Functional Requirements\n1.\n2.\n3.', 'Below the line (out of scope)\n1.\n2.',
    'Back-of-Envelope\n- read/write ratio:\n- QPS:\n- storage:'].join('\n\n');
  const sections = [`Design: ${topic}`, requirements, '2. Core Entities', '3. API / Interface',
    '4. Data Flow\n\nWrite Flow:\n\nRead Flow:', '5. High-Level Design', '6. Deep Dives', '7. Final Design'];
  const fontSize = 20;
  let y = 0;
  const elements = sections.map((text, i) => {
    const height = text.split('\n').length * fontSize * 1.25;
    const element = { id: `sd-template-${i}`, type: 'text', x: 100, y,
      width: Math.max(500, ...text.split('\n').map(line => line.length * fontSize * 0.7)), height, angle: 0,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
      index: `a${i.toString(36)}`, roundness: null, seed: i + 1, version: 1,
      versionNonce: i + 1, isDeleted: false, boundElements: null, updated: 0, link: null, locked: false,
      text, fontSize, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null,
      originalText: text, autoResize: true, lineHeight: 1.25 };
    y += height + 120;
    return element;
  });
  const drawing = { type: 'excalidraw', version: 2, source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin',
    elements, appState: { currentItemFontSize: fontSize, theme: 'light', viewBackgroundColor: '#ffffff' }, files: {} };
  const content = `---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n\n# Excalidraw Data\n\n## Text Elements\n${elements.map(element => `${element.text} ^${element.id}`).join('\n\n')}\n\n%%\n## Drawing\n\`\`\`json\n${JSON.stringify(drawing)}\n\`\`\`\n%%\n`;
  return { saved: false, started: day, canvas: { path: canvas, drawing }, files: [{ path: `${folder}/progress.md`, content: progress }, { path: canvas, content }] };
}
