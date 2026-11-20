/** Expected operation failures whose public codes may be returned to an MCP client. */
export class OperationError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class PracticeError extends OperationError {}
