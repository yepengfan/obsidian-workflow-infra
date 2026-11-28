# MCP practice adapter

The MCP entry rules override the canonical practice skill's module menu and
new-problem handoff. Generic requests use the
combined overview; explicit domain requests stay scoped. Preserve generic-entry
intent, the current review/handoff phase and any pending new-practice topic
across calls to practice. A handoff availability check does not restart entry.

Use `practice_instruction` for listed workflow definitions and `read_note` /
`list_notes` for private S3 notes. The canonical definitions already call the
practice tools by name. Always supply the domain to queue and add calls.
Include the selected session's progress_path when finishing a System Design round. At practice entry offer Finish registration for pending_finalizations, separately from resuming open rounds. Check the saved item and progress for prior registration, reuse the original attempt ID and completion date, and retry any saved confirmed_registration before asking for input again.
Each `practice_reviews` call returns one domain's complete queue, already
ordered; there are no pages or cursors. A newly added review can take a few
seconds to appear.

Use neutral prompts until the independent submission ends. Keep learner
reflections verbatim. Preview and obtain explicit save confirmation before every
write call, including initialization, checkpoints and status transitions. A
submission is not consent. System Design step-transition autosave is enabled for the active round's canvas and progress note unless the learner opts out. This narrow exception covers both checkpoint writes. Use `practice_create_note` / `practice_update_note`
for approved practice notes. Do not toggle modules through note writes.

No local shell, Python, Git or arbitrary program execution is available. If
writes are disabled, coach and draft in chat and explicitly report that nothing
was saved. Do not claim a timer or code execution occurred unless an actual host
tool performed it. Domain workflows own coaching and assessment.
