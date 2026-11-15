# Role-aware per-task routing

The live role matrix is owned by the Roblox routing panel and read with the `roblox_routes` tool: call it before selecting a route instead of copying model tables into prompts, and pick the role/tier whose purpose matches the assignment. [routes.json](../../../routes.json) supplies only the role/tier structure, the purposes and the `dispatchGuard` rules — it never supplies a dispatchable model. The matrix expresses planning policy, not a runtime router, availability guarantee, automatic switch, or fixed worker roster. Captain uses the current session model: the preset does not choose a captain model or alter the global default.

## Selection

Use the stable role taxonomy planner, scout, implementer, reviewer, qa, studio, and visual. For each assignment, classify ambiguity, blast radius, coupled systems, and required verification; choose fast, standard, or expert within that role. The same tier label is not a global model ranking: its route depends on the role. Instantiate only contributors needed now, not a fixed roster. Small file count alone does not imply low risk (security, data loss, networking authority, and migrations merit explicit risk analysis). Fast reviewer output is preliminary only and cannot satisfy final independent approval. Visual Terra and fast implementation MiMo Pro remain provisional within their documented bounds.

Call `roblox_routes` for the exact provider/model and supported effort before dispatch; use native model discovery only to check whether a route is currently available. Supply provider and model together and always set reasoning_effort; changing routes without an explicit effort can silently select a model default. For native spawn, put provider, model and reasoning_effort on the dispatch call, not just in role text: the dispatch guard rejects a call missing any of the three and one whose exact triple sits outside the role matrix, and its denial names the fix. Ride outside the matrix only through capacity fallback: add `capacityFallback: "<capacity reason>"` to that same call; the guard lets it through and logs the reason. Forked children inherit the captain model and cannot carry a tier route, so dispatch workers with the spawn tool. Send the actual bounded task immediately with normal DSH tools; cooperative ownership and messages coordinate workers. The provisional MiMo Pro option requires bounded scope and project-specific validation; it is not a general replacement for Sonnet.

Announce every dispatch with the worker name, role/tier cell, exact model and reasoning effort, and task. Put `Role: <role>/<tier>` in every assignment; in projects with a visual gate the runtime rejects a dispatch without it or whose route belongs to another cell.

## Visual role checklist

A visual/standard (or visual/expert for art direction) assignment must include:

- `Role: visual/standard` or `Role: visual/expert`.
- At least one screenshot to judge, captured after the latest change: capture ids from `roblox_screenshots` (e.g. `cap-1a2b3c4d5e`), which the reviewer views with `roblox_screenshots` action `view`, or image paths. Ask for phone, tablet and desktop via capture_device_matrix. QA and other workers receive capture ids the same way.
- `Verdict: PASS|FAIL` with a checklist: readability per device, hierarchy, palette/type consistency, no placeholder primitives in player view, lighting matches direction, nothing clipped or overlapping.
- The `docs/<scope>/VISUAL_GATE.md` the reviewer writes: verdict, `Reviewer: <its worker name> (visual/standard)`, at least 3 screenshot capture ids or names, the checklist, findings and the asset-sourcing record. Only the visual worker writes this file.
- For asset work, the sourcing rule: 6+ varied search_assets queries per piece, thumbnail and details per candidate, reject only after seeing it in the scene (scripts, triangles and pivots are fixable), never insert during a playtest.

The coordinator then views the screenshots itself and runs `node tools/check-visual-gate.mjs`; a non-zero exit means the report opens with "visual gate FAILED".

## Session route authorization

The session's allowed routes are recorded once, before its first model request, and every worker inherits that record. Without one, explicit selection narrows to the lead's own route and workers inherit the lead model. A revised allowlist reaches only fresh top-level sessions: when `list_subagent_models` shows a single route, or a listed route fails as not allowed for this Session, the session carries a stale or missing authorization. Restart the work in a new top-level session instead of expecting a live one to widen.

## Escalation versus capacity fallback

An escalation records: current route and effort; bounded attempt; failing check or documented complexity/risk; missing capability; next role/tier, route and effort; an explicit handoff preserving owned paths, work, evidence, and next check. Escalate promptly when evidence warrants it, not after arbitrary repeated attempts or merely because a preferred label sounds stronger. High-risk tasks may begin at a higher tier with their justification recorded at planning.

Quota, provider outage, unavailable route, or latency pressure is capacity evidence, not proof of inadequate reasoning. Record it separately, discover a route with equivalent capability, and explicitly dispatch/reassign with effort. Never claim the runtime switches models automatically. If no permitted route meets the task, surface the blocker or ask for a choice instead of silently lowering the quality bar.

Final independent review uses a separate worker, a different provider from the implementer, and evidence from the current implementation. If the matrix's review route shares the implementation provider — the panel warns when it does — set a review cell to another provider or surface the choice before dispatch. Preliminary fast review never substitutes for this approval. Independence does not replace checks or authorize approving one's own work.
