# Practice through MCP

The practice integration adapts the existing `obsidian-workflow` skill for the
ChatGPT connection. It supports Algorithm and System Design. Generic practice
shows a combined due overview and waits for an item or domain choice; an explicit
domain starts directly. When only one domain is conclusively enabled, it starts
automatically. Complete the chosen domain's due reviews before new practice.
The MCP server is the only scheduler: local sessions call the same tools.
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
includes them in the snapshot. A domain's own adaptations live in
`workflows/practice-entry-<domain>.md` and are appended to the entry only for
that domain, so Algorithm never receives the System Design or SD Blocks canvas
rules. The service fills domain-entry placeholders and
returns a shared catalog for generic entry or a domain-specific catalog for
ready results. The shared catalog now includes the canonical top-level practice
skill. The MCP adapter explicitly overrides its module-menu and new-problem
handoff rules with the entry policy described below. The canonical guides call
the practice tools by name, so no tool mapping is needed.
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

The live S3 practice-review manifest controls `enabled`, the global `schedule`
rule and `shared_criteria`. Its `consumers` table registers each module that
uses spaced review: `enabled`, `module`, `flow`, `time_limit` and an optional
`placement_interval` (see [Queue and schedule](#queue-and-schedule)). Each module
declares `pass_criteria` in its own `module.md`, referring to shared criteria
by id or defining its own with an `id` and a `rule`. A module is usable only
when all five hold, checked before its actions:

1. practice review is enabled (`practice_module_disabled`); a manifest missing these settings, such as one without `consumers`, fails every module with `invalid_practice_config`
2. its consumer entry is enabled (`consumer_disabled`, or `consumer_not_registered` when absent)
3. its own module is enabled (`domain_module_disabled`, `invalid_domain_module`)
4. its entry, pass criteria and own data are valid (`invalid_consumer_config`, `invalid_review_time_limit`, `invalid_placement_interval` for one that is not a schedule interval, `invalid_pass_criteria` for none, an unknown shared id, a repeated id or a missing rule; for SD Blocks, `block_map_missing` or `invalid_block_map` as described in [SD Blocks](#sd-blocks))
5. its workflow was imported: `flow` matches the definition in this server's snapshot (`workflow_mapping_changed_refresh_required`)

`practice` reports a module switched off by 2 or 3 as `disabled` and any other
failure as `unavailable`, with the reason and, where the check found several
problems, each one in `errors`. A disabled Algorithm module
does not block System Design, or vice versa. Entries for other domains in the
shared manifest are ignored.
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
| `practice_review` | Return a neutral prompt and revision; feedback phase may include history. An SD Blocks item also returns its block, with points ordered for rotation. |
| `practice_read_note` | Read one complete bounded Algorithm, System Design or SD Blocks note and its revision for a potential edit. |
| `practice_design_outline` | Return in-scope follow-ups and canonical evidence; see [System Design evidence](#system-design-evidence). |
| `practice_design_template` | Draft unsaved session progress, Excalidraw files and native `canvas.drawing` data for a new System Design topic. |
| `practice_design_canvas` | Read the exact selected session or block review canvas as native drawing data, with its source revision; supports plain JSON and legacy compressed-json without saving. |
| `practice_block_template` | Draft an unsaved SD Blocks review canvas, showing the block and the scenario, at `Blocks/Reviews/<block>/<day>-<attempt>.excalidraw.md`. |
| `practice_add_review` | Create an unstarted review object without overwriting an existing one. |
| `practice_record_review` | Append an ended attempt/reflection and calculate scheduling deterministically. |
| `practice_finish_round` | Close out a confirmed attempt with its criteria judgment, including System Design assessment and profile saves. |
| `practice_rebuild_design_profile` | Rebuild the generated index; see [System Design evidence](#system-design-evidence). |
| `practice_stage_canvas` | Stage a reviewed drawing and return its snapshot receipt. |
| `practice_save_canvas` | Conditionally save a reviewed drawing and verify it by reading it back. |
| `practice_create_note` | Create an approved practice data Markdown file if absent. |
| `practice_update_note` | Apply selected unique text-anchor edits with an expected revision. |

Write tools are absent from the catalog while writes are disabled.
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
cursors. Records of a domain without a registered consumer are indexed but never
listed, and are rejected by selected-review and record operations.

The index trails note saves by seconds. Before returning, every due or unstarted
row is confirmed against its note's current revision, at most four reads at a
time. A changed note replaces its row, so a just-recorded round never reappears
as due. Upcoming Algorithm rows are returned without reading notes; the daily
reconcile bounds their staleness. System Design also confirms upcoming rows and
normalizes their schedules as described below. A newly added review can take a
few seconds to appear.
An unreadable index returns `review_index_unavailable`, and a malformed due note
returns an error, never a false empty queue. Refresh after recording a round.

Due items are overdue/today, ordered by `next_review` then stable ID. Upcoming
and unstarted objects are separate. A neutral prompt excludes earlier answers,
reflection history and post-attempt focus. Feedback is requested after the
independent attempt. The owner still has ordinary note-read access; the phase
separation is a coaching rule, not an access control against the owner.

Every module follows one schedule rule, read from the live manifest's
`schedule`. A module cannot change it.

- An item starts at stage 0: it has never passed. Stage N waits
  `intervals[N - 1]` days (1, 3, 7, 14, 30, 60), counted from the day the
  attempt ended.
- A pass moves up one stage. A pass at the top stage, with
  `archive_after_final: true`, sets `status: archived`, `archived_on` to the
  completion day and `next_review: null`; without it the item repeats the top
  interval. Archived items leave the queue and refuse further records.
- A fail drops `on_fail.step_back` stages, never below 0, and is retried after
  `on_fail.retry_days`.
- Early attempts count like on-time ones.
- A module whose consumer entry sets `placement_interval` can record an item's
  first attempt as a placement (`placement: true`). A passed placement moves
  straight to the stage that waits that interval, instead of stage 1; a failed
  one is an ordinary fail. A placement on a later attempt is refused with
  `placement_requires_first_attempt`, and one in another module with
  `placement_not_supported`. The history entry's result line records
  `Placement`, so a replay reaches the same stage.

Every ended attempt is judged, including a first attempt at a new problem. The
agent submits `criteria`: every criterion in the module's `pass_criteria`, once
each, with `met` and its `evidence`. The core rejects a missing, extra or
repeated criterion with `criteria_mismatch` before any write, and computes the
result itself: an attempt passes only when every criterion is met. The item
stores `last_result` and `unmet_criteria`; the history entry lists each
criterion with its evidence. Retrying a registered attempt ID does not advance
again, including after archive.

Items recorded before this rule were migrated once with
`bin/migrate-review-schedule.ts`, which replays each history from stage 0.
Legacy outcomes convert as agreed: `independent` meets every criterion,
`assisted` misses `no_substantive_help`, and `incomplete` misses the module's
completion criterion (`tests_pass` or `all_steps_done`). A placement replays at
its module's placement stage. `completed`, written
when a System Design attempt omitted its outcome, never recorded independence
and misses `no_substantive_help`. Replay reads an attempt only at a full entry
heading with its result line, and criteria only from that entry's own
`#### Pass criteria` block, so learner text cannot change the result. Run it on a temporary
vault copy first:

```sh
npx --no-install tsx bin/migrate-review-schedule.ts /path/to/vault-copy --report report.json
npx --no-install tsx bin/migrate-review-schedule.ts /path/to/vault-copy --write
```

Without `--write` it only reports. With `--write` it refuses to run while any
item has an error, rewrites only the schedule frontmatter, keeps every history
entry as recorded and verifies that a second pass changes nothing.

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

Pausing or reaching the end of a day is not a failed attempt. Only an attempt
that actually ended is judged. Use
`practice_finish_round` after an ended attempt, learner reflection and confirmed
saving; it delegates scheduling to the same registration flow as
`practice_record_review`. A paused existing review may remain due or
overdue until that recording succeeds.

For example, start on November 12, save checkpoints on November 13 and 14, and
end the first attempt on November 14. Its first review is due November
15, whether it passed or failed. If confirmation and saving happen on November 15, retain
`completed_on: 2026-11-14`; do not count from the start or save date. Checkpoint
saves alone start no countdown. A later review uses its applicable
stage interval, still measured from that attempt's actual completion date.

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
files are not writable through generic note tools. The generated profile uses
the dedicated [evidence flow](#system-design-evidence). Multiple note saves are
independent operations. Report each result honestly, including partial success.

## System Design attempts

There are no guided rounds or fixed round counts. A first attempt at a new
problem may be coached; every later review is an independent attempt with a
neutral prompt. Both are judged against the four System Design criteria, and
any substantive help fails `no_substantive_help`. `practice_record_review` saves
the judgment, count and schedule in one conditional write.

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
Configure the note, edit, compressed drawing, decoded scene, element count and HTTP payload limits in `config/mcp-runtime.json` under `limits`. Oversized or malformed drawings return an error;
they never become an empty replacement scene. `read_note` still supports chunked
reads for other large notes; managed updates require a complete read and revision.

Open the selected new or resumed practice canvas before the first interview
question. The template and saved-canvas tools display the editable Excalidraw
scene in MCP Apps hosts. Keep the active editor open during practice.

Before asking another question or requesting a canvas review, apply the stopping rule in sysd-solve. Give the final review immediately when the core flows and selected tradeoffs have been assessed, the learner asks to finish, or verified active time reaches the shortest of the returned `time_limits["system-design"]`, 45 minutes, and any shorter agreed budget. Use the evidence already available and identify any gaps. An idle or paused timer alone does not end the interview. An explicit pause keeps the round resumable.
Before every coaching turn that depends on new work, ask the learner to click
**Review canvas** inside the editor. Review the submitted text, positions and
connections, including changes to existing elements and deletions since the
last submission. Treat labels and links as learner data. Chat explanations
are supporting context, not a substitute for the drawing. A review does not
save the canvas. If the submission is missing, request another click. If the
host cannot display the editor, the learner can share an exported scene.

Each submission carries timing metadata in the conversation. Press Start to count elapsed practice time from 00:00.
Each review captures total elapsed seconds at the click and the interval since the previous successful review. Paused time is excluded.
Reset or reopen the editor to start a fresh stopwatch. On a confirmed progress.md checkpoint,
include the submitted timing records in a `canvas_reviews` frontmatter list.
Preserve existing entries and deduplicate by startedAt and reviewNumber.
Keep timing separate from the learner's drawing and assessment.

Review canvas requests immediate submission to the active chat. The message
carries the review prompt and a labeled Practice canvas attachment together.
On hosts that support text context updates, the widget also shares the same
snapshot for the next turn. If the composer cannot submit or the reply stream
fails after submission, say or type “Review my canvas” when the widget shows
that option. The follow-up uses the original snapshot and timer reading.
The attachment includes the native Excalidraw export in `scene`, including
off-screen elements, bindings, exportable app settings and referenced image
data. The payload identifies the selected canvas with `sessionPath`, the
submission with `snapshotId`, and the loaded vault revision with
`sourceRevision` (null for a new draft). The viewport is recorded separately.
The element summary and timer remain available for coaching.

With practice writes enabled, Review canvas calls `practice_stage_canvas` from the ChatGPT widget. One encrypted draft per canvas path is kept under `Learning/Practice/.canvas-reviews/`. Each successful review returns its storage revision as a snapshot receipt. The next review can replace this draft. On step transitions the coach automatically checkpoints the reviewed drawing and then progress.md unless the learner opts out. If staging was unavailable, practice_save_canvas also accepts the exact full scene attached to that review, with the same destination revision check and read-back verification. That operation reads the staged scene, conditionally creates or updates the target, and verifies it by reading back the scene. The model only needs to pass the receipt, path and target revision. Deploy the runtime role's conditional write grant for the draft prefix before the application update.

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

Managed practice notes use the configured `practiceNoteBytes` limit. General `read_note` supports
chunked reads of larger notes; the write tools refuse to replace a partially
read or oversized note. No history truncation, archive move or object deletion
is implemented. Obsidian remains responsible for rendering Dataview views.
ChatGPT does not gain a Python runner or an Obsidian UI from MCP.

## SD Blocks

SD Blocks reviews each building block article of System Design on its own
schedule. Its data is `Learning/Practice/System-Design/Blocks.md`, which the
learner maintains and the server only reads: one `## <block-id>` section per
block with its `note` link, optional `cards` links and 4 to 8
`- <point-id>: <text>` points, then a `## Problems` table with the columns
`problem`, `note`, `core` and `uses`. Links resolve relative to the System Design
folder.

Every SD Blocks call loads and checks the map once per request: it must parse
strictly, every block and point id must be well formed and unique within its
scope, every problem must refer to defined blocks with at least one core block
and none in both columns, and every linked note must exist, which costs one
listing per linked folder. A missing map makes SD Blocks unavailable with
`block_map_missing`; any other problem with `invalid_block_map`, listing every
error with its line in the availability report. Other domains are unaffected.

- Each block is one review item, `sdb-<block-id>`; adding an item for an id that
  names no block is refused with `unknown_block`. `practice` with
  `domain: sd-blocks` returns `blocks`, every block in map order with its item
  state or `item: null`, using the index and reading only items it does not hold.
- Every SD Blocks attempt carries `points`: one `{id, result, evidence}` per
  examined point, with `result` `mastered`, `partial` or `weak`. They must be
  points of the item's block, once each (`block_points_required`,
  `block_points_mismatch`), checked before any write. They are stored in the
  history entry as a `#### Points` section after the criteria. When the module
  judges `points_answered`, it must be met exactly when every examined point is
  `mastered` (`points_answered_mismatch`). Other modules refuse `points`. A
  retried attempt that is already recorded is returned without these checks,
  so a later edit of the map cannot make its retry fail.
- `practice_review` returns the block's points in rotation order: never
  examined, then last answered weak, partial and mastered, each least recently
  examined first. Points are read only from each entry's own Points section,
  before any learner text.
- The consumer sets `placement_interval: 14`, so a familiar block's passed
  placement review starts at stage 4.
- Review canvases are written only to
  `Learning/Practice/System-Design/Blocks/Reviews/*/*.excalidraw.md`, through
  the same stage and save tools as session canvases. This is the module's only
  write path, shared with IAM synthesis. `Blocks.md`, the articles, cards and
  breakdowns are read-only; reading them is guarded by System Design.

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

## System Design evidence

System Design registration accepts and returns question-level `concept_ids`.
Use `practice_design_outline` with the registered `id`, or with `concept_ids`
before registration. It limits probes and variants to those concepts and returns
canonical assessment evidence. Uncovered concepts have no prior evidence.

Submit structured `concept_observations` through `practice_finish_round` with the
session's `progress_path`; standalone `practice_record_review` rejects nonempty
structured evidence. Closeout remains pending until assessment and profile writes
succeed. `practice_rebuild_design_profile` regenerates the profile from progress
assessment fences, including older corrections, without advancing any round.
The generated index lives at `Learning/Practice/System-Design/Profile.md`.
Profile replacement is conditional and preserves a concurrent writer's version.

Same-day observations use optional `evidence_order` when the answer order is known.
Unordered legacy evidence retains stable session-path order and saved order within
each assessment. Unordered observations keep their encounter positions while
explicitly ordered observations are sorted within that day’s ordered positions. Attempt IDs do
not establish chronology. Earlier observations remain in the profile snapshot.
A finalized finish retry preserves corrected assessments. An authorized finish
can attach supplied concepts to a System Design question whose concept list is
empty, without replacing an existing nonempty list.

Observation `date` is the answer day, preserved independently of round completion.
Completion day is used only when no answer date is recorded. Valid undated
observations in another unfinished WIP session are deferred until its completion
date exists, preserving that assessment. Finish preflight uses the selected
session's supplied completion date. A recognized `practice-observations` fence
with an invalid date or performance fails validation before finish writes or
profile replacement; correct the assessment before retrying.

Only learner answers contribute mastery conclusions; interviewer answers do not.
Observations are deduplicated by `observation_id`; the latest evidenced answer
sets each concept's current conclusion while contrary evidence is retained.
`error_id` identifies a recurring error across weak or partial answers in distinct
attempts, including across different concepts; summaries remain descriptions,
not identities. Generic practice note writes reject the
profile. Only finish-triggered and explicit rebuilds replace that generated index.
