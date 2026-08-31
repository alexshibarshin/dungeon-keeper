# Domain context

## Crowd Flow

Crowd Flow is the combat movement model that makes the horde behave like a
compressible liquid moving from portals toward the Dungeon Heart.

- The flow field supplies global progress toward the Heart.
- Local pressure spreads enemies sideways without choosing a cell farther from
  the Heart.
- Enemies may overlap softly; deep overlap is corrected with mass-aware crowd
  pressure instead of rigid pair separation.
- Walls are hard terrain. Turret colliders influence local flow, but must never
  create a permanent stall.
- Large enemies use the same rules with radius-aware clearance.

