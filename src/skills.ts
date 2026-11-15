import type { Settings } from './config.js';
import { notesSkill } from './note-tools.js';
import { practiceSkill } from './practice-tools.js';
import type { McpSkill } from './skill.js';

/** Select configured skills here so transport and Lambda code stay domain-independent. */
export function configuredSkills(settings: Settings, additionalSkills?: readonly McpSkill[]): readonly McpSkill[] {
  return [notesSkill, ...(additionalSkills ?? (settings.practice.enabled ? [practiceSkill(settings)] : []))];
}
