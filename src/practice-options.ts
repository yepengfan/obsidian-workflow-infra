import { z } from 'zod';

export const practiceOptionsSchema = z.strictObject({ enabled: z.boolean().default(false), writesEnabled: z.boolean().default(false),
  timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).default('Australia/Brisbane') }).refine(options => !options.writesEnabled || options.enabled, 'Enable practice before enabling its writes');
export type PracticeOptions = z.infer<typeof practiceOptionsSchema>;

export { practiceWriteResources } from './practice-domains.js';
