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

### Enforcement

The Roblox preset enforces this contract with deny-only tool guards; each denial names the fix.

- **Lead grounding.** `subagent`, `edit`, `write` and `apply_patch` are refused until the lead has loaded `roblox-tiered-workflow` and at least one roblox-brain domain skill in this session. Reading, searching, answering and ordinary messages are never gated.
- **Assignment.** Every `subagent` prompt, including one a worker sends to its own helper, needs these lines (Markdown bullets and emphasis are fine):

  ```
  Brain revision: <pinned SHA or a 7+ character prefix>
  Required skills: <exact names, comma/and/bracket list or "- name" bullets>
  Report: loaded skills, applied checks, evidence and unresolved findings.
  ```

  The sender must have loaded every skill it requires. `Required skills: none — <reason>` is allowed for read-only work and is logged; that worker cannot edit files.
- **Contract changes.** A `send_message` that contains `Required skills:` is a contract change and is held to the same rules. The worker adds those skills to its requirements, and a read-only worker can be promoted this way. Only the worker's own parent can change its contract; a message up to one's parent is a report and is not checked.
- **Worker.** A worker cannot edit files until every skill its active contract requires is loaded in its own session.
- **Pinned copies only.** A skill counts only when the `skill` result shows it was served from this bundle's pinned directory. A project or user skill with the same name shadows the pin and does not count; the denial names it.
- **Acceptance.** `roblox_skill_audit` reads every descendant worker's log, including finished ones, and lists required, loaded, shadowed and missing skills. `update_goal` with `complete` is refused while any worker has no valid pinned contract, is missing a required skill, or has evidence that cannot be read (including an unreadable catalog entry or a final log that failed to load). After a restart, call `roblox_skill_audit` first.

Evidence comes only from session logs, never from what a worker says it loaded.

If skill discovery fails, repair access or supply the full authoritative text and needed references from the recorded revision, noting that delivery. For older unguided code, load the relevant skills and perform a new review rather than claiming retroactive compliance.
