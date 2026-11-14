# Practice through MCP

The practice integration adapts the existing `obsidian-workflow` skill for the
ChatGPT connection. The MVP supports Algorithm only: start directly, complete
due Algorithm reviews, then start a new problem. System Design and Behavioral
Interview are outside this rollout.
ChatGPT guides and assesses the conversation; Lambda performs typed data
operations. Lambda does not host an LLM, execute arbitrary code or run a local
Python process.

## Rollout state

This PR enables the read-only practice tools in versioned configuration. The
write implementation is included and tested, but `practice.writesEnabled` is
**false**. No practice write scope or S3 write grant is activated by this PR.
Until a separately reviewed activation, the assistant can coach, read the queue
and return drafts, and must explicitly say that drafts have not been saved.

After merge, inspect CI Plan and approve Apply to install the read-only runtime.
Refresh the connection's tools in ChatGPT. Start with:

> Start my Algorithm practice. Complete due reviews before a new problem.

`practice` is an MCP tool the model can call. Connecting the server does not
install local `SKILL.md` files as native ChatGPT slash commands. The tool returns
the user-requested workflow and an instruction catalog. The model retrieves
referenced definitions using `practice_instruction` and private data using MCP
read tools. Actual ChatGPT workflow interpretation still requires a human smoke
test; deterministic tests prove the protocol and persistence behavior.

## Source of truth

`workflows/practice.json` is a generated, versioned snapshot of the canonical
workflow repository's public tracked definitions, including Algorithm guides,
templates and review content definitions. `workflows/practice-entry.md` is the
maintained Algorithm-only MCP entry; the importer includes it in the snapshot.
Shared upstream review guides retain their original domain references, but the
entry restricts their use to Algorithm. It contains no
private review items, submissions, notes, credentials or environment files.
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
time limits and domain mapping. The Algorithm module guard is read before
practice actions. Other domain settings in the shared manifest are ignored.
A changed workflow mapping requires a reviewed source refresh,
rather than loading arbitrary executable code. Missing/invalid configuration
fails closed. Module configuration and guide files cannot be saved through the
practice write tools.

## Tool surface

| Tool | Behavior |
| --- | --- |
| `practice` | Start Algorithm directly; return workflow entry, instruction catalog and current configuration. |
| `practice_instruction` | Read a bounded chunk of one packaged instruction document. |
| `practice_reviews` | Read one bounded Algorithm review queue page. |
| `practice_review` | Return a neutral prompt and revision; feedback phase may include history. |
| `practice_read_note` | Read one complete bounded Algorithm note and its revision for a potential edit. |
| `practice_add_review` | Create an unstarted review object without overwriting an existing one. |
| `practice_record_review` | Append an ended attempt/reflection and calculate scheduling deterministically. |
| `practice_create_note` | Create an approved Algorithm Pattern/Atom/Log Markdown file if absent. |
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
with at most four concurrent object reads. Existing System Design and Behavioral
records are skipped when listing and rejected by selected-review and record
operations. Results and ordering are page-local.
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

Only Algorithm Pattern, Atom and Log notes can be created or edited through the
practice note tools. Review attempts use their dedicated tools. The shared
review folder remains unchanged; the backend enforces each record's domain.
Multiple note saves are independent operations. Report each result honestly.
No System Design session or Excalidraw creation tool is included in this MVP.

Individual managed notes are limited to 64 KiB. General `read_note` supports
chunked reads of larger notes; the write tools refuse to replace a partially
read or oversized note. No history truncation, archive move or object deletion
is implemented. Obsidian remains responsible for rendering Dataview views.
ChatGPT does not gain a Python runner or an Obsidian UI from MCP.

## Activate writes separately

1. Confirm the read-only tools and instruction flow in ChatGPT first.
2. Prepare a reviewed change setting `practice.writesEnabled: true` in
   `config/mcp-runtime.json`. Synthesize and review the concrete foundation and
   application diffs. The same configuration drives the IAM grant and runtime
   scope; mismatched settings are rejected.
3. Apply the approved IAM-only prerequisite through local SSO, following
   [the permission-update procedure](github-actions.md). CI cannot expand its
   own IAM permissions. Grant only encrypted conditional PutObject on the
   reviewed practice data paths. No DeleteObject or library-bucket access.
4. Review CI Plan, then approve application Apply separately. This adds the
   endpoint's `/write` OAuth scope and exposes write tools.
5. Refresh/reconnect ChatGPT with the additional scope. Keep the client secret
   in its appropriate OAuth field, never in a chat or this repository.
6. Use an explicitly agreed disposable test session to verify a save, cancelled
   save, stale concurrent edit and same-attempt retry. Do not
   claim host confirmation behavior or production writing is validated before
   observing it. Leave production writes disabled if that check cannot be done.

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
neutral prompts, preserved history, mixed-domain queues and Algorithm-only tools.
It does not use real notes, user credentials or a live AWS deployment.
