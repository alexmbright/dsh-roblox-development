# Current upstream and domain guidance

## Use the bundled pin

The installed bundle includes all 29 roblox-brain skills at commit `ceee4aaa5004502e2a51d78b3c33bba44d84742b`. Its `vendor/roblox-brain/provenance.json` records the source and license. The filesystem skill provider reads those installed roots directly; loading skills makes no home-directory checkout and requires no network.

Record that SHA in assignments and verification evidence. Captain and workers load the same installed snapshot. Treat it as pinned guidance, not a claim to be the latest upstream. Changes to the pin belong in a separately tested bundle update; ordinary game work does not run setup, update-brain.mjs, Git fetch, or package installation for skills.

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
