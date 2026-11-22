---
name: roblox-tiered-workflow
description: Plan, implement, debug, review, or operate Roblox Studio with native workers, per-task model tiers, and coordinated Studio handoffs.
---
# Tiered Roblox workflow

The user describes the game outcome. Captain stays the coordinator: it defines success, staffs the work and checks the evidence; the user need not prescribe procedures.

1. **Ground.** Use the bundled, pinned roblox-brain revision from [skill-selection.md](references/skill-selection.md); no network or updater. Identify the project, the intended outcome and observable acceptance criteria. Use create_goal for long objectives and todos for current execution.
2. **Select.** Load the relevant domain skills before implementation, debugging or review. Read [lifecycle.md](references/lifecycle.md) for stages and [routing.md](references/routing.md) for role/tier routes and explicit effort.
3. **Delegate once.** A routine task gets ONE implementer who builds and verifies it, with success criteria from captain (see [teams.md](references/teams.md)). Add workers only when work can run in parallel or needs a specialist. Separate QA is optional. Report what is running and end the turn; completion wakes captain.
4. **One focused check.** Inspect a content or UI change once in Studio. For gameplay, exercise the behavior that changed. Other tools stay on demand: Lune for logic regressions, two clients for shared multiplayer behavior, the device matrix when responsive layout is at risk. Plugin changes also run the plugin's `npm test`. Tooling or access failures: [workspace-tooling.md](references/workspace-tooling.md). Sync, scene changes and playtests: [studio.md](references/studio.md), one operator at a time.
5. **Review by risk.** Independent review (a different worker, any provider) is required for saves and migrations, purchase grants, multiplayer authority and releases, and optional otherwise. Only a concrete bug, a missed acceptance criterion or a specific risk in the changed behavior blocks. After a fix, rerun the failed check; if the blocker survives two repair attempts, report it.
6. **Visual gate.** Off by default (Settings, new sessions): no formal visual reviewer, screenshot checklist or reapproval after edits; Studio screenshots and playtests stay available. On restores the full gate for polish or release work. The "Visual gate" prompt section states the current value.
7. **Close with evidence.** Report changed paths, loaded skills and brain SHA, checks and outcomes, Studio target, remaining risks and untested criteria. Complete a goal only when its outcome is verified.

Native collaboration is instruction-based: cooperative ownership and explicit handoffs. Routine work proceeds under normal DSH permissions; destructive or external release actions keep their normal approvals.
