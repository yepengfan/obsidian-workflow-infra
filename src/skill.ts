import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Settings } from './config.js';
import type { NoteStore } from './s3.js';

export class SkillError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type SkillContext = {
  server: McpServer;
  store: NoteStore;
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
