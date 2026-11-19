# Journal writes through MCP

`journal_write` lets ChatGPT and Claude save Markdown into the vault's root
`Journal/` folder, including its subfolders. It is the only general-purpose
write tool; every other path stays read-only or limited to
[practice](practice.md) data.

## Tool

| Input | Behavior |
| --- | --- |
| `path` | Markdown path that starts with `Journal/` (case-sensitive). Ordinary [path rules](mcp-server.md#tools-and-retrieval) apply. |
| `mode: "append"` | Reads the current note, adds `content` at the end and saves it pinned to the revision just read. Inserts one newline first when the note does not already end with one. Creates the note when it is absent. |
| `mode: "overwrite"` | Replaces the whole note with `content`, creating it when absent. The assistant reads the note with `read_note` first, following every cursor, and sends the complete new text. |

The result reports `path`, `mode`, the saved note's `totalBytes` and, for append,
whether the note was `created`. A saved note is bounded to 1 MiB; one call's
content to 50,000 characters.

Overwrite has no revision check by design. Append is a single read-modify-write;
if the note changes between that read and the save, for example through
Remotely Save, the call returns `revision_conflict` and nothing is written.
Retry the append.

Missing notes are detected by a create-only save, not by the read: S3 can report
a missing key as access denied because the runtime's listing grant is
condition-scoped. An existing note that cannot be read is never replaced by an
append.

## Layering

| Module | Responsibility |
| --- | --- |
| `src/journal-tools.ts` | MCP registration, tool metadata and write-scope step-up. |
| `src/journal.ts` | Journal path policy, append/overwrite rules and size bounds. Depends only on the `NoteStore` / `NoteWriter` ports. |
| `src/note-store.ts` | Ports. `WriteCondition` makes create-only, exact-revision and unconditional saves explicit. |
| `src/s3.ts` | S3 adapter for those ports. |

`journalWriteResources` in `src/journal.ts` is also the source of the IAM grant.

## Authorization and IAM

The tool reuses the shared resource-bound `<McpEndpoint>/write` scope and owner
group check used by practice saves. The write scope, runtime writer and challenge
are enabled when any write feature is enabled. See
[configuration and bounds](mcp-server.md#configuration-and-bounds).

`journal.writesEnabled` in `config/mcp-runtime.json` drives both the runtime and
the IAM boundary; mismatches fail synthesis. The runtime role gains only
encrypted `s3:PutObject` on `<notePrefix>Journal/*.md`, without conditional-write
requirements so overwrite can replace a note. There is no DeleteObject.

## Activation

1. Synthesize and review the foundation and application diffs.
2. Apply the IAM-only prerequisite through local SSO, following
   [the permission-update procedure](github-actions.md). CI cannot expand its
   own IAM permissions.
3. Review CI Plan, then approve application Apply separately.
4. Refresh the tool metadata in ChatGPT and Claude. If a connection does not yet
   hold the write scope, disconnect and reconnect to authorize it.
5. In an agreed note, verify append to an existing note, append creating a new
   note, and overwrite after reading.

During the application Apply, Lambda can briefly start with the new
`MCP_OPTIONS` before the new code. The previous code rejects the unknown
`journal` key until the code update completes.
