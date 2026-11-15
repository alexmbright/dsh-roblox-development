# Visual gate: smaller-launch

Written by the visual reviewer worker only. The coordinator never edits this file; `tools/check-visual-gate.mjs` reads it.

Verdict: FAIL
Reviewer: <worker name> (visual/standard)
Reviewed: YYYY-MM-DD
Client source: src/client, src/StarterGui, src/StarterPlayer, src/ReplicatedFirst, assets

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

One `### Piece:` block per art piece. `Final:` names the kept asset id, or says `primitive` (then at least 6 distinct queries and the rejected candidates are required). Every candidate needs `thumbnail: yes` (get_asset_thumbnail) and `details: yes` (get_asset_details). A rejection needs `in-scene: yes` and a reason beyond scripts, triangle count, pivot or scale: those are fixable (insert in Edit mode, strip scripts, rescale). A kept asset from another owner needs its creator, price and a dated `authorized:` decision.

### Piece: <piece name>
Final: 1234567890
Queries: "low poly pine tree"; "stylized tree"; "forest tree pack"; "cartoon tree"; "tree model"; "nature props"
Candidates:
- 1234567890 | creator: <owner> | price: free | thumbnail: yes | details: yes | in-scene: yes | status: kept | authorized: YYYY-MM-DD
- 2345678901 | creator: <owner> | price: free | thumbnail: yes | details: yes | in-scene: yes | status: rejected | reason: realistic style clashes with the flat palette in cap-3c4d5e6f7a
