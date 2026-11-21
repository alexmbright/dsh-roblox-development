# Visual gate: <scope>

Written by the visual reviewer worker only. The coordinator never edits this file. Roblox mode checks it with its bundled `tools/check-visual-gate.mjs` (the single rule source; `--rules` prints every rule) and `roblox_visual_gate` shows the result.

Rules: the entire `Verdict:` value must be `PASS` or `FAIL` (not `PASS|FAIL` or `PASS pending`); a `Reviewer:` that is a visual/standard or visual/expert worker the lead dispatched; at least 3 screenshots (capture ids from `roblox_screenshots`); a checklist of at least 5 items, all checked for PASS; this file newer than every watched file; and an explicit Asset sourcing section as described below.

### Watched source and ignores

With no `Client source:` line, the checker watches `src/client`, `src/StarterGui`, `src/StarterPlayer`, `src/ReplicatedFirst` and `assets`; absent default folders are okay. To override, add a line such as `Client source: src/client, assets/Tree.rbxm`. Every explicitly listed path must exist and be a project-relative file or folder. Files are watched directly, folders recursively. Empty overrides, globs, absolute paths, backslashes and `..` segments fail with `CLIENT_SOURCE`; symlinks must stay inside the project and must not form cycles. Do not paste a list of nonexistent optional folders into an override.

`Ignore:` accepts comma/semicolon-separated globs and **replaces**, rather than extends, the default backup ignores shown below. `.DS_Store`, `*.bak`, `*.tmp` and `*.lock` are always ignored. Keep runtime assets conservative: generated art can change the game, so `assets/generated/**` and `assets/manifest.json` are **not** ignored by default. Only if those outputs are genuinely nonvisual/nonruntime for this project may you explicitly configure, for example, `Ignore: assets/backup/**, **/*.backup.rbxm, **/*.backup.rbxmx, **/backup/**, assets/generated/**, assets/manifest.json`. Preserve the backup patterns when replacing the defaults if backups should remain ignored. If a backup replaces a live asset, or generated art/manifest changes affect what players see, update the watched live source and obtain fresh screenshots/review; an ignore is not permission to reuse a stale PASS.

Verdict: FAIL
Reviewer: <worker name> (visual/standard)
Reviewed: YYYY-MM-DD
Ignore: assets/backup/**, **/*.backup.rbxm, **/*.backup.rbxmx, **/backup/**

Screenshots:
- cap-1a2b3c4d5e main menu, desktop
- cap-2b3c4d5e6f HUD, phone
- cap-3c4d5e6f7a scene overview

## Checklist

- [ ] Readable at phone, tablet and desktop sizes (capture_device_matrix)
- [ ] Clear visual hierarchy: the primary action is obvious within two seconds
- [ ] Consistent palette, fonts and corner radius across screens
- [ ] Scene art is not placeholder: no untextured primitive stand-ins in player view
- [ ] Lighting and atmosphere match the art direction
- [ ] Nothing clipped, overlapping or off-screen in any capture

## Findings

- <what is wrong, which screenshot shows it, and the fix>

## Asset sourcing

This section is required, even for UI-only work. Keep at least one `### Piece:` block for art work. For UI-only work with no art sourcing or art changes, remove **all** Piece blocks and instead write `Not applicable: UI-only menu layout changes; no scene art or imported assets were added or modified.` Use your actual reason: it must explicitly say UI-only and give a substantive explanation (at least 24 characters and five words), not merely `N/A` or `no assets`. Do not combine a Not applicable exemption with Piece blocks. Keep exactly one `## Asset sourcing` section and put all Piece blocks inside it.

One `### Piece:` block per art piece. `Final:` names exactly one kept asset id, or says `primitive`, never both. A final id must match a candidate row marked `status: kept`. Primitive final art still requires at least **6 distinct search_assets queries** and the shortlisted rejected candidates; this policy is unchanged. Every candidate needs `thumbnail: yes` (get_asset_thumbnail) and `details: yes` (get_asset_details). A rejection needs `in-scene: yes` and a reason beyond scripts, triangle count, pivot or scale: those are fixable (insert in Edit mode, strip scripts, rescale). A kept asset from another owner needs its creator, price and a dated `authorized:` decision: the complete value must be a real calendar date in `YYYY-MM-DD` form (not a placeholder, impossible date or trailing comment). This file records the reviewer’s evidence; a standalone FILE check cannot itself verify screenshot contents or tool-call history.

### Piece: <piece name>
Final: 1234567890
Queries: "low poly pine tree"; "stylized tree"; "forest tree pack"; "cartoon tree"; "tree model"; "nature props"
Candidates:
- 1234567890 | creator: <owner> | price: free | thumbnail: yes | details: yes | in-scene: yes | status: kept | authorized: YYYY-MM-DD
- 2345678901 | creator: <owner> | price: free | thumbnail: yes | details: yes | in-scene: yes | status: rejected | reason: realistic style clashes with the flat palette in cap-3c4d5e6f7a
