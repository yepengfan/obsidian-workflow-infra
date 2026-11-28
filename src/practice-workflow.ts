import { z } from 'zod';
import bundle from '../workflows/practice.json' with { type: 'json' };
import { PracticeError } from './errors.js';
import { NoteError } from './paths.js';
import { parsePracticeNote } from './practice-note.js';
import { domainSchema, practiceDocuments, practiceDomains, sharedPracticeDocuments, type PracticeDomain } from './practice-domains.js';
import { slugSchema } from './practice-schema.js';
import type { PracticeOptions } from './practice-options.js';
import { criterionIdSchema, type PassCriterion } from './srs/criteria.js';
import { calendarDay } from './srs/schedule.js';

const days = z.number().int().min(1).max(3650);
const criterionSchema = z.strictObject({ id: criterionIdSchema, rule: z.string().trim().min(1).max(500) });
const uniqueIds = (criteria: readonly { id: string }[]) => new Set(criteria.map(item => item.id)).size === criteria.length;
/** The practice-review module: the global schedule rule, shared criteria and the consumers table. */
const moduleSchema = z.object({ enabled: z.boolean(),
  schedule: z.strictObject({ intervals: z.array(days).min(1).max(20),
    on_fail: z.strictObject({ step_back: z.number().int().min(0).max(20), retry_days: days }), archive_after_final: z.boolean() }),
  shared_criteria: z.array(criterionSchema).max(20).refine(uniqueIds).default([]),
  consumers: z.record(z.string(), z.unknown()) });
/** One module's registration in the practice-review `consumers` table. */
const consumerSchema = z.strictObject({ enabled: z.boolean(), module: slugSchema, flow: z.string(), time_limit: z.unknown().optional(),
  placement_interval: z.unknown().optional() });
/** A module's own pass criteria: shared criteria by id, or its own with a rule. */
const passCriteriaSchema = z.array(z.union([criterionIdSchema, criterionSchema])).min(1).max(20);
type ModuleConfig = z.infer<typeof moduleSchema>;
/** `placement_interval` is set for a module that places familiar items; `placement_stage` is the stage that waits it. */
type DomainPolicy = { time_limit: number; pass_criteria: PassCriterion[]; placement_interval?: number; placement_stage?: number };
type DomainAvailability = { domain: PracticeDomain; label: string } & (
  ({ status: 'enabled' } & DomainPolicy) | { status: 'disabled' | 'unavailable'; reason: string; errors?: readonly string[] });
/** A module's own availability condition beyond its configuration, such as a valid data file. */
export type DomainCheck = () => Promise<void>;

/** Reads the practice-review module's settings; invalid settings fail every module. */
export function reviewConfig(metadata: Record<string, unknown>) {
  const parsed = moduleSchema.safeParse(metadata);
  if (!parsed.success) throw new PracticeError('invalid_practice_config');
  return parsed.data;
}

/** Resolves shared references; an unknown reference or a repeated id is invalid. */
export function passCriteria(declared: unknown, shared: readonly PassCriterion[]): PassCriterion[] {
  const parsed = passCriteriaSchema.safeParse(declared);
  if (!parsed.success) throw new PracticeError('invalid_pass_criteria');
  const criteria = parsed.data.map(item => typeof item === 'string' ? shared.find(criterion => criterion.id === item) : item);
  if (criteria.some(item => item === undefined) || !uniqueIds(criteria as PassCriterion[])) throw new PracticeError('invalid_pass_criteria');
  return criteria as PassCriterion[];
}

const documents: Record<string, { text: string; sha256: string }> = bundle.documents;
const adaptations: Partial<Record<string, string>> = bundle.adaptations;
/** A domain's own MCP adaptations, after the shared entry. */
const adaptation = (domain: PracticeDomain) => adaptations[domain] ? '\n' + adaptations[domain] : '';
const placementIntervals = (policies: readonly ({ domain: PracticeDomain } & DomainPolicy)[]) =>
  Object.fromEntries(policies.flatMap(policy => policy.placement_interval ? [[policy.domain, policy.placement_interval]] : []));
/** Switched off on purpose, as opposed to broken or misconfigured. */
const disabledReasons = new Set(['consumer_disabled', 'domain_module_disabled']);

export class PracticeWorkflow {
  constructor(
    private readonly options: PracticeOptions,
    private readonly read: (path: string) => Promise<{ text: string }>,
    private readonly now: () => Date,
    private readonly signal: AbortSignal,
    private readonly checks: Partial<Record<PracticeDomain, DomainCheck>> = {},
  ) {}

  async config(domain?: z.infer<typeof domainSchema>) {
    if (!this.options.enabled) throw new PracticeError('practice_disabled');
    const note = await this.read('system/modules/practice-review/module.md');
    const config = reviewConfig(parsePracticeNote(note.text).metadata);
    if (!config.enabled) throw new PracticeError('practice_module_disabled');
    return { ...config, policy: domain === undefined ? undefined : await this.checkDomain(config, domain) };
  }
  /**
   * A module can be reviewed only when all five hold: practice review is
   * enabled (checked by `config`), its consumer entry is enabled, its own
   * module is enabled, the entry, the module's pass criteria and any data its
   * own check covers are valid, and its workflow was imported. Returns the
   * time limit, pass criteria and any placement.
   */
  private async checkDomain(config: ModuleConfig, domain: PracticeDomain): Promise<DomainPolicy> {
    const definition = practiceDomains[domainSchema.parse(domain)];
    if (!Object.hasOwn(config.consumers, domain)) throw new PracticeError('consumer_not_registered');
    const consumer = consumerSchema.safeParse(config.consumers[domain]);
    if (!consumer.success || `system/modules/${consumer.data.module}/module.md` !== definition.module) throw new PracticeError('invalid_consumer_config');
    if (!consumer.data.enabled) throw new PracticeError('consumer_disabled');
    const guard = await this.read(definition.module);
    const metadata = parsePracticeNote(guard.text).metadata;
    if (typeof metadata.enabled !== 'boolean') throw new PracticeError('invalid_domain_module');
    if (!metadata.enabled) throw new PracticeError('domain_module_disabled');
    const limit = z.number().positive().max(240).safeParse(consumer.data.time_limit);
    if (!limit.success) throw new PracticeError('invalid_review_time_limit');
    const criteria = passCriteria(metadata.pass_criteria, config.shared_criteria);
    const placement = consumer.data.placement_interval;
    const placementStage = placement === undefined ? undefined : config.schedule.intervals.indexOf(placement as number) + 1;
    if (placementStage === 0) throw new PracticeError('invalid_placement_interval');
    await this.checks[domain]?.();
    // The snapshot always holds the server's definition, so a different flow is one this server has not imported.
    if (consumer.data.flow !== definition.flow) throw new PracticeError('workflow_mapping_changed_refresh_required');
    return { time_limit: limit.data, pass_criteria: criteria,
      ...(placementStage ? { placement_interval: placement as number, placement_stage: placementStage } : {}) };
  }
  private async domainAvailability(config: ModuleConfig, domain: PracticeDomain): Promise<DomainAvailability> {
    const definition = { domain, label: practiceDomains[domain].label };
    try {
      return { ...definition, status: 'enabled', ...await this.checkDomain(config, domain) };
    } catch (error) {
      this.signal.throwIfAborted();
      if (!(error instanceof PracticeError || error instanceof NoteError)) throw error;
      return { ...definition, status: disabledReasons.has(error.code) ? 'disabled' : 'unavailable', reason: error.code,
        ...(error.details?.length ? { errors: error.details } : {}) };
    }
  }
  private workflowMetadata(config: ModuleConfig) {
    return { domains: domainSchema.options, source_commit: bundle.sourceCommit, schedule: config.schedule,
      today: calendarDay(this.options.timeZone, this.now()), time_zone: this.options.timeZone, writes_enabled: this.options.writesEnabled,
      adapter: bundle.adapter };
  }
  private readyWorkflow(config: ModuleConfig, domain: PracticeDomain, policy: DomainPolicy) {
    const definition = practiceDomains[domain];
    return { ...this.workflowMetadata(config), status: 'ready' as const, availability: 'complete' as const,
      selected_domain: domain, available_domains: [{ domain, label: definition.label }], unavailable_domains: [] as DomainAvailability[],
      entry: (bundle.entry + adaptation(domain)).replaceAll('{{domain}}', domain).replaceAll('{{label}}', definition.label).replaceAll('{{flow}}', definition.flow),
      documents: practiceDocuments(domain), time_limits: { [domain]: policy.time_limit }, pass_criteria: { [domain]: policy.pass_criteria },
      placement_intervals: placementIntervals([{ domain, ...policy }]) };
  }
  async workflow(domain?: PracticeDomain) {
    if (domain !== undefined) domainSchema.parse(domain);
    const config = await this.config();
    if (domain !== undefined) return this.readyWorkflow(config, domain, await this.checkDomain(config, domain));
    const states = await Promise.all(domainSchema.options.map(value => this.domainAvailability(config, value)));
    this.signal.throwIfAborted();
    const available = states.filter(state => state.status === 'enabled');
    const unavailable = states.filter(state => state.status !== 'enabled');
    const availability = unavailable.some(state => state.status === 'unavailable') ? 'partial' as const : 'complete' as const;
    if (available.length === 1 && availability === 'complete') {
      const only = available[0]!;
      return { ...this.readyWorkflow(config, only.domain, only), unavailable_domains: unavailable };
    }
    return { ...this.workflowMetadata(config), status: available.length ? 'overview' as const : 'unavailable' as const, availability,
      selected_domain: null, available_domains: available.map(({ domain, label }) => ({ domain, label })), unavailable_domains: unavailable,
      entry: bundle.overview, documents: sharedPracticeDocuments,
      time_limits: Object.fromEntries(available.map(state => [state.domain, state.time_limit])),
      pass_criteria: Object.fromEntries(available.map(state => [state.domain, state.pass_criteria])),
      placement_intervals: placementIntervals(available) };
  }
  async instruction(path: string, offset: number) {
    const doc = documents[path];
    if (!doc || !path.endsWith('.md') || offset > doc.text.length) throw new PracticeError('unknown_practice_instruction');
    const domain = domainSchema.options.find(domain => practiceDocuments(domain).includes(path));
    if (!domain) throw new PracticeError('unknown_practice_instruction');
    await this.config(sharedPracticeDocuments.includes(path) ? undefined : domain);
    const text = doc.text.slice(offset, offset + 12000);
    return { path, text, source_commit: bundle.sourceCommit, source_sha256: doc.sha256, offset, complete: offset + text.length >= doc.text.length,
      ...(offset + text.length < doc.text.length ? { next_offset: offset + text.length } : {}) };
  }
}
