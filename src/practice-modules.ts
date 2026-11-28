import { loadBlockMap, type BlockMap } from './block-map.js';
import type { PracticeDomain } from './practice-domains.js';
import type { PracticeModule, PracticeModulePorts } from './practice-module.js';
import { SdBlocksModule } from './sd-blocks-module.js';
import { SystemDesignModule } from './system-design-module.js';

/** The practice modules with rules of their own, wired for one request. */
export function practiceModules(ports: PracticeModulePorts) {
  // The checked block map, loaded at most once per request; a failed load is not kept.
  let map: Promise<BlockMap> | undefined;
  const blockMap = () => {
    map ??= loadBlockMap(ports).catch((error: unknown) => { map = undefined; throw error; });
    return map;
  };
  const sdBlocks = new SdBlocksModule(ports, blockMap);
  const modules: Partial<Record<PracticeDomain, PracticeModule>> = { 'sd-blocks': sdBlocks, 'system-design': new SystemDesignModule(ports, blockMap) };
  return { modules, sdBlocks };
}
