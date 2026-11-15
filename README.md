# Roblox development for DSH

DSH preset bundle `@alexturbo/dsh-roblox-development` with workspace-local routine tooling, pinned offline Roblox skills, an editable role/tier routing matrix, pinned-binary tool executors, and scoped MCP result compatibility. Captain coordinates workers and one Studio operator. No Studio locks, AgentTeams, or Rojo.

## Compatibility

Version 1.0.4 explicitly advertises compatibility with **DSH 0.2.2-rc.2 and 0.2.2-rc.3**. The existing engine range already permits rc3; it remains unchanged so rc2 users can update too. After upgrading Windows Desktop to rc3, the installed 1.0.3 bundle remained enabled, and a synthetic check against the actual packaged rc3 MCP adapter confirmed visible text and structured-only output with canonical data preserved. Version 1.0.4 changes metadata/documentation only, not the compatibility adapter. Live Studio connectivity, macOS runtime behavior, and whole-process-tree cleanup remain separate unverified checks.

Version **1.1.1** fixes toolchain provisioning on macOS. The cache-path safety walk treated the operating system's own directory links as unsafe ancestors, so provisioning was refused whenever the profile-owned root resolved beneath one: `/var` and `/tmp` are links into `/private` on macOS, so any temporary or `/var`-based cache path failed with `UNSAFE_CACHE_PATH` before the walk reached a single owned segment. Layout links are now followed and rebased onto their canonical target, while every segment at or below the owning root stays strictly symlink-free, so a link inside the cache path is still refused. The completion-receipt path check compares canonically for the same reason, and the provisioning fixture removes its symlink with `unlink` on POSIX and `rmdir` on Windows. The full suite passes on Node 22.20.0 and on DSH's packaged Node 24.21.0. Packaging and the engine range are unchanged by this fix.

Version **1.2.0** adds the routing matrix and pinned-binary executors.

- **Role/tier routing is editable.** Settings → Roblox routing lists every role with its tiers nested underneath; each tier picks its own model from the models this installation actually has connected, can be switched off, and carries a purpose the lead reads. A blank cell keeps the shipped `routes.json` route.
- **`roblox_run_tool` runs the pinned tools directly.** `lune`, `stylua`, `selene`, `luau`, `luau-analyze`, `luau-compile` and `luau-lsp` execute through the plugin in the host process, so they need no shell approval, cannot resolve a different version from `PATH`, and return the exit code with output. Shell commands still work; the shared `roblox-toolchain` directory is registered as a writable root for the session.
- **`roblox_routes` lets the lead look up routes** on demand, and the same list is injected into its prompt each step.
- **Selene's standard is seeded natively.** The bundled `vendor/selene/roblox.yml` is copied beside the nearest `selene.toml` before a command runs, so first-run linting no longer needs network access or a writable user cache.

## Platforms

Five native toolchain targets, with coverage limited only where upstream publishes no asset:

| Target | Tools provisioned |
|---|---|
| `win32-x64` | all five |
| `darwin-arm64` | all five |
| `linux-x64` | all five |
| `linux-arm64` | Lune, StyLua, luau-lsp |
| `darwin-x64` | Lune, StyLua, luau-lsp |

Selene 0.32.0 and Luau 0.745 ship no ARM64 Linux build and no Intel macOS build, so those two targets get three tools instead of five; the workspace runtime reports the missing ones as blocked rather than failing silently. **Windows ARM64 is unsupported** — StyLua, Selene and Luau publish x64-only Windows assets. Every pinned asset is a fixed GitHub release URL with a SHA-256 recorded in `toolchain/lock.json`; no download uses a floating tag.

## Install

Prerequisites: DeepSeek Harness Desktop 0.2.2-rc.3, Roblox Studio installed and signed in, and your model-provider accounts signed into DSH. A GitHub-spec installation uses Git through DSH's package installer. System Node/npm/npx, Rokit, Lune, StyLua and Selene are not runtime prerequisites: the bundle uses DSH's packaged runtime and automatically provisions its pinned command-line tools. Repository access does not transfer credentials.

Native toolchain targets: `win32-x64`, `darwin-arm64`, `linux-x64`, plus partial sets on `linux-arm64` and `darwin-x64` (see Platforms). Windows ARM64 fails with an explicit unsupported-platform message rather than installing the wrong architecture.

**Fully quit DSH Desktop**, then run in Terminal:

```sh
# registry install (updates in place from the Installed tab)
dsh plugin --profile desktop add "@alexturbo/dsh-roblox-development"

# or pin an exact Git commit through DSH's Git installer
dsh plugin --profile desktop add "github:alexmbright/dsh-roblox-development"
```

Registry installs are the managed path: DSH lists newer versions on the Installed tab and updates in place. Git installs are pinned to an immutable commit, so they update only through the plugin index below.

A **linked local checkout** (`dsh ... add /absolute/path`) installs the link only and does **not** install the package's own dependencies. The `robloxstudio` MCP row then fails to mount and the preset reports "Failed to load". Run `npm install` in the checkout first, or install from the registry.

Use your actual profile name if it is not `desktop`. Reopen DSH and start a **new Roblox development session**. No manual clone, setup, npm build approval, or machine-specific configuration generation is required. If `dsh` is not on your terminal PATH, use your DSH installation's CLI launcher.

Alternatively, from a running DSH session ask:

> Install github:alexmbright/dsh-roblox-development using plugin_manager. If @local/dsh-roblox-tiered is already installed, remove that bundle first, then install this GitHub package.

The installation is profile-wide. Existing sessions retain their previous preset revision; start a new session after updating.

### Updates inside DSH

Version 1.0.5 renames the package from `@local/dsh-roblox-tiered` to **`@alexturbo/dsh-roblox-development`**. The index URL and preset ID (`roblox`) stay the same. This is a one-time package-ID migration, not an in-place version update: remove the old bundle before installing the new entry, so both packages do not register the same preset. Restart DSH and use a new Roblox session afterward. On another machine (including macOS), repeat that migration there. Previous releases retain their old package identity; do not install both identities together.

Add this source yourself in DSH's custom plugin indexes UI (enable the optional custom plugin indexes bundle if needed):

```text
https://raw.githubusercontent.com/alexmbright/dsh-roblox-development/main/plugin-index.json
```

Install the Roblox bundle from that index. Each version uses an immutable full commit SHA, which lets DSH manage Git updates and rollback. An earlier install from an unpinned GitHub URL or a tag needs a one-time migration: remove only `@local/dsh-roblox-tiered`, then install its current version from the index. Do not remove unrelated plugins. Subsequent releases advertised by the index can be updated in the app; a GitHub tag alone does not advertise an update.

Version **1.1.0** includes the self-provisioning toolchain. Install its immutable entry from the plugin index for managed updates, or use `github:alexmbright/dsh-roblox-development#v1.1.0` for a fixed tag install. Tag installs do not provide managed Git updates.

### Native worker availability

The preset uses DSH's native model-selectable `spawn` tool and the host's native backend. Tiered dispatch refuses `fork`, which inherits the lead route. Version 1.0.2 updates rc2 compatibility metadata and removes the stale `interrupt_agent` reference; it does not replace the spawn implementation. Check actual tool declarations and dispatch results before concluding that workers are unavailable. A Windows session reported successful native worker creation after correcting its earlier availability claim. macOS spawning still requires a live smoke test.

## First session

Open the intended project in Roblox Studio. Enable **Studio as MCP server** in Assistant → Manage MCP Servers. Ask DSH:

> Verify the pinned skill catalog and available worker routes using read-only discovery, then run routine toolchain smoke checks under workspace-write. Do not operate Studio, save, publish, or upload anything.

The bundle includes all 29 roblox-brain skills pinned to `ceee4aaa5004502e2a51d78b3c33bba44d84742b`. The filesystem provider reads the installed snapshot directly. Starting a session and loading skills do not fetch upstream or create a home-directory checkout. Future skill refreshes are bundle maintenance, not part of game work.

## One-install toolchain (1.1.0)

On plugin activation, DSH downloads checksum-pinned upstream Lune 0.11.1, StyLua 2.6.0, Selene 0.32.0, Luau 0.745 and luau-lsp 1.70.1 into a shared profile-owned `roblox-toolchain` directory. This is plugin setup, not a game-worker permission escalation. Downloads are verified before safe ZIP extraction, staged atomically, and reused offline after executable checks. No tool is fetched through a floating latest tag, no install lifecycle script is required, and no project gets executable copies. First setup needs internet; routine runs do not repeat downloads. Interrupted installs recover through unique staged writes without shared locks; abandoned stages are ignored rather than deleted. Corrupt completed installs fail clearly rather than silently overwriting unknown files.

The Chrrxs bridge is a pinned package dependency installed with the bundle, launched through DSH's packaged Node/Electron runtime—not npx. Its existing Studio-plugin auto-install remains explicit. Roblox Studio, official Studio MCP availability and provider sign-ins remain user/machine prerequisites. This bundle does not install Studio, silently publish a place, or copy sign-in state.

## Routine tools without Full access

Keep `workspace-write`. The scoped shell initializes tool state under `.dsh/roblox` inside the sandbox workspace: home/config/cache variables, npm and Python caches, and tool temp. The plugin-provisioned exact pinned executables run directly from their shared machine installation—no per-project executable copies or downloads. Existing project Rokit/Aftman pins are respected when their exact versions are installed; mismatches fail explicitly rather than silently switching versions. Writable-state bootstrap runs inside the sandbox. No global process environment, ACL policy, or Full-access setting changes. Routine `lune run`, Selene and StyLua check mode passed a real Windows workspace-write smoke test.

Selene's Windows floating cache ignores environment-only redirection. The native shell preamble seeds the bundled Roblox standard next to the project config, preserving lint rules and existing standards. This works on a fresh machine without a global Selene cache. `lune run` works locally; unsupported Windows setup/REPL/cross-target paths are refused with an explanation. Details and first-machine setup are in [workspace tooling](skills/roblox-tiered-workflow/references/workspace-tooling.md).

Automatic shell retries requesting `danger-full-access` are rejected before approval. This avoids the repeated prompt loop; it does not turn unsupported operations into successes. DSH internal runner temp/logs/output spills and Studio/MCP installations remain outside this wrapper. Persistent/user terminals do not inherit it; use the wrapped shell and its managed background mode for routine checks. Add `.dsh/roblox/` to the game's local ignore rules rather than committing caches. The bundle provisions its default toolchain once per device; custom project pins outside that set must already be installed or be handled as a separate setup change.

Worker dispatch now requires an explicit provider/model/effort triple from the role matrix, with a recorded reason for off-matrix capacity fallback. Omitted routes no longer silently inherit the captain model; fork is refused for tiered dispatch. DSH authorizes model routes once per fresh top-level session. Changing the profile allowlist does not widen old sessions or their children: start a fresh top-level session if discovery exposes only the old lead route. The bundle supplies defaults for DSH's existing Host model-route settings row (no duplicate service). This default authorizes the role-matrix pairs for fresh top-level sessions profile-wide, including other presets; saved user settings still take precedence. It does not sign in accounts or widen existing session authorizations.

## Studio setup

The official client uses Windows `%LOCALAPPDATA%/Roblox/mcp.bat` through `cmd.exe`, or macOS `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`. For nonstandard installations set `DSH_ROBLOX_STUDIO_MCP` in DSH's launch environment to the batch file (Windows) or executable (macOS).

Chrrxs launches the bundle's pinned `@chrrxs/robloxstudio-mcp` 3.4.3 dependency using DSH's packaged runtime with `--auto-install-plugin`. It may install/update its Studio plugin. Review that trust choice before selecting the mode, and restart Studio when required. System Node/npm/npx is not used for this bridge.

Enable native Script Sync for the intended project. Official `studio_id` and Chrrxs `instance_id` are distinct: resolve each independently. One operator coordinates both bridges through messages. Automatic reconnect is disabled so failures are diagnosed before retrying.

### Chrrxs structured-result compatibility (1.0.3)

Chrrxs 3.4.3's modern MCP response path can return `content: []` with the actual data in `structuredContent`. DSH rc2 retains that data but renders only `content`, producing `returned no model-visible content`. The published rc3 adapter source has the same rendering path. This message does **not** establish a proxy failure or a disconnected Studio.

The bundle now mounts a small result adapter inside Roblox sessions. For successful Chrrxs calls with structured-only data and the exact empty DSH presentation, it exposes the existing structured data as JSON text. It neither calls Studio again nor changes canonical results, failures, images, other servers, or downstream policy decisions. Already-visible results are left alone. This is installed bundle code, not a patch inside DSH's installation, so replacing the DSH application does not overwrite it. Future breaking plugin API changes still require compatibility testing; no plugin can guarantee compatibility with every future release.

After updating, fully restart DSH and create a new Roblox session. Call `get_connected_instances` read-only. A visible empty instance list is a valid result, not proof of a connected Studio; follow its diagnostics. Resolve current instance IDs rather than reusing IDs from an earlier session. If the old placeholder persists, report the DSH and bundle versions and confirm the new preset is mounted. Do not repeatedly replay mutation calls whose outcome is unknown. Auto-review JSON errors that say the body was not executed are separate and are not repaired by this adapter.

### Multiple clients and cleanup limitations

The upstream bridge uses one primary on its default local port, with additional servers entering proxy mode. Another application's primary is not by itself an error. Inspect upstream status or stderr without exposing credentials; do not kill other applications, change MCP configuration, or reinstall the Studio plugin as an automatic repair. Never print or include the contents of `~/.robloxstudio-mcp/auth-token` in logs or bug reports. This bundle's compatibility adapter does not read that file.

Do not set a private `ROBLOX_STUDIO_PORT` as a default workaround: upstream auto-install can rewrite the installed Studio plugin for that port. Port changes and Studio-plugin modifications require the user's explicit approval.

DSH rc2 delegates MCP process cleanup to the SDK, which closes stdin and signals the direct child; this does not guarantee termination of an entire npm launcher process tree on Windows or macOS. This release fixes result visibility, **not** the Host's process-lifecycle contract. Ending a turn or closing a UI tab is not evidence of agent-scope disposal. Report confirmed leftover processes to DSH with redacted lifecycle evidence; only stop processes the user explicitly authorizes. Clean-machine primary/proxy Studio smoke tests and cross-platform disposal tests remain required before claiming those acceptance checks pass.

## Workflow

Describe the game outcome. Captain coordinates; workers implement, derive checks, repair failures, and report evidence. Coupled work can belong to one worker. [Workflow](skills/roblox-tiered-workflow/SKILL.md) links to domain selection and lifecycle guidance. [Routes](routes.json) are advisory: discover available models and efforts before dispatch and adapt unavailable routes explicitly. No subscriptions are included.

Workers share the bundled skill revision recorded by captain. The snapshot is pinned, not a claim of current upstream freshness. Its full MIT notice is included; see [third-party notices](THIRD-PARTY-NOTICES.md).

## Development and release safety

```sh
git clone https://github.com/alexmbright/dsh-roblox-development.git
cd dsh-roblox-development
npm test
```

No build or install lifecycle scripts are needed. The legacy `npm run setup` remains an optional maintainer utility and defaults to a checkout under the current workspace; it is not invoked by sessions and does not change the installed skill pin. Local development installation uses plugin_manager with the absolute directory.

The committed patch resolves installed resources at runtime; it contains no generated home paths. Keep caches, environment files, credentials, logs, game projects and session records out of Git and release attachments. Review tracked files and full history before release. Automated checks are defense in depth, not a guarantee that future files contain no secrets. The package is published publicly to npm; `private` is not set, and `publishConfig.access` is `public`. This project is not affiliated with Roblox or its dependency authors.

## Verification limits

Tests check packaging, portability and updater behavior against local Git fixtures. They do not establish live Studio connectivity or game behavior. Windows local installation has been exercised. macOS path expressions are tested synthetically; a live Mac smoke test remains required. Never publish a game as an installation test.
