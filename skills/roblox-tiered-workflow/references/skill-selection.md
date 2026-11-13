# Current upstream and domain guidance

## Refresh once per bounded task

At the beginning of substantive project work, captain resolves the installed plugin root from this reference file (three directories above its containing directory), then runs `node "<plugin-root>/scripts/update-brain.mjs"` using that absolute path. The updater creates or refreshes `~/.cache/dsh-roblox-development/roblox-brain`, outside the installed package; it does not depend on the game's working directory. On first use, run it before selecting domain skills. The filesystem provider discovers the new roots automatically; verify the expected skills appear before dispatching workers.

The updater follows the upstream default branch with a clean, fast-forward-only update. Preserve local edits: a dirty or diverged checkout needs reconciliation, not a reset or forced checkout. On failure, inspect the cause and report the actual revision/freshness; never claim an offline or failed fetch is current upstream. Ask the owner only when resolving local changes requires their decision.

Record the resulting checkout SHA in session/task evidence. All workers use that same revision: include it in assignments and have workers load skills from that checkout. Captain owns refreshes; workers do not run concurrent pulls. During an active implementation or goal slice, keep the revision stable. Refresh at the next bounded task boundary and reassess relevant guidance then, rather than churning mid-implementation.

## Select before work

All 29 roblox-brain skills are available across core, gameplay, design and tools. Select from the actual scope and load the relevant skills through the skill tool before implementation, debugging or independent review. Read their linked references only when needed; availability is not loading, and loading every skill/reference is not the workflow.

| Scope | Starting skills |
|---|---|
| Luau source changes | roblox-luau-core, roblox-luau-patterns; roblox-luau-types for type/interface work |
| Module boundaries, service contracts, lifecycle | roblox-architecture, roblox-luau-patterns |
| Client/server communication, replication, remotes, multiplayer | roblox-networking, roblox-security |
| Persistence, player profiles, transactions | roblox-data, roblox-server-data, roblox-security |
| GUI, phone layout, screens, lifecycle cleanup | roblox-gui; roblox-input for touch/controller/input |
| Runtime cost, leaks, profiling, large scenes | roblox-performance plus affected domain skills |
| Script Sync, local tooling | roblox-tooling |
| Either Studio MCP, playtests, live inspection | roblox-studio-mcp, roblox-tooling |
| Other gameplay/design/cloud scope | Matching catalog skill: animation-vfx, audio, building, camera, lighting, localization, npc-ai, physics, game-design, analytics, growth-design, monetization, player-psychology, cloud, publish-checklist |

Use live skill descriptions to extend this starting map when domains overlap. Derive actionable design constraints and checks, not just a list of skill names.

## Assignments and review

Captain includes `Brain revision: <SHA>` and `Required skills: <names>` with each implementation/review task. Worker loads the authoritative instructions before work and reports loaded names, applied checks, evidence and unresolved findings. Reviewer evaluates the actual changed behavior against that guidance; a reported skill list alone is not correctness evidence.

If skill discovery fails, repair access or supply the full authoritative text and needed references from the recorded revision, noting that delivery. For older unguided code, load the relevant skills and perform a new review rather than claiming retroactive compliance.
