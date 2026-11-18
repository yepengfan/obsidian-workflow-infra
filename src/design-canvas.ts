import LZString from 'lz-string';
import { z } from 'zod';
import { OperationError } from './errors.js';

const maxSceneBytes = 96 * 1024;
const maxCompressedCharacters = 16 * 1024;
const sceneSchema = z.looseObject({
  type: z.literal('excalidraw'), version: z.literal(2),
  elements: z.array(z.looseObject({
    id: z.string().min(1).max(100), type: z.string().min(1).max(64),
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  })).max(500),
  appState: z.record(z.string(), z.unknown()).optional(),
  files: z.record(z.string(), z.unknown()).optional(),
});

/** Decode drawing data only. Never execute canvas text, links or embedded code. */
export function readDesignCanvas(markdown: string) {
  const blocks = [...markdown.matchAll(/^## Drawing[ \t]*\r?\n\s*```(json|compressed-json)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gmu)];
  if (blocks.length !== 1) throw new OperationError('invalid_design_canvas');
  const [, encoding, content] = blocks[0]!;
  let json = content!;
  if (encoding === 'compressed-json') {
    const compressed = json.replace(/\s/gu, '');
    if (compressed.length > maxCompressedCharacters) throw new OperationError('design_canvas_too_large');
    if (!compressed.length || compressed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,3}$/u.test(compressed)) throw new OperationError('invalid_design_canvas');
    try { json = LZString.decompressFromBase64(compressed) ?? ''; }
    catch { throw new OperationError('invalid_design_canvas'); }
  }
  if (Buffer.byteLength(json) > maxSceneBytes) throw new OperationError('design_canvas_too_large');
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new OperationError('invalid_design_canvas'); }
  const parsed = sceneSchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.elements.map(e => e.id)).size !== parsed.data.elements.length) throw new OperationError('invalid_design_canvas');
  return { encoding: encoding as 'json' | 'compressed-json', drawing: parsed.data };
}
