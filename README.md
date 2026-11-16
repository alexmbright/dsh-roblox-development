# Roblox development for DSH

A DeepSeek Harness preset bundle for Roblox work: a lead agent coordinates tiered workers and one Studio operator, with pinned offline skills, an editable model-routing matrix, and pinned command-line tools that run without shell approvals.

Package: `@alexturbo/dsh-roblox-development` · Preset ID: `roblox` · Licence: MIT · Not affiliated with Roblox or its dependency authors.

## What you get

- **Tiered delegation.** Seven roles (planner, scout, implementer, reviewer, qa, studio, visual) across three tiers (fast, standard, expert). Every worker dispatch must name an explicit provider, model and reasoning effort drawn from the routing matrix.
- **An editable routing matrix.** Settings → Roblox routing lists each role with its tiers nested underneath; each tier picks its own model, can be switched off, and carries a purpose the lead reads before assigning work.
- **Pinned tools that need no approval.** `lune`, `stylua`, `selene`, `luau`, `luau-analyze`, `luau-compile` and `luau-lsp` are provisioned once and invoked through `roblox_run_tool` in the host process — no shell, no sandbox escalation, no version drift.
- **29 pinned Roblox skills.** Vendored from [roblox-brain](https://github.com/TabooHarmony/roblox-brain) at `ceee4aaa`, read offline from the installed bundle. Sessions never fetch upstream.
- **Studio via MCP.** The official Studio MCP server and the pinned Chrrxs bridge, with a small adapter that keeps Chrrxs structured results visible.

## Requirements

- DeepSeek Harness Desktop 0.2.2-rc.2 or 0.2.2-rc.3 (`engines.dsh`: `>=0.2.2-rc.2 <0.3.0`).
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
# registry install — updates in place from the Installed tab
dsh plugin --profile desktop add "@alexturbo/dsh-roblox-development"

# or pin an exact Git commit through DSH's Git installer
dsh plugin --profile desktop add "github:alexmbright/dsh-roblox-development"
```

Use your actual profile name if it is not `desktop`. Reopen DSH and start a **new Roblox development session**; the installation is profile-wide and existing sessions keep their previous preset revision.

Registry installs are the managed path: DSH lists newer versions and updates in place. Git installs are pinned to an immutable commit and update only through the plugin index:

```text
https://raw.githubusercontent.com/alexmbright/dsh-roblox-development/main/plugin-index.json
```

Add that source in DSH's custom plugin indexes UI (enable the optional custom plugin indexes bundle if needed), then install or update from the index.

> **Linked local checkouts do not work out of the box.** `dsh plugin add /absolute/path` installs the link only, not the package's own dependencies, so the `robloxstudio` MCP row fails to mount and the preset reports "Failed to load". Run `npm install` inside the checkout first, or install from the registry.

## Configuration

Routing lives in **Settings → Roblox routing**.

- **First install seeds the matrix.** Every cell is set from your DSH default model, or the first connected model if none is set, and stored. Later releases never overwrite those choices.
- **The panel is the only source of dispatch models.** `routes.json` supplies the role/tier structure, the purposes and the `dispatchGuard` rules — never a dispatchable model. Nothing is auto-substituted: a cell with no stored choice contributes no route rather than inheriting one.
- **Each tier has its own reasoning effort picker**, listing the efforts the chosen model declares. An effort change applies as soon as it is saved; a saved effort the model no longer supports is shown as such and rejected on save.
- **Changing a model to one outside the current allowlist takes effect for new sessions after DSH restarts**, because session model authorization is read at profile load.
- **Off-matrix dispatch is refused** unless the caller records a `capacityFallback` reason, which is logged. Fork dispatch is always refused: a forked child inherits the lead model and cannot carry a tier.
- **Reviewer independence is flagged.** The panel warns when reviewer cells share the implementer's provider, because final review must not come from the same provider.

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

Describe the game outcome; the captain coordinates and delegates. Workers implement, derive checks, repair failures and report evidence, and coupled work can stay with one worker. The lead loads [the workflow skill](skills/roblox-tiered-workflow/SKILL.md) before planning, implementation or review; workers load the domain skills for their scope.

Skill use is enforced, not advisory. Worker dispatch and file edits are refused until the lead has loaded the workflow skill and the relevant roblox-brain domain skills. Every worker prompt must state `Brain revision: <pinned SHA>`, `Required skills: <names>` and require a report of loaded skills and applied checks. Workers, including nested helpers, cannot edit until they have loaded their required skills, and only skills served from the pinned bundle count. A goal cannot be completed while any worker is missing one. Questions and lookups are never gated. See [skill-selection.md](skills/roblox-tiered-workflow/references/skill-selection.md#enforcement).

The coordinator announces each dispatch and each finished worker with its model and reasoning effort, and ends every reply with a `Waiting on:` line. A live worker-status context, which changes only when a worker starts or finishes, keeps that line accurate. A reply that announces a dispatch without the model and effort is sent back once for correction.

### Shared screenshots

Studio captures are shared by id instead of saved as files. Every `screen_capture`, `capture_screenshot` or `capture_device_matrix` image taken by the lead or any worker is already stored by DSH in that session's log; `roblox_screenshots` gives each one a stable id such as `cap-1a2b3c4d5e`, and any agent in the same worker tree (lead, implementer, reviewer, QA) can `list` them, `view` them by id, or `export` chosen ones into the project (`screenshots/` by default) when a file is really needed. Ids travel in prompts, `send_message`, reports and `VISUAL_GATE.md`.

The lead keeps you looking along with it: when workers have captured something new, it shows the previews that matter in its reply with a one-line caption. If it ends a turn without doing so, it is reminded once and may answer "no new screenshots worth showing". Set `screenshotPreviews: 'off'` on the `roblox-routing-guard` row to stop the reminder.

**Roblox screenshots tab.** Open it from the right sidebar's guide page. It shows every capture from the Session's lead and all its workers, newest first, refreshing while visible: thumbnails, who took each, device label, time, size and the copyable `cap-` id. Click a thumbnail to enlarge it; filter by agent or hide suspicious captures. Images are served same-origin from DSH's own attachment store; nothing is written to the project.

**Text-only models.** DSH only stores a tool's image when the calling model accepts images. When a text-only worker captures, the bundle stores the image itself and gives the model the capture id as text, so the capture is still shared with reviewers, QA and the sidebar.

### Visual quality gate

Opt-in per project: active when the workspace has `docs/<scope>/VISUAL_GATE.md` (copy [the template](docs/smaller-launch/VISUAL_GATE.md)), or when the `roblox-routing-guard` config sets `visualGate: on` (`off` disables it). When active, the runtime refuses:

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

The committed patch resolves installed resources at runtime and contains no generated home paths. Keep caches, environment files, credentials, logs, game projects and session records out of Git and release attachments; automated checks are defence in depth, not a guarantee. The package is published publicly to npm (`private` unset, `publishConfig.access: public`).

## Releases

Notes for every version are on [GitHub Releases](https://github.com/alexmbright/dsh-roblox-development/releases).

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
