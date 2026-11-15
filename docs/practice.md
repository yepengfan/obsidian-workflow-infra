# Practice through MCP

The practice integration adapts the existing `obsidian-workflow` skill for the
ChatGPT connection. It supports Algorithm and System Design: start the selected
domain directly, complete its due reviews, then start a new problem. Algorithm
remains the default when a client omits the domain. Behavioral Interview is
outside this rollout.
ChatGPT guides and assesses the conversation; Lambda performs typed data
operations. Lambda does not host an LLM, execute arbitrary code or run a local
Python process.

## Runtime composition

`src/skills.ts` centrally manages the ordinary note tools and enabled practice
skill, and is imported by `src/handler.ts`. Note-tool schemas and registration
live in `src/note-tools.ts`; practice registration lives in
`src/practice-tools.ts`. The handler owns HTTP, authentication, request budgets
and MCP transport, without constructing either domain service. An explicit
additional-skill list overrides optional practice registration while preserving
the ordinary note tools.

`src/skill.ts` defines the registration contract. `src/note-store.ts` defines
separate read and write ports; `src/s3.ts` implements both. Services depend on
those ports, and expected errors use the transport-independent type in
`src/errors.ts`. `src/runtime.ts` wires the S3 adapter into the handler and
supplies the write capability only when writes are enabled. A reader that also
happens to implement `put` is not implicitly treated as a writer.

## Rollout state

The versioned configuration enables practice writes. System Design adds new
write paths and therefore requires its own IAM foundation update. Activation
requires two separately approved infrastructure changes: the local-SSO IAM
foundation update, followed by the application deployment through GitHub Actions.
Apply the IAM prerequisite before approving the application Apply. A merged
configuration change alone does not grant the running Lambda write access.

Once deployed, `practice_add_review`, `practice_record_review`,
`practice_create_note` and `practice_update_note` are available to owners with
both read and write OAuth scopes. The workflow previews proposed changes and
obtains explicit save confirmation. System Design reuses the existing `/write`
OAuth scope. Refresh the connection's tool metadata after deployment; an owner
already authorized for writes does not need a new scope.

Follow the activation procedure below and verify save, cancellation, conflict
and retry behavior in an explicitly approved disposable session. Local tests
validate the protocol and persistence logic; ChatGPT confirmation behavior and
live S3 writes still require acceptance checks.

Start with either:

> Start my Algorithm practice. Complete due reviews before a new problem.

> Start my System Design practice. Complete due reviews before a new problem.

For the second request, call `practice` with `domain: "system-design"`.

`practice` is an MCP tool the model can call. Connecting the server does not
install local `SKILL.md` files as native ChatGPT slash commands. The tool returns
the user-requested workflow and an instruction catalog. The model retrieves
referenced definitions using `practice_instruction` and private data using MCP
read tools. Actual ChatGPT workflow interpretation still requires a human smoke
test; deterministic tests prove the protocol and persistence behavior.

## Source of truth

`workflows/practice.json` is a generated, versioned snapshot of the canonical
workflow repository's public tracked definitions, including guides, templates
and review content definitions for both domains.
`workflows/practice-entry.md` is the maintained MCP adaptation; the importer
includes it in the snapshot. The service fills its domain placeholders and
returns only the selected domain's instruction catalog. Shared upstream review
guides retain their original domain references, but Behavioral is unsupported.
The snapshot contains no private review items, submissions, notes, credentials
or environment files.
The manifest records the upstream commit and each source file's SHA-256.
Text punctuation is normalized from long dashes to plain dashes in the imported
representation. Historical notes in S3 are never normalized or bulk rewritten.

Refresh deliberately from a clean local canonical checkout:

```sh
npx --no-install tsx bin/import-practice-workflow.ts /path/to/obsidian-workflow
npm run check
```

Review the generated diff; never edit the snapshot manually. Refresh does not
fetch code, execute upstream scripts, upload to S3 or deploy anything.
CI and Lambda use the committed snapshot. Runtime ZIP builds from the same
committed snapshot remain deterministic.

The live S3 practice-review manifest controls `enabled`, intervals, retry days,
time limits and domain mapping. The selected domain's module guard and exact
workflow mapping are checked before its actions. A disabled Algorithm module
does not block System Design, or vice versa. Other domain settings in the shared
manifest are ignored.
A changed workflow mapping requires a reviewed source refresh,
rather than loading arbitrary executable code. Missing/invalid configuration
fails closed. Module configuration and guide files cannot be saved through the
practice write tools.

## Tool surface

| Tool | Behavior |
| --- | --- |
| `practice` | Start Algorithm or System Design; return its workflow, instruction catalog and current configuration. |
| `practice_instruction` | Read a bounded chunk of one packaged instruction document. |
| `practice_reviews` | Read one bounded review queue page for the selected domain. |
| `practice_review` | Return a neutral prompt and revision; feedback phase may include history. |
| `practice_read_note` | Read one complete bounded Algorithm or System Design note and its revision for a potential edit. |
| `practice_design_template` | Draft unsaved session progress and Excalidraw files for a new System Design topic. |
| `practice_add_review` | Create an unstarted review object without overwriting an existing one. |
| `practice_record_review` | Append an ended attempt/reflection and calculate scheduling deterministically. |
| `practice_create_note` | Create an approved practice data Markdown file if absent. |
| `practice_update_note` | Apply selected unique text-anchor edits with an expected revision. |

The last four tools are absent from the catalog while writes are disabled.
Every write requires both the resource-bound read and write scopes and owners
group membership. Tool annotations request careful host handling but are not
proof of human approval. The workflow requires showing the intended change and
obtaining explicit confirmation before saving. Verify that behavior in ChatGPT
before activating production writes; never use a `confirmed: true` argument as
an authorization mechanism.

## Queue and schedule

The queue scans only `Learning/Practice/Review/Items/`, twenty objects per call,
with at most four concurrent object reads. Only active records matching the
selected domain are returned. Behavioral
records are skipped when listing and rejected by selected-review and record
operations. Cursors are bound to the selected domain as well as owner and date.
Results and ordering are page-local.
Collect all pages before claiming a complete queue or global review order;
after ten pages, stop and ask to narrow the task rather than reading indefinitely.
Pagination is not a transaction or a frozen snapshot. Refresh after recording a
round. Malformed/oversized records produce an error, never a false empty queue.

Due items are overdue/today, ordered by `next_review` then stable ID. Upcoming
and unstarted objects are separate. A neutral prompt excludes earlier answers,
reflection history and post-attempt focus. Feedback is requested after the
independent attempt. The owner still has ordinary note-read access; the phase
separation is a coaching rule, not an access control against the owner.

The backend follows the canonical scheduling policy:

- First independent completion: first interval from actual completion day.
- On-time/late independent completion: advance one interval, capped at the last.
- Early independent extra practice: keep the existing due date and stage.
- Assisted/incomplete ended round: retry interval, preserving the stage.

Defaults are 1/3/7/14/30 days and a one-day retry, read from the live manifest.
The configured IANA timezone determines today; UTC does not silently replace
the vault calendar. `completed_on` preserves the actual completion date on a
later save. Future dates and dates preceding the last recorded review are
rejected. Learner reflections are stored verbatim, separate from observations
and submitted work.

## Concurrency and note edits

S3 creation uses `If-None-Match: *`; updates use the previously read ETag in
`If-Match`. Conflicts never fall back to unconditional writes. Reread the file,
reconcile the intended change, show the revised preview and reconfirm.
`attempt_id` is stable across retries. An already recorded ID returns
`recorded: false` without appending another round or advancing the schedule.

Approved paths are defined once in `src/practice-domains.ts`, shared by runtime
validation, workflow import and IAM synthesis:

- Algorithm: direct Markdown children of Patterns, Atoms and Log.
- System Design: direct Markdown children of Patterns, Insights and Log;
  `Solutions/<session>/progress.md` and
  `Solutions/<session>/<canvas>.excalidraw.md`.

Review attempts use their dedicated tools. The shared review folder remains
unchanged; the backend enforces each record's domain. Configuration, guides,
indexes, templates, reference articles, shared attachments and other session
files are not writable. Multiple note saves are independent operations. Report
each result honestly, including partial success.

## System Design sessions

The bundled `sysd-solve` definitions guide Requirements, Core Entities, API,
Data Flow, High-Level Design and Deep Dives. Coaching uses English, targeted
hints and Mermaid architecture diagrams. Prior designs are not consulted during
an independent review; design history is opened only after the attempt ends.

`practice_design_template` is a read-only draft builder in
`src/design-session.ts`. It creates a deterministic six-step progress draft and
valid uncompressed Excalidraw JSON under `Solutions/<short-topic>-<today>/`.
Topics must be single-line text without control characters, `%%` or code fences
so the canvas Markdown structure cannot be changed by the title.
It does not run the canonical CLI, inspect existing sessions, or save files.
List the relevant catalog first and resume an appropriate existing WIP/planned
session instead of blindly creating another one. Preview and explicitly confirm
both drafts before separately saving them with `practice_create_note`.

On resume, read both progress.md and the actual catalog-returned canvas path,
including its uncompressed Text Elements. Preserve historical links and legacy
next-step headings. Large canvases use ordinary chunked reads; managed note
updates still require a complete bounded read and current revision.

Initialization, progress checkpoints, planned/wip/done transitions and Phase 3
Pattern/Insight/Log saves all require previews and explicit confirmation. This
MCP rule replaces the upstream skill's automatic file writes. Mark a session
done only after its agreed saves succeed. Host confirmation and native Obsidian
canvas rendering require acceptance checks after deployment.

Individual managed notes are limited to 64 KiB. General `read_note` supports
chunked reads of larger notes; the write tools refuse to replace a partially
read or oversized note. No history truncation, archive move or object deletion
is implemented. Obsidian remains responsible for rendering Dataview views.
ChatGPT does not gain a Python runner or an Obsidian UI from MCP.

## Activation procedure

1. Confirm the read-only tools and instruction flow in ChatGPT first.
2. Review `practice.writesEnabled: true` in `config/mcp-runtime.json` and
   synthesize the concrete foundation and application diffs. The same
   configuration drives the IAM grant and runtime scope; mismatched settings
   are rejected.
3. Apply the approved IAM-only prerequisite through local SSO, following
   [the permission-update procedure](github-actions.md). CI cannot expand its
   own IAM permissions. Grant only encrypted conditional PutObject on the
   reviewed practice data paths. No DeleteObject or library-bucket access.
4. Review CI Plan, then approve application Apply separately. System Design
   extends the existing tool contracts and adds the read-only template tool;
   its saves use the existing `/write` OAuth scope.
5. Refresh ChatGPT's tool metadata. If connecting for the first time, authorize
   both read and write scopes. Keep the client secret
   in its appropriate OAuth field, never in a chat or this repository.
6. Use an explicitly agreed disposable session to verify a confirmed save,
   cancelled save, stale concurrent edit and same-attempt retry. Record the
   observed host confirmation and S3 results before declaring write acceptance
   complete.

No AWS activation or private-note test mutation is authorized by the local
checks or the existence of this code. Obtain approval of the concrete AWS plan.

## Validation

```sh
npm run check
npm run synth
```

The suite uses the actual MCP SDK client and real AWS SDK serialization with
local in-memory/HTTP fixtures. It covers scheduling, module guards, read-only
catalogs, scope enforcement, encrypted conditional writes, retries, conflicts,
neutral prompts, preserved history, mixed-domain queues, System Design session
drafts and domain-specific permissions. The HTTP handler and S3 adapter remain
domain-independent.
It does not use real notes, user credentials or a live AWS deployment.
