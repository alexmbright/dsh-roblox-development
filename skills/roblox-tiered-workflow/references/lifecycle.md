# Outcome-driven Roblox development

Use the stages relevant to the requested outcome. Captain defines success and stays the coordinator; one implementer builds and verifies a routine task; the user supplies the desired game behavior, not an execution checklist.

## 1. Ground the outcome

Read the current goal; create a persisted goal for a long objective and resume a disarmed goal only on the user's request. Todos track execution, not completion proof. Record the bundled roblox-brain pin from [skill-selection.md](skill-selection.md). Captain and workers use that installed snapshot; updating the bundle is a separate maintenance task, not a session-start requirement.

Inspect repository instructions, architecture, scripts, tests, source mappings and the intended experience/place. Separate observed state from hypotheses. Derive observable acceptance criteria from the request and existing game. Ask only for unresolved user-owned choices, access or genuine ambiguity. Discovery is complete when target, scope, constraints and expected behavior are explicit.

## 2. Design and staff

Load relevant domain skills before substantive work. For gameplay, define the player loop, state transitions, failure/loading/empty states and devices. For technical design, identify server authority, client presentation, remote contracts, persistence, ownership, cleanup and compatibility. Use the actual plan-mode approval mechanism when plan mode applies; otherwise make proportionate design decisions within scope without a new permission ceremony.

Captain assigns substantive implementation to native workers; a routine task gets ONE implementer, and coupled systems stay in one assignment. Give each worker the outcome, success criteria, owned paths, brain SHA, required skills, dependencies and evidence expectations using [teams.md](teams.md). Select discovered role/tier routes using [routing.md](routing.md). Add workers only when work can run in parallel or needs a specialist (research, a Studio operator, independent review of consequential work); separate QA is optional. Design is ready when contracts and checks are concrete enough to implement and review.

## 3. Build a verified slice

Preserve project conventions. Start with a vertical slice when integration risk is high, then expand through tested contracts. Apply the selected domain guidance: server-side validation and bounded remotes, lifecycle cleanup and error paths, responsive/input-aware UI, and resilient data handling where relevant.

Workers use normal DSH shell and editing tools to implement and validate. Captain coordinates shared resources and integration; the designated Studio operator follows [studio.md](studio.md) for sync, metadata, scene changes and live checks. Verify the observed result of asset/scene work, not merely insertion success.

## 4. Derive and execute checks

Discover the project's real scripts and tools. Run applicable build, syntax/type/static and unit checks, then integration/runtime checks. Define expected outcomes before execution. If tooling is absent, inspect supported alternatives and report the remaining gap rather than inventing a command or claiming a check ran.

**Default to one focused check.** A content or UI change is inspected once in Studio (one screenshot of the changed view). A gameplay change exercises the behavior that changed. Plugin changes also run the plugin's own `npm test`. Everything below stays available on demand; add a check when the risk calls for it, not by default:

- **Gameplay:** exercise the changed behavior; widen to the full round/state loop, reset, failure and repeat use, and join/leave/rejoin, only when the change touches them. Use Lune for logic regressions.
- **Networking/security:** verify server authority, replication, malformed/adversarial remote inputs and disconnect races; use two clients for shared multiplayer behavior.
- **UI/input:** one Studio inspection of the changed view; use the device matrix and touch/controller inputs when responsive layout is at risk; check loading/error/empty states when the change touches them.
- **Data/performance:** test failure/retry/concurrency/migration paths and measure relevant runtime or memory behavior against a baseline.
- **Studio integration:** confirm source readback, instance topology/metadata and actual client/server behavior on the intended target.

Start with the focused check and widen only when it fails or the risk demands it. Record each criterion as pass, fail or untested with evidence. A shell check is not gameplay proof; a tool timeout is an unknown outcome to inspect before retrying mutation.

## 5. Self-correct and review

For a failure, capture a bounded reproducer and baseline errors, isolate a hypothesis, repair the root cause and rerun the original scenario plus regression checks. Use domain skills and profiling tools as needed; remove temporary instrumentation. Routine implementation, build, type, networking and UI mistakes stay in this loop without asking the user how to fix or test them. Escalate route only for documented complexity/capability need or a failed bounded repair; distinguish capacity failures from reasoning failures.

Independent review is reserved for consequential work: saves and migrations, purchase grants, multiplayer authority and releases. A different worker from the implementer inspects the current diff and behavior against the acceptance criteria and the relevant skill guidance; the provider may be the same. Only a concrete bug, a missed acceptance criterion or a specific risk in the changed behavior blocks; preferences and unrelated findings do not. After a fix, rerun the failed check. If the blocker survives two repair attempts, stop and report it with the evidence. Routine work needs no separate review. The Visual gate setting (Off by default) is separate: Off skips the formal visual reviewer, the screenshot checklist and reapproval after edits, and On restores them for polish or release work. Captain integrates only when required checks have evidence or explicitly reports why a criterion remains unverified.

## 6. Release and report

Release scope is consequential: it needs independent review. Load matching publish-checklist/cloud/analytics/monetization/localization skills. Establish target, rollback/backup, configuration and monitoring; obtain normal exact authorization for destructive or external release actions. Development/testing scope is not blanket authorization to publish or change production data.

Report changed paths, brain revision and loaded skills, chosen routes, criteria/results, Studio identities and remaining risks. Preserve decisions and interfaces that must survive the session. Mark the persisted goal complete only after its outcome is achieved; otherwise retain unfinished work and concrete blockers under goal policy. Preserve saved legacy team records unchanged; native work is independent of them.
