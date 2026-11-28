# Roblox development for DSH

A DeepSeek Harness preset bundle for Roblox work: a lead agent coordinates tiered workers and one Studio operator, with pinned offline skills, an editable model-routing matrix, and pinned command-line tools that run without shell approvals.

Package: `@alexturbo/dsh-roblox-development` · Preset ID: `roblox` · Licence: MIT · Not affiliated with Roblox or its dependency authors.

## What you get

- **A coordinator and one implementer for routine work.** The lead defines success; one implementer builds and verifies a routine task, with one focused Studio check. More workers join only for parallel work or a specialist.
- **Tiered delegation.** Seven roles (planner, scout, implementer, reviewer, qa, studio, visual) across three tiers (fast, standard, expert). Every worker dispatch must name an explicit provider, model and reasoning effort drawn from the routing matrix.
- **A persisted Visual gate toggle, Off by default.** The **Roblox** page in the sidebar has a Visual gate switch that turns the formal visual review on for polish or release work.
- **An editable routing matrix.** The **Roblox** page lists each role with its tiers nested underneath; each tier picks its own model, can be switched off, and carries a purpose the lead reads before assigning work.
- **Pinned tools that need no approval.** `lune`, `stylua`, `selene`, `luau`, `luau-analyze`, `luau-compile` and `luau-lsp` are provisioned once and invoked through `roblox_run_tool` in the host process — no shell, no sandbox escalation, no version drift.
- **29 pinned Roblox skills.** Vendored from [roblox-brain](https://github.com/TabooHarmony/roblox-brain) at `ceee4aaa`, read offline from the installed bundle. Sessions never fetch upstream.
- **Studio via MCP.** The official Studio MCP server and the pinned Chrrxs bridge, with a small adapter that keeps Chrrxs structured results visible.
- **The full Open Cloud API as direct tools.** `roblox_cloud` calls any of the ~420 Open Cloud endpoints that accept an API key, with the key saved on the Roblox page; `roblox_cloud_find` looks up paths, scopes and body shapes offline. No MCP, Lune script or environment variable involved. See [Open Cloud tools](#open-cloud-tools).

## Requirements

- DeepSeek Harness Desktop 0.2.2-rc.5 or newer, below 0.3.0 (tested on 0.2.2-rc.5 and 0.2.3-alpha.2). The browser panels require the authenticated DSH browser connection.
- Roblox Studio installed and signed in, with **Studio as MCP server** enabled in Assistant → Manage MCP Servers.
- Your model-provider accounts signed into DSH. No subscriptions are bundled.
- Network access once, for first-run toolchain provisioning.

System Node, npm, npx, Rokit, Lune, StyLua and Selene are **not** prerequisites: the bundle uses DSH's packaged runtime and provisions its own pinned tools.

## Platforms

Five native targets, with coverage limited only where upstream publishes no asset:

| Target | Tools provisioned |
|---|---|
| `win32-x64` | all five |
| `darwin-arm64` | all five |
| `linux-x64` | all five |
| `linux-arm64` | Lune, StyLua, luau-lsp |
| `darwin-x64` | Lune, StyLua, luau-lsp |

Selene 0.32.0 and Luau 0.745 publish no ARM64 Linux build and no Intel macOS build, so those two targets provision three tools; the workspace runtime reports the missing ones as blocked rather than failing silently. **Windows ARM64 is unsupported** — StyLua, Selene and Luau ship x64-only Windows assets. Every download is a fixed GitHub release URL with a SHA-256 in `toolchain/lock.json`; nothing uses a floating tag.

## Install

**Fully quit DSH Desktop**, then in Terminal:

```sh
# install from the GitHub repository
dsh plugin --profile desktop add "github:alexmbright/dsh-roblox-development"

# or install the version currently published to npm
dsh plugin --profile desktop add "@alexturbo/dsh-roblox-development"
```

Use your actual profile name if it is not `desktop`. Reopen DSH and start a **new Roblox development session**; the installation is profile-wide and existing sessions keep their previous preset revision.

Registry installs are the managed path: DSH lists newer versions and updates in place. Git installs are pinned to an immutable commit and update only through the plugin index:

```text
https://raw.githubusercontent.com/alexmbright/dsh-roblox-development/main/plugin-index.json
```

Add that source in DSH's custom plugin indexes UI (enable the optional custom plugin indexes bundle if needed), then install or update from the index.

> **Linked local checkouts do not work out of the box.** `dsh plugin add /absolute/path` installs the link only, not the package's own dependencies, so the `robloxstudio` MCP row fails to mount and the preset reports "Failed to load". Run `npm install` inside the checkout first, or install from the registry.

## Configuration

Every setting lives on one page: click **Roblox** in the left sidebar (below Plugins and Automation tasks). It has three sections, in order: **Roblox visual gate**, **Roblox Open Cloud** and **Roblox routing**. Nothing is added to the Settings menu. Routing is described below, the Visual gate under [Visual gate toggle](#visual-gate-toggle) and the credentials under [Open Cloud API key](#open-cloud-api-key).

- **First install seeds the matrix with your main model.** Every cell is set to your DSH default (main) model, or the first connected model if none is set, and stored. Until then workers inherit the lead's model. The bundle ships no models of its own, and later releases never overwrite your choices.
- **The panel is the only source of dispatch models.** `routes.json` supplies the role/tier structure, the purposes and the `dispatchGuard` rules — never a dispatchable model. Nothing is auto-substituted: a cell with no stored choice contributes no route rather than inheriting one.
- **Each tier has its own reasoning effort picker**, listing the efforts the chosen model declares. An effort change applies as soon as it is saved; a saved effort the model no longer supports is shown as such and rejected on save.
- **Routing changes apply on Save.** The routing matrix is used for the next dispatch; it does not change workers already running. Adding a model to the profile allowlist also requires a successful live profile reload, and new sessions pick up that allowlist. If live reload fails, the panel tells you to restart DSH.
- **Off-matrix dispatch is refused** unless the caller records a `capacityFallback` reason, which is logged. Fork dispatch is always refused: a forked child inherits the lead model and cannot carry a tier.
- **Independent review needs a different worker, not a different provider.** The panel no longer flags a reviewer that shares the implementer's provider.

### Visual gate toggle

The **Visual gate** section at the top of the **Roblox** page holds one persisted switch, **Off** by default. It is saved per profile in `roblox-settings.json` in the profile directory (beside `roblox-routing.json`) and survives restarts.

- **Off** skips the formal visual reviewer, the screenshot checklist and reapproval after edits. Studio screenshots, playtests and the visual role stay available on demand.
- **On** restores the existing gate for polish or release work (see [Visual quality gate](#visual-quality-gate)).
- **Existing values.** An explicit `on` or `off` is kept. Legacy `auto` and an unset setting both mean Off. Existing `VISUAL_GATE.md` files are never edited or deleted, and a file alone no longer switches the gate on.
- **One setting, two readers.** The same value reaches the `roblox-routing-guard` row (`visualGate`) and the "Visual gate" section of the lead's instructions, so the runtime and the lead always agree.
- **When it applies.** The value is read when the profile is composed. A save recomposes the profile at once, so it applies to **new sessions**; a session that is already running keeps the setting it started with, so start a new Roblox development session after changing it. If DSH cannot reload the profile live, the panel says so: restart DSH, then start a new session.

## Tools

| Tool | Purpose |
|---|---|
| `roblox_routes` | Current role/tier routes with provider, model, effort, purpose and source (`auto`/`override`). Call before delegating. |
| `roblox_run_tool` | Run a pinned tool (`tool`, `args`, optional `cwd`) and return exit code, stdout, stderr. Working directory and path arguments are fenced to the session workspace. |
| `roblox_skill_audit` | Per worker: pinned revision given, required roblox-brain skills, skills its session log shows loaded, and any missing. Call before accepting worker output. |
| `roblox_setup_status` | Provisioned toolchain status and executable paths, without installing anything. |

## Studio setup

The official client uses Windows `%LOCALAPPDATA%/Roblox/mcp.bat` through `cmd.exe`, or macOS `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`. For nonstandard installations set `DSH_ROBLOX_STUDIO_MCP` in DSH's launch environment.

The Chrrxs bridge launches the pinned `@chrrxs/robloxstudio-mcp` dependency through DSH's packaged runtime with `--auto-install-plugin`, and may install or update its Studio plugin — review that trust choice before selecting the mode, and restart Studio when required. System Node/npm/npx is not used for either bridge.

Enable native Script Sync for the project. Official `studio_id` and Chrrxs `instance_id` are distinct namespaces: resolve each independently, and one operator coordinates both through messages. The runtime refuses a call that passes an id listed by the other server, or the other server's argument name.

Both servers stay connected because each has features the other lacks:

| Task | Preferred server |
|---|---|
| Viewport evidence for review | official `screen_capture` |
| Phone/tablet/desktop sweeps | chrrxs `capture_device_matrix` |
| Asset search, thumbnails, details, preview, insert | chrrxs |
| Playtests, runtime eval, profiling, simulated input | chrrxs |
| Studio list, script read/multi-edit, console output, start/stop play | official |
| `execute_luau` | either: name the server and pass its own id |
| Open Cloud REST (data/memory stores, messaging, Luau execution, asset upload, place publish, settings, monetization, bans, secrets) | `roblox_cloud`, no MCP (see [Open Cloud tools](#open-cloud-tools)) |
| Insert asset, generation (needs the open place) | chrrxs first; official as fallback; then `roblox_cloud` for the upload half. A failure is reported only after every route fails |
| Any web/cloud task no Studio tool covers | `roblox_cloud_find`, then `roblox_cloud` |

A capture of 256×256 or smaller, or one reporting `studioFastPathUnavailable`, is marked **suspicious**: probably not the real viewport, so it does not count for the visual gate.

### Structured results

Chrrxs can return `content: []` with the data in `structuredContent`, which DSH would otherwise render as *"returned no model-visible content"*. The bundle mounts a small adapter inside Roblox sessions that exposes that existing structured data as JSON text for successful Chrrxs calls only. It never re-calls Studio, and it changes no canonical results, failures, images, other servers or downstream policy decisions. This is installed bundle code, so replacing the DSH application does not overwrite it.

A visible empty instance list is a valid result, not proof of a connection — follow its diagnostics, and resolve current instance IDs rather than reusing IDs from an earlier session.

### Multiple clients and cleanup

The upstream bridge uses one primary on its default port; additional servers enter proxy mode. Another application's primary is not an error by itself: inspect upstream status or stderr without exposing credentials, and do not kill other applications or reinstall the Studio plugin as an automatic repair.

- **Never print or include the contents of `~/.robloxstudio-mcp/auth-token`** in logs or reports. This bundle's adapter does not read that file.
- **Do not set a private `ROBLOX_STUDIO_PORT`** as a workaround: upstream auto-install can rewrite the installed Studio plugin for that port. Port changes and plugin modifications need explicit user approval.
- MCP process cleanup is delegated to the SDK, which closes stdin and signals the direct child; that does not guarantee termination of an entire launcher process tree on Windows or macOS. Report confirmed leftovers with redacted evidence rather than killing processes on your own.

## Workspace and permissions

Routine work belongs in **workspace-write**; the preset rejects automatic `danger-full-access` shell retries instead of looping on approval prompts. This makes unsupported operations fail loudly rather than silently escalating — it does not turn them into successes. Agents change source with the `edit` and `write` tools rather than shell scripts, keep scratch files in the gitignored `.dsh/roblox/tmp/`, and read bundle files with `read`.

The scoped shell redirects home, config, cache and temp state into `<workspace>/.dsh/roblox`: npm and Python caches, tool temp, and the Lua toolchain's writable state. Add `.dsh/roblox/` to the game's local ignore rules rather than committing caches.

Selene's Roblox standard is seeded from the bundle beside the nearest `selene.toml` before a shell command runs, so linting works on a fresh machine without network access or a writable user cache. Existing standards are never overwritten. Existing project Rokit/Aftman pins are respected when their exact versions are installed; a mismatch fails explicitly rather than silently switching versions.

## Workflow

Describe the game outcome; the captain stays the coordinator. For a routine task it defines success and assigns one implementer to build and verify it; coupled work stays with that one worker. It adds workers only when work can run in parallel or needs a specialist, and a separate QA worker is optional.

**One focused check by default.** A content or UI change is inspected once in Studio. A gameplay change exercises the behavior that changed. The other tools stay available on demand: Lune for logic regressions, two clients for shared multiplayer behavior, and the device matrix when responsive layout is at risk. Changes to this plugin also run its own `npm test` suite.

**Independent review is reserved for consequential work:** saves and migrations, purchase grants, multiplayer authority and releases. The reviewer is a different worker from the implementer; the provider may be the same. Only a concrete bug, a missed acceptance criterion or a specific risk in the changed behavior blocks. After a fix the failed check runs again, and a blocker that survives two repair attempts is reported instead of looped on.

Workers implement, derive checks, repair failures and report evidence. The lead loads [the workflow skill](skills/roblox-tiered-workflow/SKILL.md) before planning, implementation or review; workers load the domain skills for their scope.

Skill use is enforced, not advisory. Worker dispatch and file edits are refused until the lead has loaded the workflow skill and the relevant roblox-brain domain skills. Every worker prompt must state `Brain revision: <pinned SHA>`, `Required skills: <names>` and require a report of loaded skills and applied checks. Workers, including nested helpers, cannot edit until they have loaded their required skills, and only skills served from the pinned bundle count. A goal cannot be completed while any worker is missing one. Questions and lookups are never gated. See [skill-selection.md](skills/roblox-tiered-workflow/references/skill-selection.md#enforcement).

The coordinator announces each dispatch and each finished worker with its model and reasoning effort, and ends every reply with a `Waiting on:` line followed by one list item per running worker. A live worker-status context, which changes only when a worker starts or finishes, keeps that line accurate. A reply that announces a dispatch without the model and effort is sent back once for correction.

### Shared screenshots

Studio captures are shared by id instead of saved as files. Every `screen_capture`, `capture_screenshot` or `capture_device_matrix` image taken by the lead or any worker is already stored by DSH in that session's log; `roblox_screenshots` gives each one a stable id such as `cap-1a2b3c4d5e`, and any agent in the same worker tree (lead, implementer, reviewer, QA) can `list` them, `view` them by id, or `export` chosen ones into the project (`screenshots/` by default) when a file is really needed. Ids travel in prompts, `send_message`, reports and `VISUAL_GATE.md`.

The lead keeps you looking along with it: when workers have captured something new, it shows the previews that matter in its reply with a one-line caption. If it ends a turn without doing so, it is reminded once and may answer "no new screenshots worth showing". Set `screenshotPreviews: 'off'` on the `roblox-routing-guard` row to stop the reminder.

**Roblox screenshots tab.** Open it from the right sidebar's guide page. It shows every capture from the Session's lead and all its workers, newest first, refreshing while visible: thumbnails, who took each, device label, time, size and the copyable `cap-` id. Click a thumbnail to enlarge it; filter by agent or hide suspicious captures. Images are served same-origin from DSH's own attachment store; nothing is written to the project.

**Text-only models.** DSH only stores a tool's image when the calling model accepts images. When a text-only worker captures, the bundle stores the image itself and gives the model the capture id as text, so the capture is still shared with reviewers, QA and the sidebar.

### Visual quality gate

Controlled by the **Visual gate** toggle (Off by default; see [Visual gate toggle](#visual-gate-toggle)). The runtime enforces it only when the setting is **On**; the `roblox-routing-guard` row's `visualGate` carries the value, and `auto` or unset reads as Off. Copy [the template](templates/VISUAL_GATE.md) to `docs/<scope>/VISUAL_GATE.md`, replacing `<scope>` with your feature or release name. When On, the runtime refuses:

- any worker dispatch without a `Role: <role>/<tier>` line, or whose route belongs to a different cell;
- a `visual/*` review without a capture id or image path, without `Verdict: PASS|FAIL` and a checklist, or without naming the gate file;
- writes to `VISUAL_GATE.md` by anyone except the visual worker;
- worker prompts that touch Creator Store assets without the sourcing rule, and `insert_asset`/`generate_model` during a playtest;
- `update_goal complete` on a visual objective (UI, art, scene, layout, looks…) unless the coordinator viewed a usable (not suspicious) screenshot taken after the last watched or asset change, a visual/standard or visual/expert review was dispatched after the last visual work, the gate passes with the coordinator's own visual worker as reviewer (who must itself have viewed a screenshot), and the asset-sourcing record matches the `search_assets`, `get_asset_thumbnail` and `get_asset_details` calls in the session logs.

**One rule source.** The bundled [tools/check-visual-gate.mjs](tools/check-visual-gate.mjs) holds every file rule; the runtime never runs a different project copy. `node tools/check-visual-gate.mjs --rules` prints the rule table, and `roblox_visual_gate` runs exactly what goal completion runs, listing each problem with its rule id (`VERDICT`, `STALE`, `LEAD_LOOKED`, …), the watched and ignored paths, and the time of the last watched change. The script exits 1 unless the gate has `Verdict: PASS`, a named visual reviewer, at least 3 screenshots, a checklist of at least 5 items all checked, a modified time newer than every watched file, and, for each art piece, 6+ queries, viewed candidates and real rejection reasons (scripts, triangles and pivots are fixable).

**What counts as a change.** The gate's `Client source:` line lists the watched folders (default `src/client`, `src/StarterGui`, `src/StarterPlayer`, `src/ReplicatedFirst`, `assets`). `Ignore:` lists globs that never count and replaces the defaults (`assets/backup/**`, `**/*.backup.rbxm`, `**/*.backup.rbxmx`, `**/backup/**`). Lock, temp and `.DS_Store` files never count.

**Reporting.** The lead sees a one-line gate status in its prompt. Actual visual-work/review dispatches, captures, asset insertions and gate edits make a visual reporting turn; arbitrary worker dispatches, server-code completions, routing questions and gate audits do not. Positive approval of the visual deliverable while the gate fails triggers a one-time correction; negative statements and unrelated completion reports do not.

**Evidence integrity.** A named reviewer must be dispatched after the last watched/asset change and before its verdict, and its session evidence must be available. It must open every capture id or image path listed in the gate; each must be usable, captured after the last change, and viewed before the verdict. Missing reviewer logs fail closed. Shared `roblox_screenshots view` records capture time separately from viewing time. `read_image` counts only images linked to known capture attachments; a filename containing “screenshot” is not proof, and rereading or renaming an old image does not make it fresh. Replay derives this from logged attachment provenance, without rechecking today’s filesystem. Capture freshness uses the capture call’s start time conservatively (not a delayed result); a genuinely new capture can have identical pixels and still establish a new occurrence. Tiny (both dimensions ≤256) and fallback captures remain unusable. Resume of the same session can restore durable evidence; a new lead session cannot inherit approval from the gate file alone.

**File validation.** Verdict values must be exactly `PASS` or `FAIL`. Explicit `Client source:` entries may be project-relative files or folders; missing paths, wildcards, absolute paths and escapes fail instead of silently disabling freshness checks. Omit the line to use defaults (absent default folders are allowed). Asset sourcing must contain actual Piece records, or a substantive `Not applicable: UI-only …` explanation when no art is being added/replaced. Cross-owner authorization dates must be real calendar dates, and a final asset id must match a kept candidate.

**Conservative change tracking.** Generated assets and manifests remain watched because they can affect the game. Ignore only known non-runtime artifacts; `Ignore:` replaces the backup defaults, so repeat those patterns if needed. Freshness is still based on filesystem timestamps, not a content snapshot: pure deletions and deliberately preserved/backdated mtimes are not fully detected. Neither the checker nor a screenshot log proves subjective quality or substitutes for the independent reviewer’s actual judgment.

With the gate Off none of this runs: `roblox_visual_gate` reports that the gate does not apply, no gate status line is added, and the lead is told in its instructions that the gate is Off.

Routes are advisory planning policy, not a runtime router, availability guarantee or fixed roster: discover what is available before dispatch and adapt explicitly when a route is unavailable. Quota or outage is capacity evidence, never proof of inadequate reasoning.

## Verification limits

The automated suite covers packaging, routing state, tool execution, platform pins and install/updater behaviour against local fixtures. It does **not** establish live Studio connectivity, connected game behaviour, or spawn behaviour on macOS. Windows local installation has been exercised; macOS path handling is covered synthetically and needs a live smoke test. Never publish a game as an installation test.

## Development

```sh
git clone https://github.com/alexmbright/dsh-roblox-development.git
cd dsh-roblox-development
npm test
```

No build or install lifecycle scripts are needed. Local development installation goes through plugin_manager with the absolute directory (see the linked-checkout caveat above). `npm run setup` remains an optional maintainer utility; sessions never invoke it, and it does not change the installed skill pin.

The committed patch resolves installed resources at runtime and contains no generated home paths. Keep caches, environment files, credentials, logs, game projects and session records out of Git and release attachments. GitHub Releases and the plugin index are available independently of npm; the install command without a Git source uses the version currently published to npm.

## Open Cloud API key

The [Open Cloud tools](#open-cloud-tools) (`roblox_cloud`) and the `robloxstudio` MCP server's cloud tools (asset upload and generation, monetization, experience and place-version tools) use a Roblox Open Cloud API key. Open the **Roblox** page in the sidebar, go to **Open Cloud**, paste the key from Creator Hub (create.roblox.com → Credentials) and press Save. Optionally add a creator user ID or group ID, which asset uploads use as the owner.

- Save writes to DSH's credential store, not the preset or routing configuration. The panel requires an authenticated local DSH browser session. It displays whether a value is set and where it comes from, without returning the key or a masked preview.
- `roblox_cloud` reads the saved key from the credential store on each call inside the DSH host process; it is never placed in an environment variable or returned to the model.
- DSH supplies `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_CREATOR_USER_ID` and `ROBLOX_CREATOR_GROUP_ID` to the community `robloxstudio` MCP launcher, not the official `Roblox_Studio` server. The launcher removes these variables before the verified MCP starts, so its Studio and media helpers don't inherit them. Studio-only tools remain available without a key. This does not isolate secrets from software running under your OS account.
- Save or Clear refreshes the active community MCP connection without reloading the profile. In-flight calls may be interrupted. Clear removes the saved copy; it doesn't remove a launch environment or `.env` fallback, or revoke the key in Roblox.
- To verify the key without any IDs, ask the agent to call `roblox_cloud GET /toolbox-service/v2/assets:search` with `{searchCategoryType: "Model", query: "tree", maxPageSize: 3}`. A 200 needs `creator-store-product:read`; a 403 naming that scope still proves the key reached Roblox and was accepted, and 401 means the key is invalid. For experience data, list developer products or data stores for a published experience with a key scoped to it. Save alone does not verify authorization or write access.
- Give keys only the scopes they need, and never paste them into chat, commits, or release notes.

## Open Cloud tools

Two preset tools call Open Cloud over plain HTTPS from the DSH host process with the key saved above. No MCP server, Lune script, shell or environment variable is involved, so the sandbox never gets in the way.

- **`roblox_cloud_find`** searches an offline index of every Open Cloud operation that accepts an API key (about 420, built from Roblox's official [OpenAPI document](https://github.com/Roblox/creator-docs/blob/main/content/en-us/reference/cloud/openapi.json)). Keywords list matching operations with their scopes; `"METHOD /path"` or `detail: true` adds parameters and the request-body shape. Endpoint knowledge costs tokens only when the agent asks for it.
- **`roblox_cloud`** calls one endpoint: `path` with `{placeholders}` filled from `params` (other params become the query), and a body as `body` (JSON object), `bodyText`, `form` + `files` (multipart; asset create/update, game passes, developer products, badges) or `file` (raw upload, such as a `.rbxl` place publish). `wait` polls asset operations and Luau execution tasks and returns the task logs; `pages` follows page tokens; `pick` trims the response (`"dataStores[].id,nextPageToken"`); `save` writes the response, or the file behind an asset-delivery `location`, into the workspace.
- A bare path is sent to the Roblox host the index lists for it (for example `/v1/locales/...` goes to `locale.roblox.com`); pass a full `https://` URL to choose the host yourself.
- Asset creation fills `creationContext.creator` from the saved creator group or user ID when the request leaves it out.
- The key is resolved per call and never returned; response text is scrubbed of it. Requests go only to the Roblox hosts in the index, keyed requests never follow redirects, and files are read and written only inside the session workspace. Errors return Roblox's message plus a hint naming the scope the operation needs.
- Writes run without a prompt by default, like the MCP route; the lead still asks you before publishing, saving, uploading or other production changes. Set `approve: writes` on the `roblox-open-cloud-api` row to require a DSH approval for every non-GET call.
- Refresh the index after Roblox adds endpoints: `node scripts/build-open-cloud-index.mjs` (or pass a downloaded `openapi.json`).

## Releases

Notes for every version are on [GitHub Releases](https://github.com/alexmbright/dsh-roblox-development/releases).

- **1.7.2** — Native DSH 0.2.3-alpha.2 support, still compatible with 0.2.2-rc.5. DSH 0.2.3 removed `sessionQuery.inspectSession`, which broke reading settled or restarted workers: the screenshots tool and sidebar tab lost their captures, the sidebar could not resolve a worker Session to its lead, and `roblox_skill_audit` reported "session log unavailable" for finished workers. Stored Sessions are now read through `observeSession` (header and events, no projections, lease released after each read), with `inspectSession` kept as the fallback on 0.2.2-rc.5.
- **1.7.1** — `@chrrxs/robloxstudio-mcp` 3.6.0 (was 3.5.0). Playtests answer only once every runtime peer is ready and list their `targets`; slow playtest and `wait_until` calls return `state: "pending"` with a `requestId` to collect through `get_request_status`; `eval_server_runtime` and `eval_client_runtime` accept a `wait_until` Luau condition; `capture_screenshot` takes up to 16 frames in one call, optionally as a numbered contact sheet; screenshots and video also work on Linux under Wine; multiplayer test windows are tracked by process, so `end` closes any that are still running and `manage_instance close` closes the edit Studio's test windows too. The credential-containment bootstrap was re-verified against 3.6.0: all twelve source anchors still match, and `entryHash` is the digest of the new `dist/index.js`. Tests pass on Windows.
- **1.7.0** — Full Open Cloud API as direct tools. `roblox_cloud` calls any Open Cloud endpoint over HTTPS with the key from the Roblox page, and `roblox_cloud_find` searches an offline index of all ~420 key-capable operations from Roblox's official OpenAPI document. Agents no longer hunt for the key in environment variables or script calls through Lune. Covers data and memory stores, messaging, Luau execution (with polling and logs), asset upload and versions, place publish, universe and place settings, game passes, developer products, badges, secrets, user restrictions, groups and more. Bare paths for endpoints on other Roblox hosts (locale, itemconfiguration, thumbnails, localization) are routed automatically. The Studio MCP routes remain for work that needs the open place, such as inserting assets. The lead and workers are told to search `roblox_cloud_find` whenever no Studio tool covers a web/cloud task, and to use `roblox_cloud` as the last route for uploads when both MCPs fail. Adds about 600 tokens of tool schemas and prompt.
- **1.6.3** — Cloud work tries both Studio MCP routes. Asset upload and generation, Creator Store insert, monetization, experience settings and place versions go to `robloxstudio` with the Open Cloud key first (no per-project Studio permission), then fall back to the official `Roblox_Studio` tools. The lead reports a failure only after both routes fail and quotes both errors. The fallback never bypasses a refusal, and uploads, publishes and saves still need user authorization. Adds about 100 tokens to the lead prompt and tool description.
- **1.6.0** — Faster routine work. The lead defines success and assigns one implementer who builds and verifies a routine task with one focused Studio check; other tools stay on demand. Independent review is required only for saves and migrations, purchase grants, multiplayer authority and releases, needs a different worker but not a different provider, and blocks only on concrete bugs, missed acceptance criteria or specific risks. All Roblox settings now live on one **Roblox** page, opened from the new **Roblox** entry in the left sidebar (Visual gate, Roblox Open Cloud and Roblox routing); the three separate Settings sections are gone. New persisted **Visual gate** toggle on that page, default Off: Off skips the formal visual reviewer, screenshot checklist and reapproval after edits; On restores the existing gate. Legacy `auto` and unset read as Off, explicit `on`/`off` are kept, and `VISUAL_GATE.md` files are untouched. A running session keeps the setting it started with: change the toggle, then start a new Roblox development session (restart DSH if the live reload fails).
- **1.5.11** — New icon: a tilted blue block with white code brackets. It is drawn for DSH's 36×36 icon size with a transparent background, so it sits correctly in Plugin Manager's tile in light and dark themes.
- **1.5.10** — Easier status to read. The lead ends each reply with a `Waiting on:` line and then one list item per running worker (name, model, effort, task), instead of one long paragraph. With no running worker it writes `Waiting on: nothing`.
- **1.5.9** — More concurrent work. The lead runs every independent ready task at the same time and queues a task only when it edits the same script or needs the same playtest. Studio takes turns only for playtests, scene changes and script writes; other workers may read Studio outside a playtest and do their offline work (read source, draft edits, compile, write test steps) before their Studio turn. When at most one worker runs and a reply queues work behind Studio, the runtime sends the reply back once.
- **1.5.8** — Lower token use. The community Studio MCP loads 14 core tools; the lead loads the rest on demand with `roblox_studio_tools` (about 14,000 fewer tokens per request; set `toolSearch: false` in the `mcp-robloxstudio` config to load all tools). The persona is shorter and asks for ASD-STE100 Simplified Technical English in operator messages. The visual-gate line appears only while the gate fails, in plain words. Fixes the route briefing, which never reached the lead's prompt. The visual-gate template moved to `templates/VISUAL_GATE.md`.
- **1.5.7** — The bundle no longer ships default worker models. A fresh install seeds every role/tier cell with your main model; `routes.json` carries only roles, tiers, purposes and dispatch rules, and nothing outside your panel choices is dispatchable.
- **1.5.6** — Fix "requires the local DSH browser owner" in the Roblox routing, Open Cloud and screenshots panels on DSH Desktop, whose window forwards requests without an Origin header.
- **1.5.5** — Require DSH 0.2.2-rc.5 and an authenticated browser for bundle panels. Restore preset startup without an Open Cloud key. Settings accepts credentials without exposing even a partial key, refreshes the community Studio MCP on Save or Clear, and keeps credentials out of its helpers' inherited environment.
- **1.5.3** — `@chrrxs/robloxstudio-mcp` 3.5.0 (`capture_video` viewport recording with storyboard, WSL capture fixes); tests pass on Windows.
- **1.5.2** — the visual gate accepts a successful Open Cloud Assets API read (`GET /assets/v1/assets/<id>`) as the details lookup for own private uploads, which the Creator Store details call 404s on.
- **1.5.1** — stricter capture provenance, freshness and reviewer evidence; delayed-result and identical-pixel recapture fixes; runtime-aware visual reporting without unrelated audit/routing reminders; exact verdict, watched-path and asset-sourcing validation.
- **1.5.0** — Roblox screenshots sidebar tab; captures by text-only models stored and shared; suspicious-capture flag; Studio id namespace guard and backend table; one gate rule source with rule ids, `roblox_visual_gate`, `Ignore:` paths and default backup ignores; gate reporting only on visual turns.
- **1.4.1** — `roblox_screenshots`: captures shared by id across the worker tree (list, view, selective export) with no files written; the lead shows new worker screenshots as previews; visual reviews accept capture ids.
- **1.4.0** — opt-in visual quality gate (screenshot-before-accept, visual reviewer requirement, `tools/check-visual-gate.mjs`, asset-sourcing effort floor, report honesty); dispatches announced with model and effort.
- **1.3.1** — per-tier reasoning effort picker in the routing panel.
- **1.3.0** — roblox-brain skill use enforced (lead grounding, assignment contract, worker gate, `roblox_skill_audit`, verified goal completion); live worker status and coordinator announcements.
- **1.2.1** — `@chrrxs/robloxstudio-mcp` 3.4.4.
- **1.2.0** — routing matrix panel, `roblox_run_tool` / `roblox_routes`, native Selene standard seeding, five platform pins, npm publication under `@alexturbo`.
- **1.1.1** — macOS toolchain provisioning fix (OS layout symlinks such as `/var`).
- **1.1.0** — self-provisioning pinned toolchain; repo-brain skills.
- **1.0.5** — package renamed to `@alexturbo/dsh-roblox-development`; one-time migration, not an in-place update.
- **1.0.4** — DSH rc3 compatibility metadata.
- **1.0.3** — Chrrxs structured-result compatibility adapter.
- **1.0.2** — DSH rc2 compatibility and native worker guidance.
