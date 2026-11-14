import { z } from 'zod';

export const practiceOptionsSchema = z.strictObject({ enabled: z.boolean().default(false), writesEnabled: z.boolean().default(false),
  timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).default('Australia/Brisbane') }).refine(options => !options.writesEnabled || options.enabled, 'Enable practice before enabling its writes');
export type PracticeOptions = z.infer<typeof practiceOptionsSchema>;

export const practiceWriteResources = [
  'Learning/Practice/Review/Items/*.md',
  'Learning/Practice/Algorithm/Patterns/*.md', 'Learning/Practice/Algorithm/Atoms/*.md', 'Learning/Practice/Algorithm/Log/*.md',
  'Learning/Practice/System-Design/Patterns/*.md', 'Learning/Practice/System-Design/Log/*.md',
  'Learning/Practice/System-Design/Solutions/*/progress.md', 'Learning/Practice/System-Design/Solutions/*/*.excalidraw.md',
];
