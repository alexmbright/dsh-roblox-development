# Cooperative Studio operation

## Connections and target identity

The Roblox preset declares two scoped built-in MCP clients: official Roblox Studio via its platform-selected Windows batch launcher or macOS StudioMCP executable, and Chrrxs via `npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin`. Automatic reconnect is disabled; diagnose connection failures before deliberately reconnecting. Plugin updates may require a full Studio restart.

Discover the connected server and exact tool schemas before use. Official tools identify targets with `studio_id`; Chrrxs uses `instance_id`. Resolve the intended target independently through each backend and confirm they refer to the intended experience/place. An identifier from one namespace is not evidence for the other; the runtime refuses an id listed by the other server.

| Task | Preferred server | Why |
|---|---|---|
| Viewport evidence for review | official `screen_capture` | The viewport as Studio renders it |
| Phone/tablet/desktop sweeps | chrrxs `capture_device_matrix` | Only chrrxs |
| Asset search, thumbnails, details, preview, insert | chrrxs | Only chrrxs has details and thumbnails |
| Playtests (solo, multiplayer, add players) | chrrxs | Wider lifecycle control |
| Runtime eval, profiling, simulated input | chrrxs | Only chrrxs |
| Studio list, script read/multi-edit, console output, start/stop play | official | Native tools |
| `execute_luau` | either | Name the server and pass its own id |

A capture of 256×256 or smaller, or one that reports `studioFastPathUnavailable`, is marked suspicious in `roblox_screenshots`: probably not the real viewport, so it is not valid evidence (and does not count for the visual gate when it is On). Capture again with the official `screen_capture`.

## One operator, explicit handoff

Captain designates one Studio operator by message, naming the worker/session, intended target, scope and next checks. Choose a qualified tier for the task; bounded screenshots/logs may use a cheaper operator. All participants cooperate: only the designated operator issues playtest lifecycle, scene changes and script writes. Outside a playtest, other workers may make read-only Studio calls (script source, properties, search) on the same target; during a playtest they send requests and consume timestamped snapshots with target identity.

Studio turns are short. A worker that needs Studio does everything else first: it reads source, drafts exact edits, compiles and lints them with `roblox_run_tool`, and writes its test steps. Its Studio turn then only applies, reads back and checks. Captain never parks a worker "waiting for Studio" while offline work remains.

To transfer, the outgoing operator settles calls, reports current mode, target IDs, completed actions, source/sync baseline and pending or unknown outcomes, then acknowledges the handoff. Captain names the next operator and sends that evidence. Reconcile timed-out actions by readback before retrying or transferring: a local timeout does not prove the remote action stopped. This procedure uses ordinary native tools and messages, not custom control APIs or a runtime lock.

Routine implementation, inspection, sync and bounded testing within the user's requested development scope need no extra permission ceremony. Use normal approvals for destructive operations, publishing, uploads, purchases and external/production changes; confirm their exact action and destination. Ask for missing user-owned decisions or access, not for test procedures the project and skills can determine.

## Native Script Sync (optional)

Script Sync is a suggestion, not a requirement. If the project already has a native Script Sync mapping, prefer it over adding a competing source-sync workflow: verify the script-to-disk mapping and baseline disk/Studio contents before edits. If sync is absent or the team works without it (for example a shared group place where Studio is the source of truth), do not stop: edit scripts in Studio through the Studio tools, read the source back from the same target, and follow the project's AGENTS.md/CLAUDE.md. Never assume disk files reach Studio. Source workers edit their assigned mapped paths; the operator observes synchronization and reads changed source back from the same target before calling it integrated.

Disk source alone does not establish instance class, path/parent, attributes, tags, references, properties or execution settings. Preserve metadata and inspect it when behavior depends on it. Verify resulting instance topology for additions, renames and deletes using the actual mapping's behavior.

On competing edits, ambiguous mapping or divergent versions, retain both versions and evidence and pause conflicting writes. Reconcile from a proven baseline; ask the owner only where choosing or discarding their changes requires a decision. Ordinary sync/setup mistakes with an unambiguous safe repair belong in the agent's self-correction loop.

## Runtime evidence

**Look first.** Before calling any UI, art, scene or layout result acceptable, capture it once (screen_capture, capture_screenshot or capture_device_matrix when responsive layout is at risk) and view the image yourself; an operator's description is not evidence. With the Visual gate Off that one inspection is the whole visual check; with it On the gate's reviewer and checklist apply as well. Captures are shared by id through `roblox_screenshots`: report the ids you captured instead of saving files, and export one to the project only when a file is required. Insert Creator Store assets in Edit mode only, never during a playtest; strip scripts, rescale and fix the pivot, then capture and judge the asset in the scene.

Derive focused source readback, metadata inspection and solo/multiclient playtests from the acceptance criteria and domain skills. Observe actual client/server state, errors and visual behavior. Record backend/target, changed paths, expected and observed outcomes and remaining gaps. Shell checks do not prove Studio behavior, and a successful tool return does not establish correct synchronization or gameplay.
