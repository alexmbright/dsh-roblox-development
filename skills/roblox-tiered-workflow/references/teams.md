# Native subagent collaboration

Captain coordinates rather than implementing by default. For a routine task it defines success (observable acceptance criteria) and assigns ONE implementer to build and verify it; tightly coupled files and contracts belong in that single assignment. Captain owns requirements, staffing, handoffs, integration decisions, goal tracking and verification coverage. Questions, small inspections, trivial edits and short integration repairs can stay local. If workers are unavailable, state the fallback and continue within normal permissions rather than inventing a bootstrap dependency.

## Dispatch real tasks

1. Check existing native children before duplicating work. Select a discovered role/tier route and explicit effort using [routing.md](routing.md), then dispatch the exact provider/model/reasoning_effort triple on the spawn call; the dispatch guard admits nothing less.
2. Start a worker with the actual bounded assignment immediately: outcome, success criteria, owned paths or read-only inputs, prerequisites, brain SHA, required skills and expected evidence. Native workers use normal DSH shell, editing and other available tools under the session's ordinary permissions. There is no read-only readiness stage or custom permission-assignment step.
3. Let the implementer run its own build and the one focused check (a Studio inspection for content or UI, the changed behavior for gameplay). Captain ensures every acceptance criterion has coverage and returns shared evidence to the implementer when another worker or the Studio operator must obtain it. A missing capability calls for a concrete handoff, not a user-run checklist.
4. For Studio work, designate one operator through messages using [studio.md](studio.md). Other workers use snapshots or send bounded requests to that operator. This is cooperative coordination, not a custom lock or control-tool dependency.
5. Reuse workers with `send_message` for related follow-ups. Preserve source ownership, evidence and the next check on reassignment; send a stop request with `send_message` when work is no longer needed, and distinguish the request from confirmed termination.

## When to add workers

Add a worker only when the work can run in parallel with the implementer or needs a specialist: research, a Studio operator for a long playtest, or independent review. Separate QA is optional; use it when test design is a task of its own, not as a default stage. Independent review is required for consequential work only (saves and migrations, purchase grants, multiplayer authority, releases) and is a different worker from the implementer, on any provider. Its findings block only when they name a concrete bug, a missed acceptance criterion or a specific risk in the changed behavior. After a fix the implementer reruns the failed check; if the blocker survives two repair attempts, captain reports it with the evidence instead of looping. The Visual gate setting (Off by default) is separate: Off adds no formal visual reviewer, screenshot checklist or reapproval after edits, and On restores them for polish or release work (see [routing.md](routing.md)). Escalation is an explicit route/handoff, not an assumed mid-task model switch.

## Useful concurrency

Run every independent ready task at the same time. Queue a task behind another only when both edit the same script or need the same playtest, and name that conflict. If a provider rejects requests for capacity, move workers to other routes before you serialize them; judge concurrency by throughput and rework, not headcount. Split by independent contracts and paths. Review completed slices while unrelated implementation continues. Different models on one account need not have independent quota.

Receive completion notifications rather than busy-polling. When only waiting remains, end the turn and let completion wake captain; a persisted goal carries the unfinished objective forward. Never call wait_agent after a dispatch: it blocks the operator from adding or redirecting tasks, and the completion notice already resumes the captain.

## Evidence and legacy records

Task output includes changed paths, actual checks/results and unresolved risks. Keep useful worker context and source/sync baselines across handoffs. Previous reports may inform discovery with their provenance and verification limits. Preserve saved legacy team state unchanged: native work has no AgentTeams commands, task-board or state-file dependency. The filename `teams.md` remains for pointer compatibility.
