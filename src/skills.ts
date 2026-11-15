import type { Settings } from './config.js';
import { practiceSkill } from './practice-tools.js';
import type { McpSkill } from './skill.js';

/** Select configured skills here so transport and Lambda code stay domain-independent. */
export function configuredSkills(settings: Settings): readonly McpSkill[] {
  return settings.practice.enabled ? [practiceSkill(settings)] : [];
}
