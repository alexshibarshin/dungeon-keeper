export type ElementType = 'fire' | 'water' | 'frost' | 'storm' | null;
export type Placement = 'floor' | 'wall';
export type CellKind = 'floor' | 'rock' | 'eternal' | 'pit' | 'heart' | 'built';
export type Phase = 'lobby' | 'prep' | 'combat' | 'perk' | 'result';

export interface Point { x: number; y: number }

export interface TrapDef {
  id: string;
  name: string;
  short: string;
  placement: Placement;
  element: ElementType;
  color: number;
  accent: number;
  basePrice: number;
  maxSize: number;
  damage: number;
  cooldown: number;
  radius: number;
  impulse?: number;
  icon: string;
}

export interface TrapOffer {
  id: string;
  trapId: string;
  shape: Point[];
  price: number;
  frozen: boolean;
}

export interface PlacedTrap {
  id: string;
  trapId: string;
  origin: Point;
  shape: Point[];
  level: number;
  pricePaid: number;
  cooldowns: number[];
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  speed: number;
  radius: number;
  mass: number;
  baseDamage: number;
  aura: ElementType;
  auraSource: string | null;
  auraTime: number;
  sourceLevel: number;
  frozen: number;
  hit: boolean;
  flying: boolean;
  dead: boolean;
  spawnDelay: number;
  entrance: number;
  angle: number;
  laneBias: number;
  lastCellX: number;
  lastCellY: number;
  impulseTime: number;
}

export type EnemyKind = 'delver' | 'runner' | 'brute' | 'shield' | 'wing';

export interface EnemyDef {
  name: string;
  hp: number;
  speed: number;
  radius: number;
  mass: number;
  baseDamage: number;
  color: number;
  accent: number;
  reward: number;
  flying?: boolean;
}

export interface StageSpec {
  seed: number;
  name: string;
  archetype: string;
  tagline: string;
  grid: CellKind[][];
  entrances: Point[];
  heart: Point;
}

export interface GameStats {
  killed: number;
  pitKills: number;
  leaked: number;
  damageTaken: number;
  reactionCount: Record<string, number>;
  reactionDamage: Record<string, number>;
  primerCount: Record<string, number>;
  triggerCount: Record<string, number>;
  burnDamage: Record<string, number>;
  trapDamage: Record<string, number>;
  trapLevels: Record<string, number>;
  heartDamage: number;
  maxHeartLevel: number;
  builtWalls: number;
  digs: number;
  spentTraps: number;
  spentUpgrades: number;
  spentHeart: number;
  spentRepair: number;
  spentReroll: number;
  spentTerrain: number;
  wavesCleared: number;
}

export interface GameSnapshot {
  phase: Phase;
  wave: number;
  coins: number;
  hp: number;
  maxHp: number;
  heartLevel: number;
  speed: number;
  enemyCount: number;
  offers: TrapOffer[];
  selectedOffer: string | null;
  selectedTrap: string | null;
  terrainMode: 'dig' | 'build' | null;
  moveMode: boolean;
  movingTrap: string | null;
  message: string;
  activeEntrances: number;
  preview: Record<EnemyKind, number>;
  perks: string[];
  perkChoices: PerkDef[];
  stats: GameStats;
  stars: number;
}

export interface PerkDef {
  id: string;
  name: string;
  branch: string;
  text: string;
  color: string;
  prerequisite?: string;
  tier?: number;
}
