# Backpack Dungeon — Pivot Contract

This is the implementation source of truth for the current prototype. It supersedes earlier wall-trap and function-tag designs.

## Player promise

This is a backpack engine-builder wearing a dungeon-defense fantasy. Every offered item can be placed on the opening board and gives non-zero baseline value. Packing items tightly is the primary decision; traffic and directional zones make placement richer without turning any part of the board into dead space.

## Stage

- A full 8×12 dungeon is generated upfront and revealed from fog in four permanent Expand steps.
- The opening has 20 usable floor cells; each Expand reveals 6–7 more; the standard endpoint is 46.
- The Heart is a distinct 2×2 crystal keep. It is not a placement grid.
- One to three portals share the fixed wave budget equally. Expand can lengthen flows and add a portal, never removes existing floor.
- Enemies cross an ordered sequence of generated broad macro-gates before reaching the Heart, then use a flow field, broad lane bias, accumulated-traffic avoidance, and local separation. In chambers they spread through a 2–3-cell ribbon rather than collapsing into a single line; each gate is an area, never a fixed track.
- Traffic is a readable animated overlay in preparation and is deliberately hidden in combat; traps never reroute it.
- The generator validates the opening against every trap footprint. It favors chambers, broad passages, loops, and occasional columns over snake corridors.

## Traps

All traps are floor traps. There is no rotation and no wall socket system.

| Element | Traffic-sensitive | Stable / targets flyers |
|---|---|---|
| Physical | Spikes 1×2 | Saw Track 1×3 |
| Fire | Ember Plates (L, 4) | Flame Projector 1×2 |
| Frost | Frost Rune 1×3 | Icicle Launcher 1×1 |
| Water | Geyser 1×2 | Water Cannon 1×2 |
| Lightning | Lightning Mine 1×1 | Tesla Coil 2×2 |

Power is broadly normalized per occupied cell. Larger and more awkward footprints may receive a modest premium. Fire burns, Frost slows, Water moves crowds, Lightning chains, and Physical delivers direct dependable damage. Merge and tier scaling are retained.

## Tags and zones

- An item has one required elemental tag (`Physical`, `Fire`, `Frost`, `Water`, or `Lightning`) and at most one visible family tag (`Plate`, `Turret`, or `Blade`).
- Surface and abstract function tags are removed: no `Floor`, `Wall`, `Area`, `Rapid`, `Heavy`, `Impulse`, or `Control`.
- Directional zones are cyclic, use one obvious tag, and only boost DMG, Area, or Range: Geyser→Fire; Tesla→Water; Saw→Lightning; Frost Rune→Physical; Ember→Frost; Flame Projector→Plate; Icicle Launcher→Turret.
- Spikes, Lightning Mine, and Water Cannon are simple enablers without a zone.
- Perks only refer to elemental tags and are softly weighted toward the player’s build. Each element has two simple stat perks and one signature mechanic, keeping all nine reward screens at three valid unique choices. Families remain a readable item-and-zone vocabulary, never a second perk taxonomy.

## Readability

- Floor is light, gridded, and clearly playable. Rock walls are dark, solid, and never act as slots. Fog is flat and quiet.
- Each multi-cell trap is one connected object with a visible inset gap from neighbouring objects. The device silhouette communicates its job before its colour communicates its element.
- Tier is shown by small stars, not a shared high-contrast outline: none at T1, two gold stars at T2, three at T3.
- While dragging, a compact card shows name, elemental/family tags, target behavior, final stats, and a human-readable zone formula. Matching items and the owner’s zone result highlight green.
- During battle, trap bodies recede slightly; active components and enemies have priority, and damage numbers aggregate.

## Preserved loop

Three free T1 offers, Hold, Recycler, stackable free rerolls, merge, automatic waves, perk pick after waves, and the core economy remain. Coins buy only Reroll and Expand. There are no economic or defensive traps.
