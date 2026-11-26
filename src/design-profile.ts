import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { dateSchema } from './practice-schema.js';

export const conceptIdSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u).max(80);

export const conceptObservationSchema = z.strictObject({
  observation_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).max(80),
  concept_id: conceptIdSchema,
  error_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).max(80).optional(),
  date: dateSchema.optional(),
  performance: z.enum(['mastered', 'partial', 'weak', 'uncovered']),
  summary: z.string().trim().min(1).max(500),
  anchor: z.string().trim().min(1).max(200),
  learner: z.boolean().default(true),
  evidence_order: z.number().int().nonnegative().optional(),
});

export type ConceptObservation = z.infer<typeof conceptObservationSchema>;
export type StoredObservation = ConceptObservation & { attempt_id: string; date: string };

const storedObservationSchema = conceptObservationSchema.extend({ attempt_id: z.string().min(1) }).strip();

const fence = /```practice-observations\r?\n([\s\S]*?)```/u;

export function parseObservations(body: string, completionDate?: string, options: { deferUndated?: boolean } = {}): StoredObservation[] {
  const match = fence.exec(body);
  if (!match) return [];
  const parsed = parse(match[1] ?? '');
  return z.array(storedObservationSchema).parse(parsed).flatMap(row => {
    const date = row.date ?? completionDate;
    if (date === undefined && options.deferUndated) return [];
    return [{ ...row, date: dateSchema.parse(date) }];
  });
}

export function upsertObservations(body: string, incoming: readonly StoredObservation[], completionDate?: string): string {
  const merged = new Map(parseObservations(body, completionDate).map(item => [item.observation_id, item]));
  for (const item of incoming) merged.set(item.observation_id, item);
  const block = '```practice-observations\n' + stringify([...merged.values()]) + '```';
  return fence.test(body) ? body.replace(fence, () => block) : body.replace(/\s*$/u, '\n\n') + block + '\n';
}

export function orderedObservations(observations: readonly StoredObservation[]): StoredObservation[] {
  const dated = [...new Map(observations.map(item => [item.observation_id, item])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
  const days = new Map<string, StoredObservation[]>();
  for (const item of dated) days.set(item.date, [...(days.get(item.date) ?? []), item]);
  return [...days.values()].flatMap(items => {
    const explicit = items.filter(item => item.evidence_order !== undefined)
      .sort((a, b) => a.evidence_order! - b.evidence_order!);
    let index = 0;
    return items.map(item => item.evidence_order === undefined ? item : explicit[index++]!);
  });
}

export function renderProfile(observations: readonly StoredObservation[]): string {
  const ordered = orderedObservations(observations);
  const evidenced = ordered.filter(item => item.learner && item.performance !== 'uncovered');
  const byConcept = new Map<string, StoredObservation[]>();
  for (const item of evidenced) byConcept.set(item.concept_id, [...(byConcept.get(item.concept_id) ?? []), item]);
  const lines = ['# System Design profile', '', 'Generated from assessment observations. The latest learner answer is the current conclusion.'];
  for (const [concept, items] of byConcept) {
    const current = items[items.length - 1]!;
    const contrary = items.filter(item => item.observation_id !== current.observation_id && item.performance !== current.performance);
    lines.push('', `## ${concept}`, '', `Current: ${current.performance}. ${current.summary}`, '', `Evidence: ${current.date} ${current.observation_id}.`);
    if (contrary.length) lines.push('', 'Contrary evidence: ' + contrary.map(item => `${item.date} ${item.observation_id} ${item.performance}`).join('; ') + '.');
  }
  const errors = new Map<string, StoredObservation[]>();
  for (const item of evidenced.filter(item => item.performance === 'weak' || item.performance === 'partial')) {
    if (item.error_id) errors.set(item.error_id, [...(errors.get(item.error_id) ?? []), item]);
  }
  if ([...errors.values()].some(items => new Set(items.map(item => item.attempt_id)).size > 1)) lines.push('', '## Repeated errors');
  for (const [errorId, repeated] of errors) {
    if (new Set(repeated.map(item => item.attempt_id)).size > 1) {
      lines.push('', `Repeated error: ${errorId}. ${repeated[0]!.summary} Evidence: ${repeated.map(item => item.observation_id).join(', ')}.`);
    }
  }
  return lines.join('\n') + '\n\n```practice-observations\n' + stringify(ordered) + '```\n';
}

export function designOutline(concepts: readonly string[], observations: readonly StoredObservation[]) {
  const ordered = orderedObservations(observations).filter(item => item.learner && item.performance !== 'uncovered');
  const entries = [...new Set(concepts)].map(concept_id => {
    const evidence = ordered.filter(item => item.concept_id === concept_id);
    const current = evidence.at(-1);
    return { concept_id, performance: current?.performance ?? 'uncovered', evidence };
  });
  return { problem_concepts: [...new Set(concepts)], follow_ups: [
    ...entries.filter(item => item.performance !== 'mastered').map(item => ({ ...item, kind: 'probe' })),
    ...entries.filter(item => item.performance === 'mastered').map(item => ({ ...item, kind: 'variant' })),
  ] };
}
