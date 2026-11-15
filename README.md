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
- **Changing a model to one outside the current allowlist takes effect for new sessions after DSH restarts**, because session model authorization is read at profile load.
- **Off-matrix dispatch is refused** unless the caller records a `capacityFallback` reason, which is logged. Fork dispatch is always refused: a forked child inherits the lead model and cannot carry a tier.
- **Reviewer independence is flagged.** The panel warns when reviewer cells share the implementer's provider, because final review must not come from the same provider.

## Tools

| Tool | Purpose |
|---|---|
| `roblox_routes` | Current role/tier routes with provider, model, effort, purpose and source (`auto`/`override`). Call before delegating. |
| `roblox_run_tool` | Run a pinned tool (`tool`, `args`, optional `cwd`) and return exit code, stdout, stderr. Working directory and path arguments are fenced to the session workspace. |
| `roblox_setup_status` | Provisioned toolchain status and executable paths, without installing anything. |

## Studio setup

The official client uses Windows `%LOCALAPPDATA%/Roblox/mcp.bat` through `cmd.exe`, or macOS `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`. For nonstandard installations set `DSH_ROBLOX_STUDIO_MCP` in DSH's launch environment.

The Chrrxs bridge launches the pinned `@chrrxs/robloxstudio-mcp` dependency through DSH's packaged runtime with `--auto-install-plugin`, and may install or update its Studio plugin — review that trust choice before selecting the mode, and restart Studio when required. System Node/npm/npx is not used for either bridge.

Enable native Script Sync for the project. Official `studio_id` and Chrrxs `instance_id` are distinct namespaces: resolve each independently, and one operator coordinates both through messages.

### Structured results

Chrrxs can return `content: []` with the data in `structuredContent`, which DSH would otherwise render as *"returned no model-visible content"*. The bundle mounts a small adapter inside Roblox sessions that exposes that existing structured data as JSON text for successful Chrrxs calls only. It never re-calls Studio, and it changes no canonical results, failures, images, other servers or downstream policy decisions. This is installed bundle code, so replacing the DSH application does not overwrite it.

A visible empty instance list is a valid result, not proof of a connection — follow its diagnostics, and resolve current instance IDs rather than reusing IDs from an earlier session.

### Multiple clients and cleanup

The upstream bridge uses one primary on its default port; additional servers enter proxy mode. Another application's primary is not an error by itself: inspect upstream status or stderr without exposing credentials, and do not kill other applications or reinstall the Studio plugin as an automatic repair.

- **Never print or include the contents of `~/.robloxstudio-mcp/auth-token`** in logs or reports. This bundle's adapter does not read that file.
- **Do not set a private `ROBLOX_STUDIO_PORT`** as a workaround: upstream auto-install can rewrite the installed Studio plugin for that port. Port changes and plugin modifications need explicit user approval.
- MCP process cleanup is delegated to the SDK, which closes stdin and signals the direct child; that does not guarantee termination of an entire launcher process tree on Windows or macOS. Report confirmed leftovers with redacted evidence rather than killing processes on your own.

## Workspace and permissions

Routine work belongs in **workspace-write**; the preset rejects automatic `danger-full-access` shell retries instead of looping on approval prompts. This makes unsupported operations fail loudly rather than silently escalating — it does not turn them into successes.

The scoped shell redirects home, config, cache and temp state into `<workspace>/.dsh/roblox`: npm and Python caches, tool temp, and the Lua toolchain's writable state. Add `.dsh/roblox/` to the game's local ignore rules rather than committing caches.

Selene's Roblox standard is seeded from the bundle beside the nearest `selene.toml` before a shell command runs, so linting works on a fresh machine without network access or a writable user cache. Existing standards are never overwritten. Existing project Rokit/Aftman pins are respected when their exact versions are installed; a mismatch fails explicitly rather than silently switching versions.

## Workflow

Describe the game outcome; the captain coordinates and delegates. Workers implement, derive checks, repair failures and report evidence, and coupled work can stay with one worker. The lead loads [the workflow skill](skills/roblox-tiered-workflow/SKILL.md) before planning, implementation or review; workers load the domain skills for their scope.

Routes are advisory planning policy, not a runtime router, availability guarantee or fixed roster: discover what is available before dispatch and adapt explicitly when a route is unavailable. Quota or outage is capacity evidence, never proof of inadequate reasoning.

## Verification limits

The suite (193 tests) covers packaging, routing state, tool execution, platform pins and install/updater behaviour against local fixtures. It does **not** establish live Studio connectivity, connected game behaviour, or spawn behaviour on macOS. Windows local installation has been exercised; macOS path handling is covered synthetically and needs a live smoke test. Never publish a game as an installation test.

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

- **1.2.1** — `@chrrxs/robloxstudio-mcp` 3.4.4.
- **1.2.0** — routing matrix panel, `roblox_run_tool` / `roblox_routes`, native Selene standard seeding, five platform pins, npm publication under `@alexturbo`.
- **1.1.1** — macOS toolchain provisioning fix (OS layout symlinks such as `/var`).
- **1.1.0** — self-provisioning pinned toolchain; repo-brain skills.
- **1.0.5** — package renamed to `@alexturbo/dsh-roblox-development`; one-time migration, not an in-place update.
- **1.0.4** — DSH rc3 compatibility metadata.
- **1.0.3** — Chrrxs structured-result compatibility adapter.
- **1.0.2** — DSH rc2 compatibility and native worker guidance.
