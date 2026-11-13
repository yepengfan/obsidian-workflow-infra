/** Shared IaC identities. Application resources and their IAM scopes use this contract. */
export const MCP_POOL_ARN_EXPORT = 'ObsidianMcp:UserPoolArn';

export function mcpResources(aws: { account: string; region: string }, runtimeRoleName: string, notePrefix = '') {
  return {
    functionName: 'obsidian-mcp-server', runtimeRoleName, apiName: 'obsidian-mcp',
    codeBucketName: `obsidian-mcp-code-${aws.account}-${aws.region}`,
    codePrefix: 'releases/', notePrefix,
  };
}
