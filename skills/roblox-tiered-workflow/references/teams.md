# Native subagent collaboration

Captain coordinates substantive development rather than implementing by default. Delegate even a sequential feature to one implementer; tightly coupled files and contracts belong in that single assignment. Captain owns requirements, staffing, handoffs, integration decisions, goal tracking and verification coverage. Questions, small inspections, trivial edits and short integration repairs can stay local. If workers are unavailable, state the fallback and continue within normal permissions rather than inventing a bootstrap dependency.

## Dispatch real tasks

1. Check existing native children before duplicating work. Select a discovered role/tier route and explicit effort using [routing.md](routing.md).
2. Start a worker with the actual bounded assignment immediately: outcome, owned paths or read-only inputs, prerequisites, brain SHA, required skills and expected evidence. Native workers use normal DSH shell, editing and other available tools under the session's ordinary permissions. There is no read-only readiness stage or custom permission-assignment step.
3. Let implementers run their own builds and tests. Captain ensures all acceptance criteria have coverage, arranges integration checks and returns shared evidence to the implementer when another worker or the Studio operator must obtain it. A missing capability calls for a concrete handoff, not a user-run checklist.
4. For Studio work, designate one operator through messages using [studio.md](studio.md). Other workers use snapshots or send bounded requests to that operator. This is cooperative coordination, not a custom lock or control-tool dependency.
5. Reuse workers with `send_message` for related follow-ups. Preserve source ownership, evidence and the next check on reassignment; use `interrupt_agent` for work that truly needs stopping. An independent worker reviews consequential implementation. Escalation is an explicit route/handoff, not an assumed mid-task model switch.

## Useful concurrency

Begin with one implementer and a second worker when independent research, test design or review is ready. Split by independent contracts and paths, not a target headcount. Review completed slices while unrelated implementation continues. Increase toward three or four only when provider capacity, rework and verification throughput justify it; different models on one account need not have independent quota.

Receive completion notifications rather than busy-polling. When only waiting remains, end the turn and let completion wake captain; a persisted goal carries the unfinished objective forward.

## Evidence and legacy records

Task output includes changed paths, actual checks/results and unresolved risks. Keep useful worker context and source/sync baselines across handoffs. Previous reports may inform discovery with their provenance and verification limits. Preserve saved legacy team state unchanged: native work has no AgentTeams commands, task-board or state-file dependency. The filename `teams.md` remains for pointer compatibility.
