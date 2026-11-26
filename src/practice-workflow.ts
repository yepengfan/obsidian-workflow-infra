import { z } from 'zod';
import bundle from '../workflows/practice.json' with { type: 'json' };
import { PracticeError } from './errors.js';
import { NoteError } from './paths.js';
import { parsePracticeNote } from './practice-note.js';
import { domainSchema, practiceDocuments, practiceDomains, sharedPracticeDocuments, type PracticeDomain } from './practice-domains.js';
import type { PracticeOptions } from './practice-options.js';
import { calendarDay } from './review-schedule.js';

const moduleSchema = z.object({ enabled: z.boolean(), interval_days: z.array(z.number().int().min(1).max(3650)).min(1).max(20),
  retry_days: z.number().int().min(1).max(3650), archive_after_final: z.boolean().default(false),
  practice_flows: z.record(z.string(), z.unknown()),
  review_time_limits: z.record(z.string(), z.unknown()) });
type ModuleConfig = z.infer<typeof moduleSchema>;
type DomainAvailability = { domain: PracticeDomain; label: string } & (
  { status: 'enabled'; time_limit: number } | { status: 'disabled' | 'unavailable'; reason: string });
function mcpInstruction(text: string) {
  return text.replaceAll('`python3 scripts/practice-review/review.py outline <id>`', '`practice_design_outline` with `id`')
    .replaceAll('`python3 scripts/practice-review/review.py outline --concept-ids <concept-id> ...`', '`practice_design_outline` with `concept_ids`');
}

const documents: Record<string, { text: string; sha256: string }> = bundle.documents;

export class PracticeWorkflow {
  constructor(
    private readonly options: PracticeOptions,
    private readonly read: (path: string) => Promise<{ text: string }>,
    private readonly now: () => Date,
    private readonly signal: AbortSignal,
  ) {}

  async config(domain?: z.infer<typeof domainSchema>) {
    if (!this.options.enabled) throw new PracticeError('practice_disabled');
    const note = await this.read('system/modules/practice-review/module.md');
    const config = moduleSchema.parse(parsePracticeNote(note.text).metadata);
    if (!config.enabled) throw new PracticeError('practice_module_disabled');
    return { ...config, time_limit: domain === undefined ? undefined : await this.checkDomain(config, domain) };
  }
  private async checkDomain(config: ModuleConfig, domain: PracticeDomain) {
    const definition = practiceDomains[domainSchema.parse(domain)];
    if (config.practice_flows[domain] !== definition.flow) throw new PracticeError('workflow_mapping_changed_refresh_required');
    const limit = z.number().positive().max(240).safeParse(config.review_time_limits[domain]);
    if (!limit.success) throw new PracticeError('invalid_review_time_limit');
    const guard = await this.read(definition.module);
    const enabled = parsePracticeNote(guard.text).metadata.enabled;
    if (typeof enabled !== 'boolean') throw new PracticeError('invalid_domain_module');
    if (!enabled) throw new PracticeError('domain_module_disabled');
    return limit.data;
  }
  private async domainAvailability(config: ModuleConfig, domain: PracticeDomain): Promise<DomainAvailability> {
    const definition = { domain, label: practiceDomains[domain].label };
    try {
      return { ...definition, status: 'enabled', time_limit: await this.checkDomain(config, domain) };
    } catch (error) {
      this.signal.throwIfAborted();
      if (!(error instanceof PracticeError || error instanceof NoteError)) throw error;
      return { ...definition, status: error.code === 'domain_module_disabled' ? 'disabled' : 'unavailable', reason: error.code };
    }
  }
  private workflowMetadata(config: ModuleConfig) {
    return { domains: domainSchema.options, source_commit: bundle.sourceCommit,
      intervals: config.interval_days, retry_days: config.retry_days,
      today: calendarDay(this.options.timeZone, this.now()), time_zone: this.options.timeZone, writes_enabled: this.options.writesEnabled,
      adapter: bundle.adapter };
  }
  private readyWorkflow(config: ModuleConfig, domain: PracticeDomain, timeLimit: number) {
    const definition = practiceDomains[domain];
    return { ...this.workflowMetadata(config), status: 'ready' as const, availability: 'complete' as const,
      selected_domain: domain, available_domains: [{ domain, label: definition.label }], unavailable_domains: [] as DomainAvailability[],
      entry: bundle.entry.replaceAll('{{domain}}', domain).replaceAll('{{label}}', definition.label).replaceAll('{{flow}}', definition.flow),
      documents: practiceDocuments(domain), time_limits: { [domain]: timeLimit } };
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
      return { ...this.readyWorkflow(config, only.domain, only.time_limit), unavailable_domains: unavailable };
    }
    return { ...this.workflowMetadata(config), status: available.length ? 'overview' as const : 'unavailable' as const, availability,
      selected_domain: null, available_domains: available.map(({ domain, label }) => ({ domain, label })), unavailable_domains: unavailable,
      entry: bundle.overview, documents: sharedPracticeDocuments,
      time_limits: Object.fromEntries(available.map(state => [state.domain, state.time_limit])) };
  }
  async instruction(path: string, offset: number) {
    const doc = documents[path];
    if (!doc || !path.endsWith('.md') || offset > mcpInstruction(doc.text).length) throw new PracticeError('unknown_practice_instruction');
    const domain = domainSchema.options.find(domain => practiceDocuments(domain).includes(path));
    if (!domain) throw new PracticeError('unknown_practice_instruction');
    await this.config(sharedPracticeDocuments.includes(path) ? undefined : domain);
    const adapted = mcpInstruction(doc.text);
    const text = adapted.slice(offset, offset + 12000);
    return { path, text, source_commit: bundle.sourceCommit, source_sha256: doc.sha256, offset, complete: offset + text.length >= adapted.length,
      ...(offset + text.length < adapted.length ? { next_offset: offset + text.length } : {}) };
  }
}
