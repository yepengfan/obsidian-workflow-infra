# Practice across available domains

These MCP entry rules override the module menu and new-problem handoff in
`.agents/skills/practice/SKILL.md`. Apply the shared English conversation and
clarification rules in `Learning/Practice/Review/AGENTS.md`. Only Algorithm,
System Design and SD Blocks are supported; never offer Behavioral Interview or a
practice/review mode menu.

## Resolve availability and intent

- Honor an explicit domain, selected item, resume request or current attempt.
  Call `practice` with a known domain to load its guarded workflow. Do not replace
  explicit intent with a generic overview or infer a topic from unrelated history.
- For a generic request, use this result's `available_domains` and
  `unavailable_domains`. Explain confirmed disabled and unavailable modules
  separately. An unreadable guard or invalid mapping is not a disabled module.
  Do not auto-enter merely because another domain could not be checked.
- A `ready` result for a sole confirmed enabled domain enters it directly with
  a brief explanation. An `unavailable` result stops before queue reads or domain
  actions and explains the returned reasons. Do not change module settings.

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

## Build the combined due overview

- For each available domain, call `practice_reviews` once with that explicit
  `domain`. Each result is that domain's complete queue for its returned local
  date. If the domains' dates differ, query again instead of combining dates.
- Only `overdue` and `today` are due reviews. Group them by domain; each group
  is already ordered by `next_review`, then stable ID. Show exact counts, and
  initially show up to five neutral titles per domain with
  due dates. Show further titles on request. Report unstarted items separately;
  upcoming and unstarted items are not due. Never read prior solutions, attempt
  history, canvases or every private note to build the overview.
- If availability is partial or a queue read fails, clearly mark the overview
  partial and name the missing coverage. Do not claim complete order, that
  there are no due reviews, or that all domains have been checked. Offer retry
  or an explicit narrower-domain choice.
- When there is due work, ask which item or domain to start with and wait. Do
  not automatically begin the first or oldest item. A selected item identifies
  its persisted domain; verify its active state and resolve mismatches first.
  Call `practice` with that domain to load its instructions and live guard.
  Keep the generic-entry handoff policy below through that domain call.

## Complete the selected review scope

Follow the selected domain's entry and review instructions. Review the explicitly
selected item first, then the remaining due items in that domain in date/ID
order. Keep a summary of other domains' outstanding work visible; selecting one
domain does not complete the others. Honor an explicit switch, pause or stop.
Each item uses its own domain's coaching and time limit. Never mix Algorithm
assessment with System Design assessment.

Keep independent attempts neutral, preserve learner reflections verbatim, and
preview and confirm every proposed save. System Design step-transition autosave is enabled for the active round's canvas and progress note unless the learner opts out. This narrow exception covers both checkpoint writes. After saving, refresh the selected
queue. An unsaved or paused attempt must not be presented as recorded or
completed. A session may span multiple days: a saved progress/canvas checkpoint
is not completion or a failed attempt. Resume the selected WIP session;
only recording an actually ended round updates its schedule, using the local
completion date rather than checkpoint, start or later save dates.
Honor an explicit request to continue without saving, retaining the
unsaved draft and distinguishing it from the persisted queue. Re-fetch the
chosen queue before claiming its due work is complete. A failed queue read
does not authorize an automatic new-problem handoff.

Each domain's `time_limits` entry is a one-time continuation check-in; work past it may continue but fails `within_time_limit` where the module declares it. Follow the selected domain's timing and completion rules in its workflow.
An explicit pause preserves progress for resumption. Other domains follow their
own time budgets. At the end of the sitting, wait before starting another problem.

## Choose a domain for new practice

When the selected review scope is complete, or the complete overview has no due
items, ask which available domain to use for new practice and wait. Re-check
availability with `practice` without a domain at this handoff; use the returned
availability for this phase instead of restarting the initial overview. If only one domain
is conclusively enabled, enter it directly. If availability is partial, explain
that before an explicit choice; if none are available, stop.

Preserve an explicitly pending new-practice domain or topic instead of asking
again. A topic without a clear domain needs clarification. An explicit request
to resume an existing attempt takes precedence. Do not choose the last reviewed
domain or reuse its topic by default.

After the choice, call `practice` with that domain. If it differs from the review
scope, check and complete its due reviews before its new problem. Retain the
now-explicit new-practice domain so completing those reviews does not ask the
same domain question again. Use the mapped workflow's topic-input step if no
new topic was supplied. Keep the existing assessment, reflection, registration
and explicitly confirmed save rules.

Show each topic with its stage and next_review date. Every review is an independent attempt judged against the domain's `pass_criteria`.
