import type { Settings } from './config.js';
import { createMetadataQuery } from './athena.js';
import { createReviewIndex } from './dynamo-review-index.js';
import { journalSkill } from './journal-tools.js';
import { metadataSkill } from './metadata-tools.js';
import { notesSkill } from './note-tools.js';
import { practiceSkill } from './practice-tools.js';
import type { McpSkill } from './skill.js';

/** Select configured skills here so transport and Lambda code stay domain-independent. */
export function configuredSkills(settings: Settings, additionalSkills?: readonly McpSkill[]): readonly McpSkill[] {
  return [notesSkill, ...(settings.metadataSearch ? [metadataSkill(settings, createMetadataQuery(settings.region))] : []),
    ...(settings.journal.writesEnabled ? [journalSkill(settings)] : []),
    ...(additionalSkills ?? (settings.practice.enabled ? [practiceSkill(settings, createReviewIndex(settings.region))] : []))];
}
