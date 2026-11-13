# Role-aware per-task routing

The single machine-readable role matrix is [routes.json](../../../routes.json). It expresses planning policy, not a runtime router, availability guarantee, automatic switch, or fixed worker roster. Read it before selecting routes rather than copying model tables into prompts. Captain uses the current session model: the preset does not choose a captain model or alter the global default.

## Selection

Use the stable role taxonomy planner, scout, implementer, reviewer, qa, studio, and visual. For each assignment, classify ambiguity, blast radius, coupled systems, and required verification; choose fast, standard, or expert within that role. The same tier label is not a global model ranking: its route depends on the role. Instantiate only contributors needed now, not a fixed roster. Small file count alone does not imply low risk (security, data loss, networking authority, and migrations merit explicit risk analysis). Fast reviewer output is preliminary only and cannot satisfy final independent approval. Visual Terra and fast implementation MiMo Pro remain provisional within their documented bounds.

Call native model discovery for the exact provider/model and supported effort before dispatch. Supply provider and model together and always set reasoning_effort; changing routes without an explicit effort can silently select a model default. For native spawn, put provider, model and reasoning_effort on the dispatch call, not just in role text. Send the actual bounded task immediately with normal DSH tools; cooperative ownership and messages coordinate workers. The provisional MiMo Pro option requires bounded scope and project-specific validation; it is not a general replacement for Sonnet.

## Escalation versus capacity fallback

An escalation records: current route and effort; bounded attempt; failing check or documented complexity/risk; missing capability; next role/tier, route and effort; an explicit handoff preserving owned paths, work, evidence, and next check. Escalate promptly when evidence warrants it, not after arbitrary repeated attempts or merely because a preferred label sounds stronger. High-risk tasks may begin at a higher tier with their justification recorded at planning.

Quota, provider outage, unavailable route, or latency pressure is capacity evidence, not proof of inadequate reasoning. Record it separately, discover a route with equivalent capability, and explicitly dispatch/reassign with effort. Never claim the runtime switches models automatically. If no permitted route meets the task, surface the blocker or ask for a choice instead of silently lowering the quality bar.

Final independent review uses a separate worker, a different provider from the implementer, and evidence from the current implementation. If the matrix's normal review route shares the implementation provider, discover an allowed cross-provider route or surface the choice before dispatch. Preliminary fast review never substitutes for this approval. Independence does not replace checks or authorize approving one's own work.
