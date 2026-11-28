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

When pending_finalizations contains an ended WIP round, offer Finish registration using its existing progress.md. Keep it separate from practice resumption. Report discovery failure when this field is null.

On a fresh generic entry, use the returned unfinished_sessions before the
new-practice handoff, even when both due queues are empty. With one match,
show its topic and saved step and ask whether to resume. With multiple matches,
list them with their folder or date and ask which one to resume. Offer ordinary
practice as an alternative and wait; never auto-select. A null list means
discovery failed: say so and offer retry. On selection, load the System Design
workflow and read that exact folder's progress.md. Verify its current WIP tag and absence of a round_completed_on date,
then reopen its saved canvas and continue the checkpoint before any new topic
or due-review handoff. A declined reminder is not repeated during this entry.

List this domain's due reviews using `practice_reviews` with
`domain: {{domain}}`. One call returns the complete queue, with overdue/today
ordered by next review date then ID. Use
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
