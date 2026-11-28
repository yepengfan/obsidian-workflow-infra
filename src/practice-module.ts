import type { CriterionResult } from './srs/criteria.js';
import type { PracticeDomain } from './practice-domains.js';
import type { BlockPointResult } from './sd-blocks.js';

/**
 * The extension contract between the generic practice service and a practice
 * module with rules of its own. The service calls a hook only for the
 * module's domain and runs the module's configuration guard first; a module
 * without a hook keeps the generic behavior. Modules are wired in
 * `practice-modules.ts`, so adding one never edits the service.
 */
export interface PracticeModule {
  /** Checks the module's own data, beyond its configuration, before it is offered. */
  check?(): Promise<void>;
  /** Extra fields for the module's ready workflow. It reports its own unavailable data in them rather than failing. */
  workflow?(): Promise<Record<string, unknown>>;
  /** Extra fields for one of its selected reviews, given the item's note body. */
  review?(itemId: string, body: string): Promise<Record<string, unknown>>;
  /** Refuses an item id the module cannot review, before the item is created. */
  add?(itemId: string): Promise<void>;
  /**
   * Checks a new attempt's module fields, such as SD Blocks `points`, before
   * any write. Returns a history section recorded after the criteria. Modules
   * without this hook refuse those fields.
   */
  attempt?(itemId: string, attempt: ModuleAttempt): Promise<string | undefined>;
  /** Notes outside the module's own root that it may read while their own domain is unavailable. */
  reads?(): Promise<ReadonlySet<string>>;
  /** Whether a canvas path under the module's root is one of its drawings. */
  canvas?(path: string): boolean;
}

/** A review item's schedule state. */
export interface ItemState { id: string; status: string; stage: number; next_review: string | null }

/** The attempt fields a module hook judges. */
export interface ModuleAttempt {
  readonly criteria: readonly CriterionResult[];
  readonly points?: readonly BlockPointResult[];
}

/** Narrow read access a module may use, built by the service for one request. */
export interface PracticeModulePorts {
  read(path: string): Promise<{ text: string }>;
  /** Vault paths of the notes directly inside a folder, or starting with a name prefix. */
  notesIn(prefix: string): Promise<readonly string[]>;
  /** The domain's rows in the active review index. */
  activeReviews(domain: PracticeDomain): Promise<readonly ItemState[]>;
  /** One review item's state, read from its note even when the item is archived. */
  item(id: string): Promise<ItemState & { domain: string }>;
  /** Today in the configured vault calendar. */
  today(): string;
  readonly signal: AbortSignal;
}
