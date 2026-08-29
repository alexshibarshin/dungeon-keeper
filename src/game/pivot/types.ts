export type TrapId = 'spikes' | 'saw' | 'ember' | 'flame' | 'frost' | 'icicle' | 'geyser' | 'cannon' | 'mine' | 'tesla';
export type TrapTier = 1 | 2 | 3;
export type Placement = 'floor';
export type ElementTag = 'Fire' | 'Frost' | 'Water' | 'Lightning' | 'Physical';
export type FamilyTag = 'Plate' | 'Turret' | 'Blade';
export type TrapTag = ElementTag | FamilyTag;
export type BoardCell = 'wall' | 'floor' | 'heart';
export type ItemLocation = 'shop' | 'board' | 'hold';
export type Phase = 'prep' | 'combat' | 'perk' | 'result';
export type EnemyKind = 'grunt' | 'runner' | 'flyer' | 'shieldbearer' | 'brute';
export type PerkRarity = 'rare' | 'epic' | 'legendary';

export interface Point { x: number; y: number }

export interface ZoneEffect {
  checks: TrapTag;
  damagePerCell: number;
  areaPerCell?: number;
  rangePerCell?: number;
}

export interface TrapDef {
  id: TrapId;
  name: string;
  placement: Placement;
  shape: Point[];
  element: ElementTag;
  family?: FamilyTag;
  /** Existing atlas source used while bespoke pivot art is produced. */
  assetId: string;
  zone?: ZoneEffect;
  damage: number;
  cooldown: number;
  area: number;
  range: number;
  impulse?: number;
  targetCap?: number;
  canTargetFlying?: boolean;
  color: number;
  accent: number;
  glyph: string;
}

export interface TrapItem {
  id: string;
  trapId: TrapId;
  tier: TrapTier;
  location: ItemLocation;
  origin?: Point;
  cooldowns: number[];
}

export interface EnemyDef {
  id: EnemyKind;
  name: string;
  hp: number;
  speed: number;
  radius: number;
  mass: number;
  heartDamage: number;
  color: number;
  accent: number;
  flying?: boolean;
}

export interface EnemyState {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  spawnDelay: number;
  entrance: number;
  gateIndex: number;
  laneBias: number;
  burnDps: number;
  burnTime: number;
  burnSourceId: string | null;
  slow: number;
  slowTime: number;
  frostSourceId: string | null;
  vulnerable: number;
  vulnerableTime: number;
  hardControlLevel: number;
  hardControlWindow: number;
  hardControlImmune: number;
  noProgressTime: number;
  bestFlowDistance: number;
  impulseTime: number;
  airborneTime: number;
  airborneDuration: number;
  impactDamage: number;
  impactRadius: number;
  impactSourceId: string | null;
  impulseSourceId: string | null;
  launched: boolean;
  collisionSpent: boolean;
  dead: boolean;
}

export interface RevealStep {
  cells: Point[];
}

export interface FlowPlan {
  /** Stable spawn portals for this reveal state. */
  entrances: Point[];
  /** Ordered broad checkpoints. Enemies choose their own cells inside each gate. */
  gates: Point[][];
}

export interface DungeonStage {
  seed: number;
  name: string;
  archetype: string;
  tagline: string;
  fullGrid: BoardCell[][];
  heartOrigin: Point;
  revealPlan: RevealStep[];
  initialFloor: Point[];
  finalEntrances: Point[];
  /** One pre-generated flow contract for the initial board and every expansion. */
  flowPlans: FlowPlan[];
}

export interface PerkScope {
  element: ElementTag;
}

export interface PerkDef {
  id: string;
  name: string;
  rarity: PerkRarity;
  weight: number;
  scope: PerkScope;
  text: string;
  damageBonus?: number;
  cooldownMultiplier?: number;
  mechanic?: string;
}

export interface RunStats {
  killed: number;
  leaked: number;
  damageTaken: number;
  trapDamage: Record<string, number>;
  wavesCleared: number;
  rerolls: number;
  expands: number;
  recycled: number;
}

export interface GameSnapshot {
  phase: Phase;
  wave: number;
  coins: number;
  hp: number;
  maxHp: number;
  speed: 1 | 2;
  paused: boolean;
  enemyCount: number;
  shop: TrapItem[];
  hold: TrapItem | null;
  selectedPerks: string[];
  perkChoices: PerkDef[];
  rerollCost: number;
  rerollFree: boolean;
  freeRerolls: number;
  recyclerPoints: number;
  recyclerTarget: number;
  expandCost: number | null;
  expandCount: number;
  activeEntrances: Point[];
  preview: Record<EnemyKind, number>;
  dragging: TrapItem | null;
  dragZoneBonus: number;
  message: string;
  enemyHint: EnemyKind | null;
  recycleConfirm: TrapItem | null;
  shopTransitioning: boolean;
  stats: RunStats;
  victory: boolean | null;
}
