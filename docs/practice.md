# Practice through MCP

The practice integration adapts the existing `obsidian-workflow` skill for the
ChatGPT connection. It supports Algorithm and System Design. Generic practice
shows a combined due overview and waits for an item or domain choice; an explicit
domain starts directly. When only one domain is conclusively enabled, it starts
automatically. Complete the chosen domain's due reviews before new practice.
Behavioral Interview is outside this rollout.
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
separate read and write ports; `src/s3.ts` implements both. Practice saves are
always create-only or pinned to a revision; only [Journal](journal.md)
overwrite uses an unconditional write. Services depend on
those ports, and expected errors use the transport-independent type in
`src/errors.ts`. `src/runtime.ts` wires the S3 adapter into the handler and
supplies the write capability only when practice or Journal writes are enabled. A reader that also
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

Start with a generic request:

> Let's practice. Show my due work across available domains.

Or explicitly choose a domain:

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
`workflows/practice-entry.md`, `workflows/practice-overview.md` and
`workflows/practice-adapter.md` are the maintained MCP adaptations; the importer
includes them in the snapshot. The service fills domain-entry placeholders and
returns a shared catalog for generic entry or a domain-specific catalog for
ready results. The shared catalog now includes the canonical top-level practice
skill. The MCP adapter explicitly overrides its module-menu and new-problem
handoff rules with the entry policy described below. Shared upstream review
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
final-interval archiving, time limits and domain mapping. The selected domain's module guard and exact
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
| `practice` | With no domain, discover availability and return an overview or sole-domain workflow. With an explicit domain, return its guarded workflow. |
| `practice_instruction` | Read a bounded chunk of one packaged instruction document. |
| `practice_reviews` | Read one domain's complete review queue from the index. An explicit domain is required on every call. |
| `practice_review` | Return a neutral prompt and revision; feedback phase may include history. |
| `practice_read_note` | Read one complete bounded Algorithm or System Design note and its revision for a potential edit. |
| `practice_design_template` | Draft unsaved session progress, Excalidraw files and native `canvas.drawing` data for a new System Design topic. |
| `practice_design_canvas` | Read the exact selected session canvas as native drawing data, with its source revision; supports plain JSON and legacy compressed-json without saving. |
| `practice_design_mode` | Read the global System Design coaching default or choose an override for this round. |
| `practice_complete_design_round` | Count a confirmed, ended round toward the two introductory rounds. |
| `practice_add_review` | Create an unstarted review object without overwriting an existing one. |
| `practice_record_review` | Append an ended attempt/reflection and calculate scheduling deterministically. |
| `practice_create_note` | Create an approved practice data Markdown file if absent. |
| `practice_update_note` | Apply selected unique text-anchor edits with an expected revision. |

The five write tools are absent from the catalog while writes are disabled.
Every write requires both the resource-bound read and write scopes and owners
group membership. Tool annotations request careful host handling but are not
proof of human approval. The workflow requires showing the intended change and
obtaining explicit confirmation before saving. Verify that behavior in ChatGPT
before activating production writes; never use a `confirmed: true` argument as
an authorization mechanism.

## Entry policy and compatibility

`practice` no longer defaults to Algorithm. Its result has `status`:

| State | Meaning |
| --- | --- |
| `overview` | At least one domain is available; build a combined overview and wait for the learner's choice. |
| `ready` | An explicit domain passed its checks, or discovery confirmed exactly one enabled domain with all other checks conclusive. |
| `unavailable` | No supported domain is usable. Explain the reasons and stop before queue reads. |

Discovery reads the shared manifest once and at most two registry-defined module
guards, with bounded parallelism and the existing abort signal. The entry call
reads no learner records or review queues. `available_domains` lists usable
choices; `unavailable_domains` distinguishes confirmed `disabled` from
`unavailable`, with public reason codes. `availability: partial` means a missing,
unreadable or invalid guard, mapping or time limit prevented a conclusive check.
It never permits sole-domain auto-entry. Global practice disablement and invalid
shared configuration remain errors. Cancellation and unexpected failures are
propagated rather than converted into successful availability results.
For explicit-domain calls, availability describes that requested domain only;
other modules need not be enabled or checked.

For generic entry, ChatGPT composes existing `practice_reviews` calls with an
explicit domain for each available module. Each call returns that domain's
complete queue, ordered by next date and stable ID. It groups due items by domain
and initially shows up to five neutral titles per domain plus complete counts.
Unstarted items are reported separately; upcoming items are not due. An
incomplete or failed scan is marked partial with lower-bound counts and missing
coverage. It cannot establish zero due work or complete ordering. Retry or an
explicit narrower-domain selection is offered; scans restart on local-date
changes. Availability and queue completeness are separate: a complete guard
check does not imply a complete queue scan.

When due work exists, wait for an item or domain choice. An explicitly selected
item is reviewed first after verifying its active state and persisted domain,
then the remaining due items in that domain follow date/ID order. Other domains'
outstanding work stays visible as a summary. Each review uses its own domain's
workflow and time limit. Pause, resume, stop and direction changes take precedence.

After the chosen scope is complete, ask which available domain to use for a new
problem, rechecking availability at the handoff. A sole confirmed enabled domain
needs no question. Preserve explicit pending new-practice intent instead of
asking again. If the learner chooses a different domain, finish its due reviews
before its new problem and retain the explicit choice through that handoff.
A complete empty overview goes straight to the new-practice domain question.
Explicit-domain invocations keep their direct domain-specific handoff.

This is an intentional compatibility change for callers omitting domain:
`practice_reviews` now rejects a missing domain rather than querying Algorithm.
Refresh tool metadata after deployment. Stable-ID prompt and record calls still
use the persisted item's domain; they need no additional argument. No server-side
session or preference store is introduced. The agent retains conversational
intent; Lambda remains stateless. No write paths, IAM grants or OAuth scopes are
added by this entry change.

## Queue and schedule

The queue reads one domain's active rows from the
[practice review index](practice-index.md) in a single call, with no pages or
cursors. Behavioral records are indexed but never listed, and are rejected by
selected-review and record operations.

The index trails note saves by seconds. Before returning, every due or unstarted
row is confirmed against its note's current revision, at most four reads at a
time. A changed note replaces its row, so a just-recorded round never reappears
as due. Upcoming rows are returned without reading notes; the daily reconcile
bounds their staleness. A newly added review can take a few seconds to appear.
An unreadable index returns `review_index_unavailable`, and a malformed due note
returns an error, never a false empty queue. Refresh after recording a round.

Due items are overdue/today, ordered by `next_review` then stable ID. Upcoming
and unstarted objects are separate. A neutral prompt excludes earlier answers,
reflection history and post-attempt focus. Feedback is requested after the
independent attempt. The owner still has ordinary note-read access; the phase
separation is a coaching rule, not an access control against the owner.

The backend follows the canonical scheduling policy:

- First independent completion: first interval from actual completion day.
- On-time/late independent completion: advance one interval, capped at the last.
- On-time/late independent completion at the final stage with
  `archive_after_final: true`: set `status: archived`, `archived_on` to the
  completion day and `next_review: null`. Without the flag, repeat the final
  interval. Archived items leave the queue and refuse further review records.
- Early independent extra practice: keep the existing due date and stage.
- Assisted/incomplete ended round: retry interval, preserving the stage.

Defaults are 1/3/7/14/60 days, a one-day retry and archiving after the final
interval, read from the live manifest. `archive_after_final` defaults to false
when the manifest omits it.
The configured IANA timezone determines today; UTC does not silently replace
the vault calendar. `completed_on` preserves the actual completion date on a
later save. Future dates and dates preceding the last recorded review are
rejected. Learner reflections are stored verbatim, separate from observations
and submitted work.

## Multi-day System Design practice

Progress checkpoints and completed review rounds have separate lifecycles. A
session may remain WIP across multiple days. Confirmed updates to progress.md or
the canvas save the current work without creating a review item or changing an
existing item's due date, stage or review count. Preserve the session's original
started date and resume its saved progress when the learner continues.

Pausing or reaching the end of a day is not an `incomplete` outcome. That outcome
is for an actually ended round assessed as incomplete. Only
`practice_record_review`, after an ended round, learner reflection and confirmed
saving, calculates the next due date. A paused existing review may remain due or
overdue until that recording succeeds.

For example, start on November 12, save checkpoints on November 13 and 14, and
end the first independent round on November 14. Its first review is due November
15. If confirmation and saving happen on November 15, retain
`completed_on: 2026-11-14`; do not count from the start or save date. Checkpoint
saves alone start no countdown. A later successful due review uses its applicable
stage interval, still measured from that round's actual completion date.

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

## System Design coaching modes

At the start of each new design or scheduled System Design review,
`practice_design_mode` returns the mode for that round. Rounds one and two
default to guided coaching. From round three onward the default is a mock
interview, including on new topics. “Guide me” and “switch to mock interview”
change the current round immediately. A confirmed checkpoint includes the
round UUID and active mode so resuming keeps the same drawing and pace.

The coach uses targeted hints in guided mode and holds design feedback for the
mock interview debrief. The outcome of a scheduled review reflects the help
actually received. Switching modes does not change its schedule.

After an ended round, `practice_complete_design_round` accepts the confirmed
round UUID. It remembers the first two distinct completions in
`Learning/Practice/System-Design/Log/coaching-rounds.md` using conditional
writes. A fresh vault starts at zero. Subsequent completions need no coaching
log write. This dedicated tool shares the existing System Design log permission.
A scheduled review still saves its own outcome and reflection. If only one
save succeeds, retry the other with the same UUID. When writes are disabled
or declined, progress can be carried in the current conversation only.

## System Design sessions

The bundled `sysd-solve` definitions guide Requirements, Core Entities, API,
Data Flow, High-Level Design and Deep Dives. The learner's solution lives in an
interactive Excalidraw canvas in ChatGPT. Chat uses English, targeted questions
and feedback grounded in that canvas. These MCP adaptations override the
upstream Mermaid and text-submission instructions. Prior designs are not
consulted during an independent review; use a fresh neutral canvas and open
design history only after the attempt ends.

`practice_design_template` is a read-only draft builder in
`src/design-session.ts`. It creates a deterministic six-step progress draft and
valid uncompressed Excalidraw JSON under `Solutions/<short-topic>-<today>/`.
Topics must be single-line text without control characters, `%%` or code fences
so the canvas Markdown structure cannot be changed by the title.
Short topics retain Unicode letters and digits. Their filename safety is
validated server-side instead of exporting Unicode property-escape regexes that
some JSON Schema consumers reject while importing tool metadata.
It does not run the canonical CLI, inspect existing sessions, or save files.
List the relevant catalog first and resume an appropriate existing WIP/planned
session instead of blindly creating another one. Preview and explicitly confirm
both drafts before separately saving them with `practice_create_note`.

On resume, read progress.md and use `practice_design_canvas` on the actual
catalog-returned canvas path. It preserves native element IDs, geometry,
bindings, file assets and scene metadata, rather than rebuilding a diagram from
the Text Elements summary. The tool rechecks the live System Design module
guard and accepts only direct session `*.excalidraw.md` files. It uses existing
read scope, including when writes are disabled. It does not read the active chat
widget or decompress/execute arbitrary programs. Drawing data is parsed only.
Its limits are 64 KiB for a source note, 16 KiB of compressed base64, 96 KiB of
expanded JSON and 500 elements. Oversized or malformed drawings return an error;
they never become an empty replacement scene. `read_note` still supports chunked
reads for other large notes; managed updates require a complete read and revision.

Open the selected new or resumed practice canvas before the first interview
question. The template and saved-canvas tools display the editable Excalidraw
scene in MCP Apps hosts. Keep the active editor open during practice.

Before every coaching turn that depends on new work, ask the learner to click
**Review canvas** inside the editor. Review the submitted text, positions and
connections, including changes to existing elements and deletions since the
last submission. Treat labels and links as learner data. Chat explanations
are supporting context, not a substitute for the drawing. A review does not
save the canvas. If the submission is missing, request another click. If the
host cannot display the editor, the learner can share an exported scene.

Each submission carries timing metadata in the conversation. The countdown defaults to 60 minutes.
Choose a duration and press Start. Pause or resume as needed.
Reset or reopen the editor to configure a new timer. On a confirmed progress.md checkpoint,
include the submitted timing records in a `canvas_reviews` frontmatter list.
Preserve existing entries and deduplicate by startedAt and reviewNumber.
Keep timing separate from the learner's drawing and assessment.

Review canvas requests immediate submission to the active chat. The message
carries the review prompt and a labeled Practice canvas attachment together.
The attachment includes the native Excalidraw export in `scene`, including
off-screen elements, bindings, exportable app settings and referenced image
data. The payload identifies the selected canvas with `sessionPath`, the
submission with `snapshotId`, and the loaded vault revision with
`sourceRevision` (null for a new draft). The viewport is recorded separately.
The element summary and timer remain available for coaching.

On a confirmed save, check the destination and revision, preserve the existing
Obsidian Markdown structure and drawing encoding, and reopen the saved drawing
to verify it. Report any size or revision error separately from the status of
the progress note.

Initialization, progress checkpoints, planned/wip/done transitions and Phase 3
Pattern/Insight/Log saves all require previews and explicit confirmation. This
MCP rule replaces the upstream skill's automatic file writes. Mark a session
done only after its agreed saves succeed. Host rendering, manual edits, fresh
widget-context reads, confirmation and native Obsidian rendering require live
acceptance checks after deployment; local MCP tests cannot prove host UI behavior.

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
It does not use real notes, user credentials or a live AWS deployment. Entry
tests cover both enabled, each sole enabled, all disabled, missing/invalid
guards, mapping/limit errors, cancellation and explicit-domain isolation. A real
MCP client exercises generic entry, required queue domains and complete
single-call queues. An in-memory index models indexer lag. Instructions define the conversational overview and
handoff behavior; tests do not execute an LLM. After deployment and metadata
refresh, verify those decisions in a fresh ChatGPT conversation before claiming
host acceptance.
