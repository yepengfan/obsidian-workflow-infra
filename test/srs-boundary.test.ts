import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { domainSchema } from '../src/practice-domains.js';

const core = new URL('../src/srs/', import.meta.url);
const sources = readdirSync(core).filter(name => name.endsWith('.ts')).map(name => ({ name, text: readFileSync(new URL(name, core), 'utf8') }));

describe('SRS core boundary', () => {
  it('names no consuming module', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const { name, text } of sources) {
      for (const domain of domainSchema.options) expect(text, name).not.toContain(domain);
      expect(text, name).not.toMatch(/design|Design/u);
    }
  });

  it('imports only shared schema, error, note and index contracts', () => {
    const allowed = new Set(['../errors.js', '../paths.js', '../practice-note.js', '../practice-schema.js', '../review-index.js']);
    for (const { name, text } of sources) {
      for (const [, path] of text.matchAll(/from '([^']+)'/gu)) {
        if (path!.startsWith('./') || !path!.startsWith('.')) continue;
        expect(allowed, `${name} imports ${path}`).toContain(path);
      }
    }
  });
});
