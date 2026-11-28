import type { PracticeDomain } from './practice-domains.js';
import type { PracticeModule, PracticeModulePorts } from './practice-module.js';
import { SdBlocksModule } from './sd-blocks-module.js';

/** The practice modules with rules of their own, wired for one request. */
export function practiceModules(ports: PracticeModulePorts) {
  const sdBlocks = new SdBlocksModule(ports);
  const modules: Partial<Record<PracticeDomain, PracticeModule>> = { 'sd-blocks': sdBlocks };
  return { modules, sdBlocks };
}
