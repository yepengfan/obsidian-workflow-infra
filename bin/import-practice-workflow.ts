import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An explicit source refresh, never a deployment-time network fetch.
const root = await realpath(process.argv[2] ?? '');
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const repository = git('remote', 'get-url', 'origin');
if (!/^(?:https:\/\/github\.com\/|git@github\.com:)yepengfan\/obsidian-workflow(?:\.git)?$/u.test(repository)) throw Error('Expected the canonical workflow repository');
const paths = [
  '.agents/skills/practice/SKILL.md', '.agents/skills/practice-review-add/SKILL.md',
  '.agents/skills/practice-review-today/SKILL.md', '.agents/skills/algo-solve/SKILL.md', '.agents/skills/sysd-solve/SKILL.md',
  'Learning/Practice/Review/AGENTS.md', 'Learning/Practice/Algorithm/AGENTS.md', 'Learning/Practice/System-Design/AGENTS.md',
  'Learning/Practice/Review/Flows/behavioral.md',
  ...['algorithm', 'system-design', 'behavioral'].map(domain => `Learning/Practice/Review/Content/${domain}.md`),
  ...['practice-review', 'algorithm', 'system-design'].map(module => `system/modules/${module}/module.md`),
  ...['Algorithm Pattern', 'Algorithm Atom', 'Algorithm Log', 'SD Pattern', 'SD Log'].map(name => `Templates/${name}.md`),
  'scripts/practice-review/review.py', 'scripts/sd-excalidraw-template.js',
];
const dirty = git('status', '--porcelain', '--', ...paths);
if (dirty) throw Error('Commit the canonical workflow changes before importing');
const documents: Record<string, { sha256: string; text: string }> = {};
for (const name of paths) {
  git('ls-files', '--error-unmatch', '--', name);
  const resolved = await realpath(path.join(root, name));
  if (!resolved.startsWith(root + path.sep)) throw Error('Source escapes the workflow checkout');
  const bytes = await readFile(resolved);
  if (bytes.length > 200000) throw Error('Workflow source is too large');
  documents[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8').replaceAll('\u2014', '-') };
}
await writeFile(fileURLToPath(new URL('../workflows/practice.json', import.meta.url)), JSON.stringify({
  schemaVersion: 1, generatedBy: 'bin/import-practice-workflow.ts - do not edit manually', canvasTemplate: execFileSync(process.execPath, [path.join(root, 'scripts/sd-excalidraw-template.js'), 'MCP_TOPIC_PLACEHOLDER'], { encoding: 'utf8', env: {} }), repository: 'https://github.com/yepengfan/obsidian-workflow', sourceCommit: git('rev-parse', 'HEAD'), documents,
}, null, 2) + '\n');
console.log('Imported canonical practice workflow definitions. No private review items or notes included.');
