# Cooperative Studio operation

## Connections and target identity

The Roblox preset declares two scoped built-in MCP clients: official Roblox Studio via its platform-selected Windows batch launcher or macOS StudioMCP executable, and Chrrxs via `npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin`. Automatic reconnect is disabled; diagnose connection failures before deliberately reconnecting. Plugin updates may require a full Studio restart.

Discover the connected server and exact tool schemas before use. Official tools identify targets with `studio_id`; Chrrxs uses `instance_id`. Resolve the intended target independently through each backend and confirm they refer to the intended experience/place. An identifier from one namespace is not evidence for the other.

## One operator, explicit handoff

Captain designates one Studio operator by message, naming the worker/session, intended target, scope and next checks. Choose a qualified tier for the task; bounded screenshots/logs may use a cheaper operator. All participants cooperate: only the designated operator issues Studio calls, including inspection, scene changes and playtest lifecycle. Others send requests and consume timestamped snapshots with target identity.

To transfer, the outgoing operator settles calls, reports current mode, target IDs, completed actions, source/sync baseline and pending or unknown outcomes, then acknowledges the handoff. Captain names the next operator and sends that evidence. Reconcile timed-out actions by readback before retrying or transferring: a local timeout does not prove the remote action stopped. This procedure uses ordinary native tools and messages, not custom control APIs or a runtime lock.

Routine implementation, inspection, sync and bounded testing within the user's requested development scope need no extra permission ceremony. Use normal approvals for destructive operations, publishing, uploads, purchases and external/production changes; confirm their exact action and destination. Ask for missing user-owned decisions or access, not for test procedures the project and skills can determine.

## Native Script Sync

Use the project's existing native Script Sync mapping rather than adding a competing source-sync workflow. Verify actual availability, script-to-disk mapping and baseline disk/Studio contents before edits. If sync is absent, inspect the project's supported workflow and identify the missing prerequisite rather than assuming disk files reach Studio. Source workers edit their assigned mapped paths; the operator observes synchronization and reads changed source back from the same target before calling it integrated.

Disk source alone does not establish instance class, path/parent, attributes, tags, references, properties or execution settings. Preserve metadata and inspect it when behavior depends on it. Verify resulting instance topology for additions, renames and deletes using the actual mapping's behavior.

On competing edits, ambiguous mapping or divergent versions, retain both versions and evidence and pause conflicting writes. Reconcile from a proven baseline; ask the owner only where choosing or discarding their changes requires a decision. Ordinary sync/setup mistakes with an unambiguous safe repair belong in the agent's self-correction loop.

## Runtime evidence

Derive focused source readback, metadata inspection and solo/multiclient playtests from the acceptance criteria and domain skills. Observe actual client/server state, errors and visual behavior. Record backend/target, changed paths, expected and observed outcomes and remaining gaps. Shell checks do not prove Studio behavior, and a successful tool return does not establish correct synchronization or gameplay.
