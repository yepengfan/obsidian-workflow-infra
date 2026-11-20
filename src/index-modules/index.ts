import { practiceReviewIndex } from './practice-review.js';
import type { IndexedModule, IndexRow } from './types.js';

/** Every indexed module. Adding one adds its table, event filter and grants. */
export const indexedModules: readonly IndexedModule<IndexRow>[] = [practiceReviewIndex];

/** Finds the module and item ID for a key relative to the configured note prefix. */
export function resolveIndexedKey(relativeKey: string) {
  for (const module of indexedModules) {
    if (!relativeKey.startsWith(module.sourcePrefix)) continue;
    const id = module.matches(relativeKey.slice(module.sourcePrefix.length));
    if (id !== undefined) return { module, id };
  }
  return undefined;
}
