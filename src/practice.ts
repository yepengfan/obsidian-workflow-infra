import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.js';
import { PracticeWorkflow } from './practice-workflow.js';
import { ReviewItems, serializeNote as serialize } from './srs/review-items.js';
import { criterionResultSchema, judge } from './srs/criteria.js';
import { calendarDay } from './srs/schedule.js';
import type { Settings } from './config.js';
import { NoteError } from './paths.js';
import type { NoteStore, NoteWriter } from './note-store.js';
import { PracticeError } from './errors.js';
import { CANVAS_REVIEW_PREFIX, DESIGN_PROFILE, type PracticeDomain, domainSchema, practiceDomains, practiceNoteDomain, validatePracticeWritePath } from './practice-domains.js';
import { designSessionTemplate, designSessionSchema } from './design-session.js';
import { conceptObservationSchema, designOutline, mergeAttemptObservations, parseObservations, renderProfile, upsertObservations, type StoredObservation } from './design-profile.js';
import { readDesignCanvas, parseScene, writeDesignCanvas } from './design-canvas.js';
import { attemptIdSchema, conceptIdSchema, dateSchema, reviewSummarySchema as summarySchema, slugSchema } from './practice-schema.js';
import { parsePracticeNote, PracticeNotes } from './practice-note.js';
import type { ReviewIndex, SessionIndex } from './review-index.js';
import { blockPointResultSchema, blockTemplateSchema } from './sd-blocks.js';
import type { ModuleAttempt, PracticeModule } from './practice-module.js';
import { practiceModules } from './practice-modules.js';
import type { SdBlocksModule } from './sd-blocks-module.js';
import { parseHistory } from './srs/history.js';
import type { SystemDesignModule } from './system-design-module.js';

export { PracticeError } from './errors.js';
export { domainSchema, validatePracticeWritePath } from './practice-domains.js';
export { dateSchema, slugSchema } from './practice-schema.js';
export const revisionSchema = z.string().min(1).max(256);
const text = z.string().max(12000);
const requiredText = text.refine(value => value.trim().length > 0);
export const addReviewSchema = z.strictObject({ id: slugSchema, domain: domainSchema, title: requiredText.max(200), prompt: requiredText,
  source: text.optional(), review_focus: text.optional(), concept_ids: z.array(conceptIdSchema).max(50).optional() });
export const recordReviewSchema = z.strictObject({ id: slugSchema, revision: revisionSchema,
  attempt_id: attemptIdSchema,
  criteria: z.array(criterionResultSchema).min(1).max(20), reflection: requiredText,
  completed_on: dateSchema, submission: text.optional(), observations: text.optional(),
  concept_observations: z.array(conceptObservationSchema).max(20).optional(),
  points: z.array(blockPointResultSchema).min(1).max(8).optional(), placement: z.boolean().optional(), problem: slugSchema.optional() });
export const finishRoundSchema = z.strictObject({
  topic: addReviewSchema, attempt: recordReviewSchema.omit({ id: true, revision: true }),
  progress_path: z.string().max(1024).optional(),
});
export const listReviewsSchema = z.strictObject({ domain: domainSchema });
/** A System Design problem, by its block map id or its breakdown note's title. */
export const designPreflightSchema = z.strictObject({ problem: slugSchema.optional(), breakdown: z.string().trim().min(1).max(200).optional() })
  .refine(input => (input.problem === undefined) !== (input.breakdown === undefined), 'Provide either problem or breakdown');
/** The session key of an attempt recorded by a standalone review rather than finished from a session note. */
const STANDALONE_SESSION = 'standalone';

export class Practice {
  private readonly notes: PracticeNotes;
  private readonly workflows: PracticeWorkflow;
  private readonly items: ReviewItems<PracticeDomain>;
  private readonly modules: Partial<Record<PracticeDomain, PracticeModule>>;
  private readonly sdBlocks: SdBlocksModule;
  private readonly systemDesign: SystemDesignModule;

  constructor(private readonly store: NoteStore, private readonly index: ReviewIndex & SessionIndex, private readonly settings: Pick<Settings, 'prefix' | 'practice' | 'limits'>,
    private readonly signal: AbortSignal, private readonly dependencies: { writer?: NoteWriter; now?: () => Date } = {}) {
    this.notes = new PracticeNotes(store, settings.prefix, signal, settings.limits.practiceNoteBytes, settings.practice.writesEnabled ? dependencies.writer : undefined);
    ({ modules: this.modules, sdBlocks: this.sdBlocks, systemDesign: this.systemDesign } = practiceModules({ read: path => this.read(path),
      notesIn: prefix => this.notesIn(prefix), activeReviews: domain => this.index.activeReviews(domain, this.signal),
      item: async id => {
        const note = await this.items.note(id, true);
        return { ...note.item, last_passed: parseHistory(note.body).at(-1)?.passed ?? null };
      },
      today: () => this.today(), signal }, {
      pullForward: (id, domain, day, signalDate) => this.items.pullForward(id, domain, day, signalDate),
      available: async domain => {
        try { await this.workflows.config(domain); return true; } catch { this.signal.throwIfAborted(); return false; }
      } }, { finishedSessions: () => this.index.finishedSessions(this.signal) }));
    const checks = Object.fromEntries(Object.entries(this.modules).flatMap(([domain, module]) => module.check ? [[domain, () => module.check!()]] : []));
    this.workflows = new PracticeWorkflow(settings.practice, path => this.read(path), dependencies.now ?? (() => new Date()), signal, checks);
    this.items = new ReviewItems({
      notes: this.notes, index, signal, today: () => this.today(),
      registered: (domain): domain is PracticeDomain => domainSchema.safeParse(domain).success,
      policy: async domain => {
        const { schedule, policy } = await this.workflows.config(domainSchema.parse(domain));
        return { criteria: policy!.pass_criteria, placementStage: policy!.placement_stage, schedule: { intervals: schedule.intervals,
          stepBack: schedule.on_fail.step_back, retryDays: schedule.on_fail.retry_days, archiveAfterFinal: schedule.archive_after_final } };
      },
    });
  }
  private today() { return calendarDay(this.settings.practice.timeZone, this.dependencies.now?.() ?? new Date()); }
  read(path: string) {
    return this.notes.read(path);
  }
  /** Vault paths of the notes directly inside a folder, or starting with a name prefix. */
  private async notesIn(prefix: string) {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(this.settings.prefix + prefix, 100, cursor, this.signal);
      paths.push(...page.notes.map(note => note.key.slice(this.settings.prefix.length)));
      cursor = page.next;
    } while (cursor);
    return paths;
  }
  /**
   * Checks a new attempt's module fields with its module's hook, which returns
   * the history section to record. A module without the hook refuses them.
   */
  private async checkAttempt(domain: PracticeDomain, itemId: string, attempt: ModuleAttempt) {
    const module = this.modules[domain];
    if (!module?.attempt) {
      if (attempt.points?.length || attempt.problem !== undefined) throw new PracticeError('unsupported_practice_domain');
      return undefined;
    }
    await this.workflows.config(domain);
    return module.attempt(itemId, attempt);
  }
  /** The item's note, or null when it cannot be read, as before its creation. */
  private async existingItem(id: string) {
    try { return await this.items.note(id); } catch (error) {
      if (error instanceof NoteError && error.code === 'note_unavailable') return null;
      throw error;
    }
  }

  async workflow(domain?: PracticeDomain) {
    const workflow = await this.workflows.workflow(domain);
    const selected = workflow.selected_domain;
    const module = selected ? this.modules[selected] : undefined;
    const extra = module?.workflow ? await module.workflow() : {};
    // Saved System Design sessions belong to the combined overview and to System Design itself.
    if ((selected && selected !== 'system-design') || !workflow.available_domains.some(item => item.domain === 'system-design')) return { ...workflow, ...extra };
    try {
      const [unfinished_sessions, pending_finalizations] = await Promise.all([this.index.unfinishedSessions(this.signal), this.index.pendingFinalizations(this.signal)]);
      return { ...workflow, ...extra, unfinished_sessions, pending_finalizations };
    } catch {
      this.signal.throwIfAborted();
      return { ...workflow, ...extra, unfinished_sessions: null, pending_finalizations: null };
    }
  }

  /** The review state of a System Design problem's blocks, before the problem starts. */
  async designPreflight(input: z.infer<typeof designPreflightSchema>) {
    await this.workflows.config('system-design');
    return this.systemDesign.preflight(designPreflightSchema.parse(input));
  }

  instruction(path: string, offset: number) {
    return this.workflows.instruction(path, offset);
  }

  async reviews(input: z.infer<typeof listReviewsSchema>) {
    const { date, domain, ...queue } = await this.items.reviews(domainSchema.parse(input.domain));
    return { date, time_zone: this.settings.practice.timeZone, domain, ...queue, complete: true };
  }
  async review(id: string, includeHistory = false) {
    const review = await this.items.review(id, includeHistory);
    const module = this.modules[domainSchema.parse(review.domain)];
    if (!module?.review) return review;
    return { ...review, ...await module.review(id, (await this.items.note(id)).body) };
  }
  async add(input: z.infer<typeof addReviewSchema>) {
    const domain = domainSchema.parse(input.domain);
    // An existing item is returned as it is, even after its module stopped accepting its id.
    const module = this.modules[domain];
    if (module?.add && !(await this.existingItem(input.id))) {
      await this.workflows.config(domain);
      await module.add(input.id);
    }
    return this.items.add({ ...input, domain });
  }
  async record(input: z.infer<typeof recordReviewSchema>) {
    if (input.concept_observations?.length) throw new PracticeError('use_practice_finish_round_for_evidence');
    const current = await this.items.note(input.id);
    // A retry of a recorded attempt returns it unchanged, so only a new attempt is checked.
    const details = current.item.attempt_ids.includes(input.attempt_id) ? undefined
      // A standalone review carries no evidence, so evidence-based module checks do not apply.
      : await this.checkAttempt(domainSchema.parse(current.item.domain), input.id, { ...input, concept_ids: current.item.concept_ids, concept_observations: undefined });
    return this.recordChecked(input, details, STANDALONE_SESSION);
  }
  /**
   * Records an attempt whose module fields were already checked, with their history section. `session` names
   * where it was finished from; a standalone review records `STANDALONE_SESSION`, so every new attempt has one.
   */
  private recordChecked(input: z.infer<typeof recordReviewSchema>, details: string | undefined, session: string) {
    const { id, revision, attempt_id, reflection, completed_on, criteria, submission, observations, placement } = input;
    return this.items.record({ id, revision, attempt_id, reflection, completed_on, criteria, submission, observations, placement, details, session });
  }
  async finishRound({ topic, attempt, progress_path }: z.infer<typeof finishRoundSchema>) {
    if (topic.domain !== 'system-design' && attempt.concept_observations?.length) throw new PracticeError('unsupported_practice_domain');
    if (attempt.completed_on > this.today()) throw new PracticeError('review_date_is_in_future');
    if (topic.domain === 'system-design' && !progress_path) throw new PracticeError('session_progress_required');
    // Judge before binding the session or creating the item, so a mismatched judgment writes nothing.
    judge((await this.workflows.config(topic.domain)).policy!.pass_criteria, attempt.criteria);
    // A retry of a recorded attempt re-verifies it without checking it against a map that may have changed.
    const existing = this.modules[topic.domain]?.attempt ? await this.existingItem(topic.id) : null;
    // An empty concept list takes the topic's, as registration below does.
    const concept_ids = existing?.item.concept_ids.length ? existing.item.concept_ids : topic.concept_ids ?? [];
    const recorded = existing?.item.attempt_ids.includes(attempt.attempt_id) ?? false;
    // Module checks judge the round's evidence as the session will store it.
    let evidence: StoredObservation[] | undefined;
    const check = (concepts: readonly string[]) => this.checkAttempt(topic.domain, topic.id, { ...attempt, concept_ids: concepts, concept_observations: evidence });
    let session: { note: { revision: string }; metadata: Record<string, unknown>; body: string; tags: unknown[] } | undefined;
    if (progress_path) {
      if (topic.domain !== 'system-design' || validatePracticeWritePath(progress_path) !== topic.domain ||
        !progress_path.startsWith(practiceDomains['system-design'].root + 'Solutions/') || !progress_path.endsWith('/progress.md')) throw new NoteError('invalid_path');
      const note = await this.read(progress_path);
      const { metadata, body } = parsePracticeNote(note.text);
      const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
      if (metadata.review_item_id == null &&
        (typeof metadata.topic !== 'string' || metadata.topic.trim().toLowerCase() !== topic.title.trim().toLowerCase())) {
        throw new PracticeError('session_topic_mismatch');
      }
      const bound = metadata.round_id === attempt.attempt_id && metadata.review_item_id === topic.id;
      // A recorded attempt is retried only from the session it was recorded from: the one the item names, or for
      // an attempt recorded without one, the session bound to it before this call.
      const owner = existing?.item.attempt_sessions[attempt.attempt_id];
      if (recorded && (owner === undefined ? !bound : owner !== progress_path)) throw new PracticeError('attempt_already_recorded');
      if ((!tags.includes('system-design/wip') && !(bound && tags.includes('system-design/done'))) ||
        (metadata.round_id && metadata.round_id !== attempt.attempt_id) ||
        (metadata.review_item_id != null && metadata.review_item_id !== topic.id) ||
        (metadata.round_completed_on && metadata.round_completed_on !== attempt.completed_on)) throw new PracticeError('session_round_mismatch');
      if (metadata.confirmed_registration && !isDeepStrictEqual(metadata.confirmed_registration, { topic, attempt })) throw new PracticeError('confirmed_registration_mismatch');
      await this.assessmentObservations({ progressPath: progress_path, completedOn: attempt.completed_on });
      evidence = mergeAttemptObservations(body, attempt.concept_observations ?? [], attempt.attempt_id, attempt.completed_on).attempt;
      session = { note, metadata, body, tags };
    }
    let details = recorded ? undefined : await check(concept_ids);
    // Claim an unconfirmed session before registering anything: the conditional write is the session's lock,
    // so of two finishes racing on it only one registers an item. A claim without confirmed_registration
    // still accepts a corrected retry of the same round.
    const unconfirmed = progress_path && session && session.tags.includes('system-design/wip') && !session.metadata.confirmed_registration ? session : undefined;
    let claimed: { metadata: Record<string, unknown>; revision: string } | undefined;
    if (progress_path && unconfirmed) {
      const metadata = { ...unconfirmed.metadata, round_id: attempt.attempt_id, review_item_id: topic.id, round_completed_on: attempt.completed_on };
      claimed = { metadata, revision: await this.notes.put(progress_path, serialize(metadata, unconfirmed.body), unconfirmed.note.revision) };
    }
    await this.add(topic);
    let current = await this.items.note(topic.id);
    if (topic.domain === 'system-design' && !current.item.concept_ids.length && topic.concept_ids?.length) {
      await this.notes.put(current.path, serialize({ ...current.metadata, concept_ids: topic.concept_ids }, current.body), current.revision);
      current = await this.items.note(topic.id);
    }
    // A concurrent first finish may have stored another concept list; judge against the stored one. This runs
    // before the registration is confirmed, so a refused judgment can be corrected and retried.
    if (!current.item.attempt_ids.includes(attempt.attempt_id) && !isDeepStrictEqual(current.item.concept_ids, concept_ids)) {
      details = await check(current.item.concept_ids);
    }
    if (progress_path && unconfirmed && claimed) {
      await this.notes.put(progress_path, serialize({ ...claimed.metadata, confirmed_registration: { topic, attempt } }, unconfirmed.body), claimed.revision);
    }
    if (!current.item.attempt_ids.includes(attempt.attempt_id)) {
      await this.recordChecked({ ...attempt, id: topic.id, revision: current.revision }, details, progress_path ?? STANDALONE_SESSION);
    }
    const verified = await this.items.note(topic.id);
    // Of calls racing on one attempt id, the item's conditional write records exactly one with its session; the
    // others store nothing and send no signals. Only an attempt recorded before sessions were stored has none,
    // and the check before the claim already required this session to be bound to it.
    const owner = verified.item.attempt_sessions[attempt.attempt_id];
    if (progress_path && owner !== progress_path && !(owner === undefined && recorded)) throw new PracticeError('attempt_already_recorded');
    if (!verified.item.attempt_ids.includes(attempt.attempt_id) ||
      (verified.item.status === 'active' && !verified.item.next_review)) throw new PracticeError('registration_verification_failed');
    if (topic.domain === 'system-design' && progress_path) {
      await this.persistDesignProfile(progress_path, attempt.attempt_id, attempt.completed_on, attempt.concept_observations ?? []);
    }
    // A module's finish hook sees the observations stored for the recorded round; without a session none are stored.
    let stored: StoredObservation[] = [];
    if (progress_path) {
      const note = await this.read(progress_path);
      const { metadata, body } = parsePracticeNote(note.text);
      stored = parseObservations(body, attempt.completed_on).filter(item => item.attempt_id === attempt.attempt_id);
      if (metadata.round_id !== attempt.attempt_id || metadata.review_item_id !== topic.id ||
        metadata.round_completed_on !== attempt.completed_on) throw new PracticeError('session_round_mismatch');
      const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
      if (tags.includes('system-design/wip')) {
        delete metadata.confirmed_registration;
        await this.notes.put(progress_path, serialize({ ...metadata,
          tags: tags.map(tag => tag === 'system-design/wip' ? 'system-design/done' : tag) }, body), note.revision);
      } else if (!tags.includes('system-design/done')) throw new PracticeError('session_round_mismatch');
    }
    const finish = this.modules[topic.domain];
    const extra = finish?.finish ? await finish.finish(topic.id, { ...attempt, concept_observations: stored }) : {};
    return { ...summarySchema.parse(verified.item), attempt_id: attempt.attempt_id, verified: true, ...extra };
  }

  private async persistDesignProfile(progressPath: string, attemptId: string, date: string, observations: z.infer<typeof conceptObservationSchema>[]) {
    const note = await this.read(progressPath);
    const { metadata, body: assessment } = parsePracticeNote(note.text);
    const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
    if (tags.includes('system-design/done')) return;
    const { stored } = mergeAttemptObservations(assessment, observations, attemptId, date);
    const body = upsertObservations(assessment, stored, date);
    await this.notes.put(progressPath, serialize(metadata, body), note.revision);
    await this.rebuildDesignProfile();
  }

  private async assessmentObservations(session?: { progressPath: string; completedOn: string }) {
    const root = this.settings.prefix + practiceDomains['system-design'].root + 'Solutions/';
    const observations: StoredObservation[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(root, 100, cursor, this.signal);
      for (const folder of [...page.folders].sort()) {
        if (!folder.startsWith(root) || !/^[^/]+\/$/u.test(folder.slice(root.length))) throw new NoteError('invalid_path');
        let next: string | undefined;
        do {
          const children = await this.store.list(folder, 100, next, this.signal);
          if (children.notes.some(note => note.key === folder + 'progress.md')) {
            const progressPath = (folder + 'progress.md').slice(this.settings.prefix.length);
            const note = await this.read(progressPath);
            const parsed = parsePracticeNote(note.text);
            const completed = dateSchema.safeParse(progressPath === session?.progressPath ? session.completedOn : parsed.metadata.round_completed_on);
            const tags = Array.isArray(parsed.metadata.tags) ? parsed.metadata.tags : [parsed.metadata.tags];
            observations.push(...parseObservations(parsed.body, completed.success ? completed.data : undefined, {
              deferUndated: parsed.metadata.round_completed_on == null && tags.includes('system-design/wip'),
            }));
          }
          next = children.next;
        } while (next);
      }
      cursor = page.next;
    } while (cursor);
    return observations;
  }

  async rebuildDesignProfile() {
    await this.workflows.config('system-design');
    let revision: string | undefined;
    try { revision = (await this.read(DESIGN_PROFILE)).revision; }
    catch (error) { if (!(error instanceof NoteError) || error.code !== 'note_unavailable') throw error; }
    const observations = await this.assessmentObservations();
    await this.notes.put(DESIGN_PROFILE, renderProfile(observations), revision);
    return { observations: observations.length, rebuilt: true };
  }

  async outline(input: { id?: string; concept_ids?: string[] }) {
    await this.workflows.config('system-design');
    if ((input.id === undefined) === (input.concept_ids === undefined)) throw new PracticeError('provide_review_or_concepts');
    let concepts = input.concept_ids ?? [];
    if (input.id) {
      const note = await this.items.note(input.id);
      if (note.item.domain !== 'system-design') throw new PracticeError('unsupported_practice_domain');
      concepts = note.item.concept_ids;
    }
    return designOutline(concepts, await this.assessmentObservations());
  }

  async readNote(path: string) {
    const domain = practiceNoteDomain(path);
    try { await this.workflows.config(domain); } catch (error) {
      // A usable module may read notes of another domain it depends on, such as SD Blocks reading the notes its map links.
      if (!(await this.moduleReads(domain, path))) throw error;
    }
    return { path, ...await this.read(path) };
  }
  /** Whether a usable module other than the note's own domain grants reading the note. */
  private async moduleReads(noteDomain: PracticeDomain, path: string) {
    for (const [domain, module] of Object.entries(this.modules) as [PracticeDomain, PracticeModule][]) {
      if (domain === noteDomain || !module.reads) continue;
      try {
        await this.workflows.config(domain);
        if ((await module.reads()).has(path)) return true;
      } catch {
        this.signal.throwIfAborted();
      }
    }
    return false;
  }
  async designTemplate(input: z.infer<typeof designSessionSchema>) {
    await this.workflows.config('system-design');
    return designSessionTemplate(input, this.today());
  }
  /** A canvas is a System Design session drawing or an SD Blocks review drawing. */
  private async checkCanvasPath(path: string) {
    const domain = validatePracticeWritePath(path);
    const session = domain === 'system-design' && path.startsWith(practiceDomains['system-design'].root + 'Solutions/');
    if (!path.endsWith('.excalidraw.md') || (!session && !this.modules[domain]?.canvas?.(path))) throw new NoteError('invalid_path');
    await this.workflows.config(domain);
  }
  async blockTemplate(input: z.infer<typeof blockTemplateSchema>) {
    await this.workflows.config('sd-blocks');
    return this.sdBlocks.template(input);
  }

  async designCanvas(path: string) {
    await this.checkCanvasPath(path);
    const note = await this.read(path);
    return { path, revision: note.revision, ...readDesignCanvas(note.text, this.settings.limits) };
  }
  private reviewPath(path: string) {
    return CANVAS_REVIEW_PREFIX + createHash('sha256').update(path).digest('hex') + '.md';
  }

  private reviewedScene(json: string) {
    const drawing = parseScene(json, this.settings.limits);
    for (const element of drawing.elements) {
      if (element.type !== 'image' || element.isDeleted) continue;
      const file = typeof element.fileId === 'string' && drawing.files?.[element.fileId];
      if (!file || typeof file !== 'object' || !('dataURL' in file) || !file.dataURL) {
        throw new PracticeError('canvas_image_missing');
      }
    }
    return drawing;
  }

  async stageCanvas(path: string, scene: Record<string, unknown>) {
    await this.checkCanvasPath(path);
    const json = JSON.stringify(scene);
    this.reviewedScene(json);
    const key = this.reviewPath(path);
    let snapshot;
    try { snapshot = await this.notes.put(key, json); }
    catch (error) {
      if (!(error instanceof NoteError) || error.code !== 'revision_conflict') throw error;
      const prior = await this.read(key);
      snapshot = prior.text === json ? prior.revision : await this.notes.put(key, json, prior.revision);
    }
    return { path, snapshot };
  }

  async saveCanvas(path: string, input: { snapshot?: string; scene?: Record<string, unknown> }, revision: string | null) {
    await this.checkCanvasPath(path);
    const { snapshot, scene: supplied } = input;
    if ((snapshot === undefined) === (supplied === undefined)) throw new PracticeError('provide_snapshot_or_scene');
    let json: string;
    if (snapshot !== undefined) {
      const staged = await this.read(this.reviewPath(path));
      if (staged.revision !== snapshot) throw new PracticeError('canvas_review_superseded');
      json = staged.text;
    } else {
      if (!supplied?.appState || !supplied.files) throw new PracticeError('incomplete_canvas_scene');
      json = JSON.stringify(supplied);
    }
    const scene = this.reviewedScene(json);
    const prior = revision === null ? undefined : await this.read(path);
    if (prior && prior.revision !== revision) throw new PracticeError('revision_conflict');
    const content = writeDesignCanvas(prior?.text, scene);
    readDesignCanvas(content, this.settings.limits);
    await this.notes.put(path, content, prior?.revision);
    const saved = await this.designCanvas(path);
    if (!isDeepStrictEqual(saved.drawing, scene)) throw new PracticeError('canvas_verification_failed');
    return { path, snapshot, revision: saved.revision, elements: scene.elements.length, verified: true };
  }

  private checkSessionCompletion(path: string, before: string | undefined, after: string) {
    if (!path.startsWith(practiceDomains['system-design'].root + 'Solutions/') || !path.endsWith('/progress.md')) return;
    const fields = (content: string) => {
      const metadata = parseFrontmatter(content)?.metadata ?? {};
      const tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
      return { done: tags.includes('system-design/done'), round: metadata.round_id, topic: metadata.review_item_id };
    };
    const next = fields(after);
    const prior = before ? fields(before) : undefined;
    if (next.done && !prior?.done) throw new PracticeError('use_practice_finish_round');
    if (prior?.done && (!next.done || prior.round !== next.round || prior.topic !== next.topic)) throw new PracticeError('session_already_closed');
  }

  async createNote(path: string, content: string) {
    await this.workflows.config(validatePracticeWritePath(path));
    this.checkSessionCompletion(path, undefined, content);
    await this.notes.put(path, content);
    return { path, created: true };
  }
  async updateNote(path: string, revision: string, edits: { old: string; replacement: string }[]) {
    await this.workflows.config(validatePracticeWritePath(path));
    const note = await this.read(path);
    if (note.revision !== revision) throw new PracticeError('revision_conflict');
    let result = note.text;
    for (const edit of edits) {
      const start = result.indexOf(edit.old);
      if (start < 0 || result.indexOf(edit.old, start + 1) >= 0) throw new PracticeError('edit_anchor_not_unique');
      result = result.slice(0, start) + edit.replacement + result.slice(start + edit.old.length);
    }
    this.checkSessionCompletion(path, note.text, result);
    await this.notes.put(path, result, revision);
    return { path, updated: true };
  }
}
