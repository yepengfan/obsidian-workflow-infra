/** Shared contract: IAM grants and the index resources both bind to these names. */
export const INDEX_RESOURCES = {
  functionName: 'obsidian-mcp-indexer', roleName: 'obsidian-mcp-indexer',
  queueName: 'obsidian-mcp-index.fifo', deadLetterQueueName: 'obsidian-mcp-index-dlq.fifo',
  changeRuleName: 'obsidian-mcp-index-changes', reconcileRuleName: 'obsidian-mcp-index-reconcile',
  alarmNames: ['obsidian-mcp-index-dead-letters', 'obsidian-mcp-index-backlog', 'obsidian-mcp-index-errors'],
  logDays: 30,
} as const;
