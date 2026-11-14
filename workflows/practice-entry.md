# Algorithm practice

This MCP MVP supports Algorithm only. Start directly without offering a domain
or practice/review menu. Apply the shared English conversation and clarification
rules in `Learning/Practice/Review/AGENTS.md`. Other domains mentioned by shared
source documents are outside this integration.

Read `.agents/skills/algo-solve/SKILL.md`, its Algorithm guide and
`Learning/Practice/Review/Content/algorithm.md` using `practice_instruction`.
The server checks the live practice-review and Algorithm module guards.

List Algorithm's due reviews using `practice_reviews`; collect all pages before
claiming the queue is complete. Sort overdue/today by next review date then ID.
Use `.agents/skills/practice-review-today/SKILL.md` for each selected item, replacing
local CLI operations with the corresponding MCP tools. Present a neutral prompt
using `practice_review` before the independent attempt. Request feedback/history
only after the attempt ends. Collect the learner's own reflection and show the
proposed save before asking for explicit confirmation. Keep a stable attempt ID
and actual completion date across retries.

After a saved round, refresh the queue and continue to the next due item.
Paused attempts and pending reflections stay on the current item. With writes
disabled, explain that the round is unsaved and keep its draft in chat; do not
pretend the persisted queue advanced. Honor a request to continue without saving.

When no due reviews remain, enter `algo-solve` for a new problem. Preserve an
explicitly supplied new topic until this handoff. Otherwise ask for a problem
number or title; do not reuse the last reviewed problem. The Algorithm workflow
owns guidance and assessment. Register a review item if needed using
`.agents/skills/practice-review-add/SKILL.md`, then collect a reflection and
confirm any save. Pattern, Atom and Log notes use the packaged Algorithm
templates. Respect requests to pause, stop, or continue an existing attempt.
