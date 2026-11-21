import LZString from 'lz-string';
import { expect, it } from 'vitest';
import config from '../config/mcp-runtime.json' with { type: 'json' };
import { readDesignCanvas } from '../src/design-canvas.js';

const drawing = {
  type: 'excalidraw', version: 2, source: 'test',
  elements: [
    { id: 'node', type: 'rectangle', x: 100, y: 50, width: 200, height: 100, boundElements: [{ id: 'edge', type: 'arrow' }] },
    { id: 'edge', type: 'arrow', x: 300, y: 100, width: 150, height: 0, points: [[0, 0], [150, 0]], startBinding: { elementId: 'node', focus: 0, gap: 1 } },
  ], appState: { viewBackgroundColor: '#ffffff', zoom: { value: 1 } },
  files: { asset: { id: 'asset', mimeType: 'image/png', dataURL: 'data:image/png;base64,dGVzdA==', created: 1 } },
};
const markdown = (json: string, compressed = false) => `---\ntags: [excalidraw]\n---\n\n## Text Elements\nOld summary ^old\n\n%%\n## Drawing\n\`\`\`${compressed ? 'compressed-json' : 'json'}\n${compressed ? LZString.compressToBase64(json) : json}\n\`\`\`\n%%\n`;

it.each([false, true])('preserves the whole native scene from drawing data (compressed: %s)', compressed => {
  expect(readDesignCanvas(markdown(JSON.stringify(drawing), compressed), config.limits)).toEqual({
    encoding: compressed ? 'compressed-json' : 'json', drawing,
  });
});

it.each(['', '## Drawing\n```json\nnot JSON\n```', '## Drawing\n```compressed-json\nAAAA\n```',
  markdown(JSON.stringify(drawing)) + markdown(JSON.stringify(drawing)),
  markdown(JSON.stringify({ ...drawing, type: 'not-excalidraw' })),
  markdown(JSON.stringify({ ...drawing, elements: [drawing.elements[0], drawing.elements[0]] })),
  markdown(JSON.stringify({ ...drawing, elements: [{ id: 'missing-geometry', type: 'text' }] })),
])('rejects malformed or ambiguous canvases without returning a replacement scene', value => {
  expect(() => readDesignCanvas(value, config.limits)).toThrow('invalid_design_canvas');
});

it('bounds compressed input and expanded scene output before parsing it', () => {
  expect(() => readDesignCanvas('## Drawing\n```compressed-json\n' + 'A'.repeat(20) + '\n```', { ...config.limits, canvasCompressedCharacters: 16 })).toThrow('design_canvas_too_large');
  expect(() => readDesignCanvas(markdown('x'.repeat(200), true), { ...config.limits, canvasSceneBytes: 100 })).toThrow('design_canvas_too_large');
});
