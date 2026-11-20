import type { Settings } from './config.js';
import { createMetadataQuery } from './athena.js';
import { createReviewIndex } from './dynamo-review-index.js';
import { journalSkill } from './journal-tools.js';
import { metadataSkill } from './metadata-tools.js';
import { notesSkill } from './note-tools.js';
import { practiceSkill } from './practice-tools.js';
import type { McpSkill } from './skill.js';

export function configuredSkills(settings: Settings, additionalSkills?: readonly McpSkill[]): readonly McpSkill[] {
  const skills = [notesSkill];
  if (settings.metadataSearch) skills.push(metadataSkill(settings, createMetadataQuery(settings.region)));
  if (settings.journal.writesEnabled) skills.push(journalSkill(settings));
  if (additionalSkills) skills.push(...additionalSkills);
  else if (settings.practice.enabled) skills.push(practiceSkill(settings, createReviewIndex(settings.region)));
  return skills;
}
