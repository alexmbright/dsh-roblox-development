---
name: roblox-tiered-workflow
description: Plan, implement, debug, review, or operate Roblox Studio with native workers, per-task model tiers, and coordinated Studio handoffs.
---
# Tiered Roblox workflow

The user describes the game outcome. Captain coordinates implementation and derives design, builds and tests from the project and relevant skills; the user need not prescribe procedures.

1. **Refresh and ground.** At the beginning of substantive project work, follow [skill-selection.md](references/skill-selection.md) to refresh roblox-brain and record the session revision. Identify the project, intended outcome and observable acceptance criteria. Use create_goal for long objectives and todos for current execution; read an existing goal before resuming it.
2. **Design and select.** Load the relevant domain skills before implementation, debugging or review. Read [lifecycle.md](references/lifecycle.md) for design, continuous verification and release stages. Derive concrete checks from game behavior, project scripts and skill guidance. Read [routing.md](references/routing.md) to select available role/tier routes and explicit effort.
3. **Delegate real work.** Captain is the coordinator by default. Use [teams.md](references/teams.md) to send substantive implementation directly to native workers with normal DSH tools, including shell and editing. Assign coupled changes to one implementer. Captain owns requirements, staffing, handoffs, integration and verification coverage.
4. **Implement and verify.** Run the relevant build/type/static, behavior, networking and UI checks proactively; exercise the full gameplay loop when scope requires it. For sync, scene changes or playtests, read [studio.md](references/studio.md) and designate one operator by messages. Repair routine mistakes and rerun failed checks without asking the user to manage the repair loop.
5. **Close with evidence.** Report changed paths, loaded skills and brain SHA, executed checks and outcomes, Studio target/readback, remaining risks and untested criteria. Complete the goal only when its outcome is verified; otherwise preserve the unfinished work and concrete blocker.

Native collaboration is instruction-based: cooperative ownership and explicit handoffs, not a custom policy bootstrap or lock. Routine implementation and testing within the requested scope proceed under normal DSH permissions; destructive or external release actions retain their normal approval requirements.
