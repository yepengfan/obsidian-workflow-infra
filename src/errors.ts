/** Expected operation failures whose public codes may be returned to an MCP client. */
export class OperationError extends Error {
  /** `details` lists each problem behind the code, for reports that show them, such as module availability. */
  constructor(readonly code: string, readonly details?: readonly string[]) { super(code); }
}

export class PracticeError extends OperationError {}
