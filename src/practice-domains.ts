import { z } from 'zod';
import { NoteError, validPath } from './paths.js';

export const domainSchema = z.enum(['algorithm', 'system-design']);
export type PracticeDomain = z.infer<typeof domainSchema>;

export const sharedPracticeDocuments = [
  '.agents/skills/practice-review-add/SKILL.md', '.agents/skills/practice-review-today/SKILL.md',
  'Learning/Practice/Review/AGENTS.md', 'system/modules/practice-review/module.md',
];

/** Domain policy is shared by the service, instruction importer and IAM synthesis. */
export const practiceDomains = {
  algorithm: {
    label: 'Algorithm', flow: '.agents/skills/algo-solve/SKILL.md',
    module: 'system/modules/algorithm/module.md', root: 'Learning/Practice/Algorithm/',
    writes: ['Patterns/*.md', 'Atoms/*.md', 'Log/*.md'],
    documents: ['Learning/Practice/Algorithm/AGENTS.md', 'Learning/Practice/Review/Content/algorithm.md',
      'Templates/Algorithm Pattern.md', 'Templates/Algorithm Atom.md', 'Templates/Algorithm Log.md'],
  },
  'system-design': {
    label: 'System Design', flow: '.agents/skills/sysd-solve/SKILL.md',
    module: 'system/modules/system-design/module.md', root: 'Learning/Practice/System-Design/',
    writes: ['Patterns/*.md', 'Insights/*.md', 'Log/*.md', 'Solutions/*/progress.md', 'Solutions/*/*.excalidraw.md'],
    documents: ['Learning/Practice/System-Design/AGENTS.md', 'Learning/Practice/Review/Content/system-design.md',
      'Templates/SD Pattern.md', 'Templates/SD Log.md'],
  },
} satisfies Record<PracticeDomain, { label: string; flow: string; module: string; root: string; writes: string[]; documents: string[] }>;

export function practiceDocuments(domain: PracticeDomain) {
  const definition = practiceDomains[domain];
  return [...sharedPracticeDocuments, definition.flow, definition.module, ...definition.documents];
}

export const practiceWriteResources = ['Learning/Practice/Review/Items/*.md',
  ...Object.values(practiceDomains).flatMap(domain => domain.writes.map(path => domain.root + path))];

export function practiceNoteDomain(path: string): PracticeDomain {
  validPath(path);
  const domain = domainSchema.options.find(domain => path.startsWith(practiceDomains[domain].root));
  if (!domain) throw new NoteError('invalid_path');
  return domain;
}

export function validatePracticeWritePath(path: string): PracticeDomain {
  const domain = practiceNoteDomain(path), definition = practiceDomains[domain];
  const relative = path.slice(definition.root.length);
  const allowed = definition.writes.some(pattern => new RegExp('^' + pattern.split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]+') + '$', 'u').test(relative));
  if (!allowed || /(?:^|\/)(?:AGENTS|CLAUDE|Guide|00_index)\.md$/iu.test(path)) throw new NoteError('invalid_path');
  return domain;
}
