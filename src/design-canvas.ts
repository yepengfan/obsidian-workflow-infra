import LZString from 'lz-string';
import { z } from 'zod';
import { OperationError } from './errors.js';
import type { Settings } from './config.js';

type CanvasLimits = Pick<Settings['limits'], 'canvasCompressedCharacters' | 'canvasSceneBytes' | 'canvasElements'>;
const sceneSchema = z.looseObject({
  type: z.literal('excalidraw'), version: z.literal(2),
  elements: z.array(z.looseObject({
    id: z.string().min(1).max(100), type: z.string().min(1).max(64),
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  })),
  appState: z.record(z.string(), z.unknown()).optional(),
  files: z.record(z.string(), z.unknown()).optional(),
});

/** Decode drawing data only. Never execute canvas text, links or embedded code. */
function drawingBlock(markdown: string) {
  const blocks = [...markdown.matchAll(/^## Drawing[ \t]*\r?\n\s*```(json|compressed-json)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gmu)];
  if (blocks.length !== 1) throw new OperationError('invalid_design_canvas');
  return blocks[0]!;
}

export function readDesignCanvas(markdown: string, limits: CanvasLimits) {
  const [, encoding, content] = drawingBlock(markdown);
  let json = content!;
  if (encoding === 'compressed-json') {
    const compressed = json.replace(/\s/gu, '');
    if (compressed.length > limits.canvasCompressedCharacters) throw new OperationError('design_canvas_too_large');
    if (!compressed.length || compressed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,3}$/u.test(compressed)) throw new OperationError('invalid_design_canvas');
    try { json = LZString.decompressFromBase64(compressed) ?? ''; }
    catch { throw new OperationError('invalid_design_canvas'); }
  }
  return { encoding: encoding as 'json' | 'compressed-json', drawing: parseScene(json, limits) };
}

export function parseScene(json: string, limits: CanvasLimits) {
  if (Buffer.byteLength(json) > limits.canvasSceneBytes) throw new OperationError('design_canvas_too_large');
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new OperationError('invalid_design_canvas'); }
  if (value && typeof value === 'object' && 'elements' in value && Array.isArray(value.elements) && value.elements.length > limits.canvasElements) {
    throw new OperationError('design_canvas_too_large');
  }
  const parsed = sceneSchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.elements.map(e => e.id)).size !== parsed.data.elements.length) throw new OperationError('invalid_design_canvas');
  return parsed.data;
}

export function writeDesignCanvas(previous: string | undefined, scene: ReturnType<typeof parseScene>) {
  const json = JSON.stringify(scene);
  const labels = scene.elements.filter(e => e.type === 'text' && !e.isDeleted)
    .map(e => {
      const label = String(e.rawText ?? e.originalText ?? e.text)
        .replaceAll('%%', '&#37;&#37;')
        .replace(/^([ \t]*)(#{1,6}(?=\s)|`{3,}|~{3,})/gmu, '$1\\$2');
      return `${label} ^${e.id}`;
    }).join('\n\n');
  const section = '## Text Elements\n' + labels + '\n\n';
  const drawing = (encoding: string) => '## Drawing\n```' + encoding + '\n' +
    (encoding === 'compressed-json' ? LZString.compressToBase64(json) : json) + '\n```';
  if (previous === undefined) {
    return '---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n\n# Excalidraw Data\n\n' +
      section + '%%\n' + drawing('compressed-json') + '\n%%\n';
  }
  const block = drawingBlock(previous);
  const prefix = previous.slice(0, block.index);
  const text = /^## Text Elements[^\S\r\n]*\r?\n([\s\S]*?)(?=^## (?:Embedded Files|Element Links)\s*$|^%%\s*$|(?![\s\S]))/mu;
  const updated = prefix.replace(text, (_match, body: string) => {
    const anchors = [...body.matchAll(/ \^[\w-]+[ \t]*(?:\r?\n|$)/gmu)];
    const last = anchors.at(-1);
    return section + body.slice(last ? last.index + last[0].length : 0).replace(/^\r?\n/u, '');
  });
  return updated + drawing(block[1]!) + previous.slice(block.index + block[0].length);
}
