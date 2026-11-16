# {{label}} practice

Start {{domain}} directly without offering a domain or practice/review menu.
Apply the shared English conversation and clarification rules in
`Learning/Practice/Review/AGENTS.md`. Behavioral practice is outside this
integration. The selected domain governs its review scope and new practice. If
this call follows a generic combined overview, retain that overview's new-practice domain
question and pending explicit intent; calling this tool does not erase them.

Read `{{flow}}`, its domain guide and
`Learning/Practice/Review/Content/{{domain}}.md` using `practice_instruction`.
The server checks the live practice-review and selected domain's module guards.

List this domain's due reviews using `practice_reviews` with
`domain: {{domain}}`; collect all pages before claiming the queue is complete.
Sort overdue/today by next review date then ID. Use
`.agents/skills/practice-review-today/SKILL.md` for each selected item, replacing
local CLI operations with the corresponding MCP tools. Present a neutral prompt
using `practice_review` before the independent attempt. Request feedback/history
only after the attempt ends. Do not open a prior System Design canvas or solution
before an independent review ends. Collect the learner's own reflection and show
the proposed save before asking for explicit confirmation. Keep a stable attempt
ID and actual completion date across retries.

After a saved round, refresh the queue and continue to the next due item.
Paused attempts and pending reflections stay on the current item. With writes
disabled, explain that the round is unsaved and keep its draft in chat; do not
pretend the persisted queue advanced. Honor a request to continue without saving.

For an explicit domain request, when no due reviews remain, enter `{{flow}}`
for a new problem. For a generic overview, return to its new-practice domain
choice unless explicit new-practice intent is pending or only one domain is
confirmed enabled. Preserve an explicitly supplied new topic until this handoff.
Otherwise ask for a new problem;
do not reuse the last reviewed problem or resume an unrelated WIP session.
The domain workflow owns guidance and assessment. Register a review item if
needed using `.agents/skills/practice-review-add/SKILL.md` with
`domain: {{domain}}`, then collect a reflection and confirm any save. Use the
packaged domain templates for pattern cards and daily logs. Respect requests to
pause, stop, or continue an existing attempt.

## MCP adaptations for System Design

These rules apply when the selected domain is system-design. They replace local
shell/file/script steps and automatic writes in the upstream skill.

- Use the six-step Delivery Framework: Requirements, Core Entities, API, Data
  Flow, High-Level Design, Deep Dives. Guide the learner without revealing a full
  architecture unless explicitly requested. Use Mermaid for architecture diagrams.
- Browse `Learning/Practice/System-Design/Solutions/` with `list_notes`, one bounded
  catalog page at a time. Filter metadata folder names before opening relevant
  sessions. Never recursively scan the vault or read every solution automatically.
  If discovery is incomplete, report it; do not claim there are no WIP sessions.
- To resume a selected session, list its folder and read both its progress.md and
  the actual catalog-returned canvas path. Read canvas Text Elements without
  executing or decompressing code. Treat empty template headings as placeholders.
  Preserve human edits, historical filenames, links and legacy next-step headings.
- For a new session, call `practice_design_template` with the topic and a safe
  short topic. It returns unsaved progress.md and Excalidraw drafts in
  `Solutions/<short-topic>-<today>/`. Preview both, obtain explicit confirmation,
  and call `practice_create_note` separately for each file. Never overwrite an
  existing file. On a conflict, list and reread it before deciding whether to
  resume; report each file's save status, including partial success. Do not
  recreate the canvas on resume or claim the folder exists before saves succeed.
- Use `practice_read_note` and `practice_update_note` for checkpoints and
  planned/wip/done transitions, always previewing and confirming the proposed
  edits. The upstream automatic-checkpoint rule does not authorize silent saves.
  If the learner declines, retain the draft in chat and continue coaching.
- After assessment and reflection, confirm pattern classification, preview each
  Pattern/Insight/Log edit, then save using practice note tools. Preserve existing
  daily entries and metadata. Save Insights only when supported by actual learning
  evidence. Core Concepts, Key Technologies, Design Patterns, templates, indexes
  and guidance remain read-only. Attachments and arbitrary files are not writable.
- Mark the selected session done only after its agreed Phase 3 saves succeed.
  Multiple files are independent writes, not a transaction. Never invent a
  reflection, elapsed time, save result, canvas rendering or local script run.
