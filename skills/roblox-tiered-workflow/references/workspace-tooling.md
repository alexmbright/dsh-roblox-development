## Run checks through the tool

`roblox_run_tool` is the supported way to run the provisioned binaries:

```js
roblox_run_tool({ tool: 'selene', args: ['check', '.'], cwd: '/path/to/project' })
roblox_run_tool({ tool: 'lune',   args: ['run', 'scripts/check.luau'] })
roblox_run_tool({ tool: 'stylua', args: ['--check', 'src'] })
```

Supported tools: `lune`, `stylua`, `selene`, `luau`, `luau-analyze`, `luau-compile`, `luau-lsp`.
The call runs in the host process against the exact pinned executable and returns
`{ exitCode, stdout, stderr, truncated }`. It needs no shell approval and never resolves a
different version from `PATH`, so prefer it over `bash` for these binaries. The notes below
describe the environment that preamble sets up when a shell step is genuinely required.

# Workspace-local routine tooling

## Run checks without permission escalation

The Roblox shell tool preserves the existing DSH sandbox and redirects cooperative home/config/cache/temp locations into `<sandbox-workspace>/.dsh/roblox`. It initializes these directories inside that sandbox, not from privileged Host code. The plugin provisions its pinned default toolchain once into shared profile-owned storage at activation, then runs those executables in place. Routine model shell calls never install tools, mutate that shared cache or request Full access. No executables are copied, linked, downloaded or installed per project. Project Rokit/Aftman pins take precedence when exact installed versions are available; custom missing versions require a separate setup change, not a silent latest-version fallback.

Use normal shell checks under workspace-write. Full-access shell escalation is rejected by this mode before the approval path. On a remaining denial, inspect the exact path/tool and choose a supported local configuration, or report that operation as unsupported. Never turn a failed check into an unverified success.

## Selene

Windows Selene 0.32.0's floating Roblox standard uses a Known Folder API; changing `LOCALAPPDATA` alone does not contain it. A `roblox.yml` beside the project `selene.toml` is read before floating cache generation. The shell preamble seeds that file from the bundle's fixed read-only standard asset and preserves existing project standards and lint rules. Preparation uses native shell file operations; no system Node is needed. Use `selene --config <workspace-config> ...` when running from a different directory.

The bundled standard covers first use offline after toolchain setup. A deliberate API-standard refresh can run `selene generate-roblox-std` in the workspace config directory; that command writes its result in the current directory. Ordinary checks do not run `update-roblox-std`, which targets the global cache. For a nested config outside the current ancestry, pass that config to `scripts/prepare-workspace.mjs <workspace> <cwd> <original-local-appdata> <config>` before checking. Do not overwrite a user-authored standard.

## Lune and other tools

Use `lune run <script>` for standalone checks. On the verified Windows versions 0.10.5/0.11.1 this path uses the bundled reflection database and succeeded with workspace-local output. Windows `lune setup`, REPL history and cross-target builds have nonredirectable profile paths. The local shell function refuses those commands as an explanatory UX guardrail; the sandbox remains authoritative and invoking another executable spelling is not a containment fix. Native builds must use an explicit workspace output path. The macOS runtime is not live-tested.

StyLua check mode needs no global write. Preserve the project's existing lint, formatting, dependency and test settings. Package-manager caches are redirected, but arbitrary tools may ignore those variables; verify each new tool's actual behavior. Environment redirection is not a universal filesystem virtualization layer.

## Boundaries

DSH's private sandbox runner temp, Host logs/output spills, provider credentials, browser state and Roblox Studio's installed integration are not moved by this mode. MCP servers and user/persistent terminal processes do not use this shell wrapper. Use the wrapped one-shot shell (including its managed background mode) for routine local tooling, not a terminal as a workaround. Studio install/update, save, publish and upload retain their explicit authorization requirements. These exceptions do not require granting the game worker Full access.

All 29 domain skills are pinned in the bundle. Loading skills makes no runtime Git checkout or network request; change the pin through a separate bundle update.
