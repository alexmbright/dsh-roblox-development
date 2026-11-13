# Outcome-driven Roblox development

Use the stages relevant to the requested outcome. Captain chooses and runs the build/test strategy with workers; the user supplies the desired game behavior, not an execution checklist.

## 1. Ground the outcome

Read the current goal; create a persisted goal for a long objective and resume a disarmed goal only on the user's request. Todos track execution, not completion proof. Refresh roblox-brain once at the bounded task's start using [skill-selection.md](skill-selection.md), record the SHA and keep workers on that revision until the next task boundary.

Inspect repository instructions, architecture, scripts, tests, source mappings and the intended experience/place. Separate observed state from hypotheses. Derive observable acceptance criteria from the request and existing game. Ask only for unresolved user-owned choices, access or genuine ambiguity. Discovery is complete when target, scope, constraints and expected behavior are explicit.

## 2. Design and staff

Load relevant domain skills before substantive work. For gameplay, define the player loop, state transitions, failure/loading/empty states and devices. For technical design, identify server authority, client presentation, remote contracts, persistence, ownership, cleanup and compatibility. Use the actual plan-mode approval mechanism when plan mode applies; otherwise make proportionate design decisions within scope without a new permission ceremony.

Captain assigns substantive implementation to native workers; coupled systems can be one assignment. Give each worker the outcome, owned paths, brain SHA, required skills, dependencies and evidence expectations using [teams.md](teams.md). Select discovered role/tier routes using [routing.md](routing.md). Add independent research, test design and review where useful, not to fill a roster. Design is ready when contracts and checks are concrete enough to implement and review.

## 3. Build a verified slice

Preserve project conventions. Start with a vertical slice when integration risk is high, then expand through tested contracts. Apply the selected domain guidance: server-side validation and bounded remotes, lifecycle cleanup and error paths, responsive/input-aware UI, and resilient data handling where relevant.

Workers use normal DSH shell and editing tools to implement and validate. Captain coordinates shared resources and integration; the designated Studio operator follows [studio.md](studio.md) for sync, metadata, scene changes and live checks. Verify the observed result of asset/scene work, not merely insertion success.

## 4. Derive and execute checks

Discover the project's real scripts and tools. Run applicable build, syntax/type/static and unit checks, then integration/runtime checks. Define expected outcomes before execution. If tooling is absent, inspect supported alternatives and report the remaining gap rather than inventing a command or claiming a check ran.

Choose checks proactively from risk and changed behavior:

- **Gameplay:** exercise the full round/state loop, reset, failure and repeat use; include join/leave/rejoin when relevant.
- **Networking/security:** verify server authority, replication, multiclient consistency, malformed/adversarial remote inputs and disconnect races.
- **UI/input:** inspect actual layout and navigation on relevant screen sizes and touch/controller inputs, loading/error/empty states, duplication and cleanup.
- **Data/performance:** test failure/retry/concurrency/migration paths and measure relevant runtime or memory behavior against a baseline.
- **Studio integration:** confirm source readback, instance topology/metadata and actual client/server behavior on the intended target.

Use focused checks first, then the broader end-to-end loop needed to establish the outcome. Record each criterion as pass, fail or untested with evidence. A shell check is not gameplay proof; a tool timeout is an unknown outcome to inspect before retrying mutation.

## 5. Self-correct and review

For a failure, capture a bounded reproducer and baseline errors, isolate a hypothesis, repair the root cause and rerun the original scenario plus regression checks. Use domain skills and profiling tools as needed; remove temporary instrumentation. Routine implementation, build, type, networking and UI mistakes stay in this loop without asking the user how to fix or test them. Escalate route only for documented complexity/capability need or a failed bounded repair; distinguish capacity failures from reasoning failures.

Have an independent reviewer inspect the current diff/behavior against acceptance criteria and relevant skill guidance. Prefer cross-provider review for consequential work under the route policy. Repair findings and recheck changed behavior. Captain integrates only when required checks have evidence or explicitly reports why a criterion remains unverified.

## 6. Release and report

For release scope, load matching publish-checklist/cloud/analytics/monetization/localization skills. Establish target, rollback/backup, configuration and monitoring; obtain normal exact authorization for destructive or external release actions. Development/testing scope is not blanket authorization to publish or change production data.

Report changed paths, brain revision and loaded skills, chosen routes, criteria/results, Studio identities and remaining risks. Preserve decisions and interfaces that must survive the session. Mark the persisted goal complete only after its outcome is achieved; otherwise retain unfinished work and concrete blockers under goal policy. Preserve saved legacy team records unchanged; native work is independent of them.
