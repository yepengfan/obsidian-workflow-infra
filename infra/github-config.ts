import { readFileSync } from 'node:fs';
import { z } from 'zod';

const roleName = z.string().regex(/^obsidian-[A-Za-z0-9+=,.@_-]+$/u).max(64);

export const githubSchema = z.object({
  repositorySubject: z.string().regex(/^repo:[A-Za-z0-9_.-]+@\d+\/[A-Za-z0-9_.-]+@\d+$/u),
  planRoleName: roleName,
  deployRoleName: roleName,
  executionRoleName: roleName,
  mcpExecutionRoleName: roleName,
  runtimeRoleName: z.string().regex(/^obsidian-mcp-[a-z0-9-]+$/u).max(64),
  codeRetentionRoleName: roleName,
}).strict().refine(config => new Set([config.executionRoleName, config.mcpExecutionRoleName,
  config.planRoleName, config.deployRoleName, config.runtimeRoleName, config.codeRetentionRoleName].map(name => name.toLowerCase())).size === 6,
  'Role names must be distinct');

export type GitHubConfig = z.infer<typeof githubSchema>;

const regionalRoleNames = z.object({ planRoleName: z.string(), deployRoleName: z.string() }).passthrough();

export function loadGitHubConfig(region: string): GitHubConfig {
  const config = regionalRoleNames.parse(JSON.parse(readFileSync('config/github.json', 'utf8')));
  return githubSchema.parse({
    ...config,
    planRoleName: config.planRoleName.replace('{region}', region),
    deployRoleName: config.deployRoleName.replace('{region}', region),
  });
}
