import type { EnemyDef, EnemyKind, PerkDef, Point, TrapDef, TrapId } from './types';

// The board keeps its original 720×1012 composition; the extra 120 px belongs
// entirely to the prep tray so its item, wallet and action rows do not collide.
export const WIDTH = 720, HEIGHT = 1400, COLS = 8, ROWS = 12, CELL = 72;
export const BOARD_X = 72, BOARD_Y = 148, BOARD_W = COLS * CELL, BOARD_H = ROWS * CELL, SHOP_Y = BOARD_Y + BOARD_H;
export const STARTING_COINS = 2, HEART_HP = 200;
export const WAVE_INCOME = [9, 11, 14, 17, 20, 23, 26, 29, 32] as const;
export const REROLL_PRICES = [2, 7, 10, 13, 14, 19, 22, 25, 28, 31, 34, 37, 40] as const;
export const EXPAND_PRICES = [5, 15, 31, 54] as const;
export const RECYCLER_TARGETS = [2, 4, 6, 8, 10, 12] as const;
export const FLOOR_TARGETS = { tight: 42, standard: 46, roomy: 50 } as const;
export const FINAL_FLOOR_TARGET = FLOOR_TARGETS.standard, INITIAL_FLOOR_TARGET = 20;
export const REVEAL_CHUNK_SIZES = [7, 7, 6, 6] as const;
export const FLOW_LANE_SPREAD = 24, FLOW_DENSITY_AVOIDANCE = .8;
export const CONTROL_TUNING = { diminishingReturns: [1, .6, .3, 0] as const, sequenceWindow: 3, immunityDuration: 2, noProgressTimeout: 6, impulseDuration: .34, slowStrength: .35, slowDuration: 2, burnDuration: 3 } as const;
const shape = (...cells: [number, number][]): Point[] => cells.map(([x, y]) => ({ x, y }));
const floor = (value: Omit<TrapDef, 'placement'>): TrapDef => ({ ...value, placement: 'floor' });

// One concrete floor object per item: silhouette says function, colour says element.
export const TRAPS: Record<TrapId, TrapDef> = {
  spikes: floor({ id: 'spikes', name: 'Spikes', assetId: 'spikes-horizontal-topdown-v3', shape: shape([0, 0], [1, 0]), element: 'Physical', damage: 38, cooldown: 1.5, area: 32, range: 0, color: 0x5c4d45, accent: 0xf1c879, glyph: '▲' }),
  saw: floor({ id: 'saw', name: 'Saw Track', assetId: 'saw-horizontal-topdown-v3', shape: shape([0, 0], [1, 0], [2, 0]), element: 'Physical', family: 'Blade', zone: { checks: 'Lightning', damagePerCell: .06 }, damage: 26, cooldown: .9, area: 40, range: 0, canTargetFlying: true, color: 0x5e4d3e, accent: 0xe6bc65, glyph: '◉' }),
  ember: floor({ id: 'ember', name: 'Ember Plates', assetId: 'ember-l-topdown-v2', shape: shape([0, 0], [1, 0], [0, 1], [0, 2]), element: 'Fire', family: 'Plate', zone: { checks: 'Frost', damagePerCell: .06, areaPerCell: .06 }, damage: 18, cooldown: .75, area: 34, range: 0, color: 0x7d2b22, accent: 0xff7136, glyph: '♨' }),
  flame: floor({ id: 'flame', name: 'Flame Projector', assetId: 'flame-horizontal-topdown-v2', shape: shape([0, 0], [1, 0]), element: 'Fire', family: 'Turret', zone: { checks: 'Plate', damagePerCell: .06, rangePerCell: .06 }, damage: 29, cooldown: 1.0, area: 52, range: 220, targetCap: 4, canTargetFlying: true, obstacle: { offset: { x: .46, y: .5 }, radius: 5 }, turret: { baseOffset: { x: .46, y: .5 }, pivotOffset: { x: 1, y: .5 }, muzzleDistance: 48, turnSpeed: 7.2, projectileSpeed: 650 }, color: 0x6a2f22, accent: 0xff963c, glyph: '◖' }),
  frost: floor({ id: 'frost', name: 'Frost Rune', assetId: 'frost-vertical-topdown-v3', shape: shape([0, 0], [0, 1], [0, 2]), element: 'Frost', family: 'Plate', zone: { checks: 'Physical', damagePerCell: .06 }, damage: 17, cooldown: .82, area: 38, range: 0, color: 0x356b87, accent: 0xc9f8ff, glyph: '✦' }),
  icicle: floor({ id: 'icicle', name: 'Icicle Launcher', assetId: 'icicle-topdown-v1', shape: shape([0, 0]), element: 'Frost', family: 'Turret', zone: { checks: 'Turret', damagePerCell: .06, rangePerCell: .06 }, damage: 34, cooldown: 1.3, area: 0, range: 280, targetCap: 1, canTargetFlying: true, obstacle: { offset: { x: .3, y: .5 }, radius: 5 }, turret: { baseOffset: { x: .3, y: .5 }, pivotOffset: { x: .5, y: .5 }, muzzleDistance: 38, turnSpeed: 8.4, projectileSpeed: 860 }, color: 0x315575, accent: 0xc8f7ff, glyph: '◆' }),
  geyser: floor({ id: 'geyser', name: 'Geyser', assetId: 'geyser-vertical-topdown-v3', shape: shape([0, 0], [0, 1]), element: 'Water', zone: { checks: 'Fire', damagePerCell: .06, areaPerCell: .06 }, damage: 15, cooldown: 1.15, area: 46, range: 0, impulse: 112, color: 0x176f7d, accent: 0x41e9e2, glyph: '≈' }),
  cannon: floor({ id: 'cannon', name: 'Water Cannon', assetId: 'cannon-horizontal-topdown-v2', shape: shape([0, 0], [1, 0]), element: 'Water', family: 'Turret', damage: 25, cooldown: 1.15, area: 0, range: 270, impulse: 150, targetCap: 1, canTargetFlying: true, obstacle: { offset: { x: .46, y: .5 }, radius: 5 }, turret: { baseOffset: { x: .46, y: .5 }, pivotOffset: { x: 1, y: .5 }, muzzleDistance: 52, turnSpeed: 7.5, projectileSpeed: 720 }, color: 0x1a6072, accent: 0x35e4dc, glyph: '➤' }),
  mine: floor({ id: 'mine', name: 'Lightning Mine', assetId: 'mine-topdown-v1', shape: shape([0, 0]), element: 'Lightning', family: 'Plate', damage: 26, cooldown: 1.65, area: 58, range: 0, color: 0x56327d, accent: 0xb86dff, glyph: 'ϟ' }),
  tesla: floor({ id: 'tesla', name: 'Tesla Coil', assetId: 'tesla-topdown-v1', shape: shape([0, 0], [1, 0], [0, 1], [1, 1]), element: 'Lightning', family: 'Turret', zone: { checks: 'Water', damagePerCell: .06, rangePerCell: .06 }, damage: 27, cooldown: 1.0, area: 0, range: 300, targetCap: 3, canTargetFlying: true, obstacle: { offset: { x: 1, y: 1 }, radius: 8 }, color: 0x4a2b70, accent: 0xb86dff, glyph: 'ϟ' }),
};
export const TRAP_IDS = Object.keys(TRAPS) as TrapId[], TIER_DAMAGE = { 1: 1, 2: 1.75, 3: 3 } as const, TIER_ZONE = { 1: 1, 2: 1.5, 3: 2 } as const;
export function trapActivationOffsets(def: TrapDef) {
  if (def.family === 'Plate') return def.shape.map((offset, segmentIndex) => ({ offset, segmentIndex, independent: true }));
  return [{
    offset: {
      x: def.shape.reduce((sum, point) => sum + point.x, 0) / def.shape.length,
      y: def.shape.reduce((sum, point) => sum + point.y, 0) / def.shape.length,
    },
    segmentIndex: 0,
    independent: false,
  }];
}
export const ENEMIES: Record<EnemyKind, EnemyDef> = { grunt: { id: 'grunt', name: 'Grunt', hp: 80, speed: 65, radius: 10, mass: 1, heartDamage: 1, color: 0xe8d9b0, accent: 0xaec5dc }, runner: { id: 'runner', name: 'Runner', hp: 55, speed: 85, radius: 8, mass: .7, heartDamage: 1, color: 0xf5e6b6, accent: 0xe76d55 }, flyer: { id: 'flyer', name: 'Flyer', hp: 115, speed: 62, radius: 11, mass: .8, heartDamage: 2, color: 0xe7d7bf, accent: 0xb45b8f, flying: true }, shieldbearer: { id: 'shieldbearer', name: 'Shieldbearer', hp: 220, speed: 40, radius: 13, mass: 2.3, heartDamage: 3, color: 0xcabf9d, accent: 0x4e79a7 }, brute: { id: 'brute', name: 'Brute', hp: 400, speed: 35, radius: 18, mass: 4.5, heartDamage: 4, color: 0x938ba1, accent: 0xc6b06b } };
export const ARCHETYPES = [{ name: 'Crimson Fang Rift', archetype: 'Green Tide', tagline: 'A dense horde. Area damage thrives.', bias: 'grunt' }, { name: 'Well of Slippery Oaths', archetype: 'Slippery Ledge', tagline: 'Fast enemies test every gap.', bias: 'runner' }, { name: 'Iron March Dungeons', archetype: 'Iron March', tagline: 'Armor advances in measured ranks.', bias: 'shieldbearer' }, { name: 'Grotto of Ashen Wings', archetype: 'Winged Cavern', tagline: 'Flying foes test your target selection.', bias: 'flyer' }, { name: 'Four Maws of the Abyss', archetype: 'All-Sides Siege', tagline: 'Threats arrive from every frontier.', bias: 'mixed' }] as const;
export function buildWavePreview(archetype: string, wave: number): Record<EnemyKind, number> {
  const special = Math.floor(6 + wave * 5), total = 24 + wave * 25;
  const result: Record<EnemyKind, number> = { grunt: total, runner: 0, flyer: 0, shieldbearer: 0, brute: 0 };
  if (wave < 2) return result;

  if (archetype === 'Green Tide') result.runner = Math.ceil(special * .35);
  if (archetype === 'Slippery Ledge') result.runner = special;
  if (archetype === 'Iron March') {
    // This stage advertises endurance, not an unavoidable early attrition tax.
    // Shields ramp from Wave 2; true Brutes only enter once the build has six
    // shop batches and three meaningful expansion opportunities behind it.
    result.shieldbearer = Math.ceil(special * (wave < 6 ? .42 : .58));
    result.brute = wave >= 6 ? Math.max(1, Math.floor((wave - 4) / 2)) : 0;
  }
  if (archetype === 'Winged Cavern' && wave >= 4)
    result.flyer = Math.max(1, Math.round(total * Math.min(.15, .06 + (wave - 4) * .015)));
  if (archetype === 'All-Sides Siege') {
    result.runner = Math.ceil(special * .4);
    result.shieldbearer = Math.floor(special * .35);
    result.flyer = special - result.runner - result.shieldbearer;
  }

  result.grunt = Math.max(1, total - Object.entries(result).filter(([kind]) => kind !== 'grunt').reduce((sum, [, value]) => sum + value, 0));
  if (wave >= 7 && archetype !== 'Iron March') {
    const count = Math.floor((wave - 5) / 2);
    result.brute += count; result.grunt -= count;
  }
  return result;
}
const rare = (id: string, name: string, scope: PerkDef['scope'], text: string, values: Partial<PerkDef> = {}): PerkDef => ({ id, name, rarity: 'rare', weight: 10, scope, text, ...values });
const epic = (id: string, name: string, scope: PerkDef['scope'], text: string, mechanic: string): PerkDef => ({ id, name, rarity: 'epic', weight: 5, scope, text, mechanic });
export const PERKS: PerkDef[] = [
  rare('wildfire', 'Wildfire', { element: 'Fire' }, '[Fire] DMG +50%', { damageBonus: .5 }),
  rare('stoked-furnace', 'Stoked Furnace', { element: 'Fire' }, '[Fire] Cooldown -20%', { cooldownMultiplier: .8 }),
  rare('cold-snap', 'Cold Snap', { element: 'Frost' }, '[Frost] Cooldown -20%', { cooldownMultiplier: .8 }),
  rare('deep-freeze', 'Deep Freeze', { element: 'Frost' }, '[Frost] DMG +50%', { damageBonus: .5 }),
  rare('high-pressure', 'High Pressure', { element: 'Water' }, '[Water] DMG +50%', { damageBonus: .5 }),
  rare('riptide', 'Riptide', { element: 'Water' }, '[Water] Cooldown -20%', { cooldownMultiplier: .8 }),
  rare('overcharge', 'Overcharge', { element: 'Lightning' }, '[Lightning] Cooldown -20%', { cooldownMultiplier: .8 }),
  rare('high-voltage', 'High Voltage', { element: 'Lightning' }, '[Lightning] DMG +50%', { damageBonus: .5 }),
  rare('razor-edge', 'Razor Edge', { element: 'Physical' }, '[Physical] DMG +50%', { damageBonus: .5 }),
  rare('oiled-gears', 'Oiled Gears', { element: 'Physical' }, '[Physical] Cooldown -20%', { cooldownMultiplier: .8 }),
  epic('chain-combustion', 'Chain Combustion', { element: 'Fire' }, 'Burning enemies explode on death', 'fire-death-explosion'),
  epic('shatter', 'Shatter', { element: 'Frost' }, 'Slowed enemies burst into ice shards', 'frost-death-shards'),
  epic('tidal-crash', 'Tidal Crash', { element: 'Water' }, 'Water movement ends with an impact', 'water-impact'),
  epic('forked-lightning', 'Forked Lightning', { element: 'Lightning' }, 'Attacks fire an extra lightning bolt', 'storm-bolt'),
  epic('seismic-edge', 'Seismic Edge', { element: 'Physical' }, 'Hits release a close-range shockwave', 'heavy-shockwave'),
];
