import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Settings } from './config.js';
import type { NoteStore, NoteWriter } from './note-store.js';

export type SkillContext = {
  server: McpServer;
  store: NoteStore;
  writer?: NoteWriter;
  settings: Settings;
  owner: string;
  signal: AbortSignal;
  result: (work: () => Promise<object>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
  authorizeScope: (scope: string) => Promise<void>;
};

export type McpSkill = {
  instructions: string;
  scopes: readonly string[];
  register: (context: SkillContext) => void;
};
