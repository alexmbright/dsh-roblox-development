# Roblox development for DSH

Configuration-only DSH bundle `@local/dsh-roblox-tiered` for Windows and macOS. Captain coordinates native workers, uses role-aware model routing, and selects current upstream roblox-brain skills. No custom permission guards, Studio locks, AgentTeams, or Rojo.

## Install

Prerequisites: DeepSeek Harness 0.2.2-rc.2 or newer within the 0.2.x series, Git, Node.js 22+ with npm/npx visible to DSH, Roblox Studio, and your model-provider accounts signed into DSH. Repository access does not transfer credentials.

**Fully quit DSH Desktop**, then run in Terminal:

```sh
dsh plugin --profile desktop add "github:alexmbright/dsh-roblox-development"
```

Use your actual profile name if it is not `desktop`. Reopen DSH and start a **new Roblox development session**. No manual clone, setup, npm build approval, or machine-specific configuration generation is required. If `dsh` is not on your terminal PATH, use your DSH installation's CLI launcher.

Alternatively, from a running DSH session ask:

> Install github:alexmbright/dsh-roblox-development using plugin_manager. If @local/dsh-roblox-tiered is already installed, remove that bundle first, then install this GitHub package.

The installation is profile-wide. Existing sessions retain their previous preset revision; start a new session after updating.

### Updates inside DSH

Add this source yourself in DSH's custom plugin indexes UI (enable the optional custom plugin indexes bundle if needed):

```text
https://raw.githubusercontent.com/alexmbright/dsh-roblox-development/main/plugin-index.json
```

Install the Roblox bundle from that index. Each version uses an immutable full commit SHA, which lets DSH manage Git updates and rollback. An earlier install from an unpinned GitHub URL or a tag needs a one-time migration: remove only `@local/dsh-roblox-tiered`, then install its current version from the index. Do not remove unrelated plugins. Subsequent releases advertised by the index can be updated in the app; a GitHub tag alone does not advertise an update.

For manual installation of this release, use `github:alexmbright/dsh-roblox-development#v1.0.2`; tag installs do not provide managed Git updates.

### Native worker availability

The preset uses DSH's native `spawn` and `fork` tools and the host's native backends. Version 1.0.2 updates rc2 compatibility metadata and removes the stale `interrupt_agent` reference; it does not replace the spawn implementation. Check actual tool declarations and dispatch results before concluding that workers are unavailable. A Windows session reported successful native worker creation after correcting its earlier availability claim. macOS spawning still requires a live smoke test.

## First session

Open the intended project in Roblox Studio. Enable **Studio as MCP server** in Assistant → Manage MCP Servers. Ask DSH:

> Refresh the Roblox skills, then verify shell selection, skill discovery, and both Studio MCP connections using read-only checks. Do not edit, save, publish, or upload anything.

The captain runs the installed updater before substantive work. It clones/refreshes upstream's default branch into `~/.cache/dsh-roblox-development/roblox-brain`; the filesystem skill provider discovers those roots automatically. This cache is outside the installed package and your game. Git/network access is required; a failed refresh must be reported rather than called current. Normal DSH permissions and approvals apply.

## Studio setup

The official client uses Windows `%LOCALAPPDATA%/Roblox/mcp.bat` through `cmd.exe`, or macOS `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`. For nonstandard installations set `DSH_ROBLOX_STUDIO_MCP` in DSH's launch environment to the batch file (Windows) or executable (macOS).

Chrrxs launches `npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin`. This downloads/runs the current upstream package and may install/update its Studio plugin. Review that trust choice before selecting the mode. Restart Studio when required. Node/npm must be visible to GUI-launched DSH, not merely an interactive terminal. The MCP SDK handles Windows npm shims.

Enable native Script Sync for the intended project. Official `studio_id` and Chrrxs `instance_id` are distinct: resolve each independently. One operator coordinates both bridges through messages. Automatic reconnect is disabled so failures are diagnosed before retrying.

## Workflow

Describe the game outcome. Captain coordinates; workers implement, derive checks, repair failures, and report evidence. Coupled work can belong to one worker. [Workflow](skills/roblox-tiered-workflow/SKILL.md) links to domain selection and lifecycle guidance. [Routes](routes.json) are advisory: discover available models and efforts before dispatch and adapt unavailable routes explicitly. No subscriptions are included.

The updater preserves dirty, ahead, diverged and wrong-branch checkouts. Workers share the revision recorded by captain at the work boundary. Skills remain current rather than pinned to a bundled commit. See [third-party notices](THIRD-PARTY-NOTICES.md).

## Development and release safety

```sh
git clone https://github.com/alexmbright/dsh-roblox-development.git
cd dsh-roblox-development
npm test
```

No build or install lifecycle scripts are needed. `npm run setup` is an optional manual upstream skill refresh, not an installation prerequisite. Local development installation uses plugin_manager with the absolute directory.

The committed patch resolves installed resources at runtime; it contains no generated home paths. Keep caches, environment files, credentials, logs, game projects and session records out of Git and release attachments. Review tracked files and full history before release. Automated checks are defense in depth, not a guarantee that future files contain no secrets. `private: true` prevents accidental npm publication, not GitHub installation or repository visibility. This project is not affiliated with Roblox or its dependency authors.

## Verification limits

Tests check packaging, portability and updater behavior against local Git fixtures. They do not establish live Studio connectivity or game behavior. Windows local installation has been exercised. macOS path expressions are tested synthetically; a live Mac smoke test remains required. Never publish a game as an installation test.
