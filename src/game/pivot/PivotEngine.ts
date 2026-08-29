import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { Filter } from 'pixi.js';
import {
  BOARD_H, BOARD_W, BOARD_X, BOARD_Y, CELL, COLS, CONTROL_TUNING, ENEMIES, EXPAND_PRICES, FLOW_DENSITY_AVOIDANCE, FLOW_LANE_SPREAD, HEIGHT, HEART_HP, PERKS,
  RECYCLER_TARGETS, REROLL_PRICES, ROWS, SHOP_Y, STARTING_COINS, TIER_DAMAGE, TIER_ZONE, TRAPS, TRAP_IDS,
  WAVE_INCOME, WIDTH, buildWavePreview, enemyHpScale, trapActivationOffsets,
} from './config';
import { activeEntrances, activeFlowGates, activeSpawnPoints, buildFlowField, generateDungeon, mulberry32, revealedFloor, revealedMask, simulateTraffic } from './generator';
import type { TrafficSimulation } from './generator';
import type {
  DungeonStage, EnemyKind, EnemyState, GameSnapshot, PerkDef, Point, RunStats, TrapDef, TrapId, TrapItem, TrapTag, TrapTier,
} from './types';
import { createTierOutlineFilter } from './TierOutlineFilter';

type DragOrigin = { location: TrapItem['location']; origin?: Point; index?: number };
type DragState = { itemId: string; grab: Point; origin: DragOrigin; x: number; y: number; boardOrigin: Point | null; valid: boolean };
type Burst = { x: number; y: number; age: number; life: number; size: number; color: number; kind: 'ring' | 'burst' | 'coin' | 'shard' | 'reroll' };
type Beam = { x: number; y: number; x2: number; y2: number; age: number; life: number; color: number; width: number };
type Projectile = { kind: 'flame' | 'icicle' | 'cannon'; x: number; y: number; x2: number; y2: number; age: number; life: number; color: number };
type ZonePop = { itemId: string; text: string; age: number; delay: number };
type ItemMotion = { from: Point; to: Point; age: number; life: number };
type DustParticle = { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; color: number };
type RecycleFlight = { trapId: TrapId; from: Point; age: number; delay: number; life: number; arrived: boolean };
type DamagePop = { x: number; y: number; damage: number; age: number };

const enemyAsset: Record<EnemyKind, string> = {
  grunt: 'delver', runner: 'runner', flyer: 'wing', shieldbearer: 'shield', brute: 'brute',
};
const pkey = (p: Point) => `${p.x},${p.y}`;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const dirs: Point[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const rotatingTurretIds = ['flame', 'icicle', 'cannon'] as const;
type RotatingTurretId = typeof rotatingTurretIds[number];

function curvedRoutePoints(points: Point[], seed: number) {
  if (points.length < 2) return points;
  const result: Point[] = [points[0]], cornerRadius = CELL * .22;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], current = points[index], next = points[index + 1];
    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y) || 1;
    const outLength = Math.hypot(next.x - current.x, next.y - current.y) || 1;
    const before = { x: current.x - (current.x - previous.x) / inLength * cornerRadius, y: current.y - (current.y - previous.y) / inLength * cornerRadius };
    const after = { x: current.x + (next.x - current.x) / outLength * cornerRadius, y: current.y + (next.y - current.y) / outLength * cornerRadius };
    result.push(before);
    for (let step = 1; step <= 4; step++) {
      const t = step / 4, inverse = 1 - t;
      result.push({ x: inverse * inverse * before.x + 2 * inverse * t * current.x + t * t * after.x, y: inverse * inverse * before.y + 2 * inverse * t * current.y + t * t * after.y });
    }
  }
  result.push(points.at(-1)!);
  // A restrained sideways wave keeps long corridors organic too. Endpoints
  // stay locked to the portal and Heart, while the curve remains inside tiles.
  return result.map((point, index) => {
    if (!index || index === result.length - 1) return point;
    const previous = result[index - 1], next = result[index + 1], length = Math.hypot(next.x - previous.x, next.y - previous.y) || 1;
    const envelope = Math.sin(index / (result.length - 1) * Math.PI);
    const bend = Math.sin(index * .72 + seed * 1.91) * 3.5 * envelope;
    return { x: point.x - (next.y - previous.y) / length * bend, y: point.y + (next.x - previous.x) / length * bend };
  });
}

function pointOnRoute(points: Point[], progress: number) {
  const lengths: number[] = []; let total = 0;
  for (let index = 1; index < points.length; index++) { total += distance(points[index - 1], points[index]); lengths.push(total); }
  const target = clamp(progress, 0, 1) * total;
  let segment = lengths.findIndex(value => value >= target); if (segment < 0) segment = lengths.length - 1;
  const startLength = segment ? lengths[segment - 1] : 0, span = Math.max(.001, lengths[segment] - startLength), t = (target - startLength) / span;
  const from = points[segment], to = points[segment + 1];
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, angle: Math.atan2(to.y - from.y, to.x - from.x) };
}

function drawTierStar(g: Graphics, x: number, y: number, radius: number) {
  const points: number[] = [];
  for (let index = 0; index < 10; index++) {
    const angle = -Math.PI / 2 + index * Math.PI / 5, length = index % 2 ? radius * .46 : radius;
    points.push(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
  }
  g.poly(points).fill({ color: 0xffd45f, alpha: 1 }).stroke({ color: 0x5b3514, width: 2.2, alpha: 1 });
  g.circle(x - radius * .2, y - radius * .2, radius * .13).fill({ color: 0xfff3a6, alpha: .95 });
}
const turretArt: Record<RotatingTurretId, {
  asset: string; sheet: { width: number; height: number }; baseFrame: Rectangle; headFrame: Rectangle;
  baseAnchor: Point; headAnchor: Point; baseSize: Point; headSize: Point;
}> = {
  cannon: { asset: 'cannon-combat-parts-v1', sheet: { width: 1774, height: 887 }, baseFrame: new Rectangle(0, 0, 780, 887), headFrame: new Rectangle(780, 0, 994, 887), baseAnchor: { x: .54, y: .5 }, headAnchor: { x: .27, y: .5 }, baseSize: { x: 84, y: 100 }, headSize: { x: 115, y: 105 } },
  flame: { asset: 'flame-combat-parts-v1', sheet: { width: 1774, height: 887 }, baseFrame: new Rectangle(0, 0, 760, 887), headFrame: new Rectangle(760, 0, 1014, 887), baseAnchor: { x: .51, y: .5 }, headAnchor: { x: .24, y: .5 }, baseSize: { x: 86, y: 100 }, headSize: { x: 108, y: 104 } },
  icicle: { asset: 'icicle-combat-parts-v1', sheet: { width: 1536, height: 1024 }, baseFrame: new Rectangle(0, 0, 650, 1024), headFrame: new Rectangle(650, 0, 886, 1024), baseAnchor: { x: .49, y: .5 }, headAnchor: { x: .35, y: .47 }, baseSize: { x: 72, y: 92 }, headSize: { x: 98, y: 92 } },
};

const baseStats = (): RunStats => ({ killed: 0, leaked: 0, damageTaken: 0, trapDamage: {}, wavesCleared: 0, rerolls: 0, expands: 0, recycled: 0 });

export class PivotEngine {
  app = new Application();
  stage: DungeonStage;
  onSnapshot: (snapshot: GameSnapshot) => void;
  rand: () => number;

  root = new Container();
  backgroundLayer = new Graphics();
  terrainLayer = new Container();
  fogLayer = new Container();
  routeLayer = new Graphics();
  boardLayer = new Graphics();
  itemLayer = new Container();
  itemFrameLayer = new Graphics();
  tierBadgeLayer = new Graphics();
  synergyHintLayer = new Container();
  enemyLayer = new Container();
  portalLayer = new Container();
  portalGraphics = new Graphics();
  fxLayer = new Graphics();
  labelLayer = new Container();

  terrainTextures: Partial<Record<'wall' | 'floor' | 'heart' | 'fog', Texture>> = {};
  fogCloudTexture: Texture | null = null;
  fogCloudSprite: Sprite | null = null;
  trapTextures: Partial<Record<TrapId, Texture>> = {};
  combatTurretTextures: Partial<Record<RotatingTurretId, { base: Texture; head: Texture }>> = {};
  zoneArrowTexture: Texture | null = null;
  enemyFrames: Partial<Record<EnemyKind, Texture[]>> = {};
  terrainSprites = new Map<string, Sprite>();
  fogSprites = new Map<string, Sprite>();
  segmentSprites = new Map<string, Sprite>();
  turretBaseSprites = new Map<string, Sprite>();
  turretHeadSprites = new Map<string, Sprite>();
  synergyArrowSprites = new Map<string, Sprite>();
  enemySprites = new Map<number, Sprite>();
  portalIconSprites = new Map<string, Sprite>();
  portalCountTexts = new Map<number, Text>();

  phase: GameSnapshot['phase'] = 'prep';
  wave = 1;
  coins = STARTING_COINS;
  hp = HEART_HP;
  maxHp = HEART_HP;
  speed: 1 | 2 = 1;
  paused = false;
  expandCount = 0;
  rerollIndex = 0;
  recyclerPoints = 0;
  recyclerLevel = 0;
  freeRerolls = 0;
  items: TrapItem[] = [];
  selectedPerks: string[] = [];
  perkChoices: PerkDef[] = [];
  enemies: EnemyState[] = [];
  spawnQueue: EnemyState[] = [];
  nextItemId = 1;
  nextEnemyId = 1;
  drag: DragState | null = null;
  message = '';
  messageTimer = 0;
  victory: boolean | null = null;
  stats = baseStats();
  flow: number[][];
  flyFlow: number[][];
  gateFlows: number[][][] = [];
  bursts: Burst[] = [];
  beams: Beam[] = [];
  projectiles: Projectile[] = [];
  zonePops: ZonePop[] = [];
  segmentPulse = new Map<string, number>();
  trafficHeat = new Map<string, number>();
  trafficCoverage = new Map<string, number>();
  crowdBuckets = new Map<string, EnemyState[]>();
  routeSimulation: TrafficSimulation;
  damagePops = new Map<number, DamagePop>();
  boardFlash = new Map<string, { age: number; color: number }>();
  elapsed = 0;
  heartCooldown = 0;
  initialized = false;
  destroyed = false;
  snapshotTimer = 0;
  expandFx = 0;
  revealFog = new Map<string, number>();
  newPortalKeys = new Set<string>();
  portalPreviewHits: { x: number; y: number; kind: EnemyKind }[] = [];
  enemyHint: EnemyKind | null = null;
  pendingRecycleId: string | null = null;
  payoutTimer = -1;
  shopSlide = 0;
  shopSlideDelay = 0;
  itemMotions = new Map<string, ItemMotion>();
  dust: DustParticle[] = [];
  recycleFlights: RecycleFlight[] = [];
  turretAngles = new Map<string, number>();
  turretRecoil = new Map<string, number>();
  obstacleAvoidance = new Map<number, { itemId: string; side: -1 | 1 }>();
  tierFilters: Record<TrapTier, Filter[] | null> = { 1: null, 2: null, 3: null };

  constructor(seed: number, onSnapshot: (snapshot: GameSnapshot) => void, stage = generateDungeon(seed)) {
    this.stage = stage;
    this.onSnapshot = onSnapshot;
    this.rand = mulberry32(seed ^ 0x7f4a7c15);
    this.flow = buildFlowField(this.stage, 0);
    this.flyFlow = buildFlowField(this.stage, 0, true);
    this.gateFlows = activeFlowGates(this.stage, 0).map(gate => buildFlowField(this.stage, 0, false, gate));
    this.routeSimulation = simulateTraffic(this.stage, 0);
    this.addShopBatch();
  }

  async mount(host: HTMLElement) {
    await this.app.init({ width: WIDTH, height: HEIGHT, backgroundColor: 0x15111b, antialias: true, resolution: Math.min(devicePixelRatio, 2), autoDensity: true });
    this.tierFilters[2] = [createTierOutlineFilter(0x83f06a, 2.4, .42)];
    this.tierFilters[3] = [createTierOutlineFilter(0x4eddf5, 3.1, .56)];
    const terrainEntries = await Promise.all((['wall', 'floor', 'heart', 'fog'] as const).map(async kind => [kind, await Assets.load<Texture>(`/assets/terrain/pivot-${kind === 'wall' ? 'rock-v2' : kind === 'floor' ? 'floor-v2' : `${kind}-v1`}.png`)] as const));
    for (const [kind, texture] of terrainEntries) this.terrainTextures[kind] = texture;
    const fogSource = this.terrainTextures.fog;
    if (fogSource) this.fogCloudTexture = new Texture({ source: fogSource.source, frame: new Rectangle(0, 0, Math.max(1, fogSource.width - 38), fogSource.height) });
    const trapEntries = await Promise.all(TRAP_IDS.map(async id => [id, await Assets.load<Texture>(`/assets/traps/${TRAPS[id].assetId}.png`)] as const));
    for (const [id, texture] of trapEntries) this.trapTextures[id] = texture;
    const combatTurretEntries = await Promise.all(rotatingTurretIds.map(async id => [id, await Assets.load<Texture>(`/assets/traps/combat/${turretArt[id].asset}.png`)] as const));
    for (const [id, sheet] of combatTurretEntries) this.combatTurretTextures[id] = {
      base: new Texture({ source: sheet.source, frame: turretArt[id].baseFrame }),
      head: new Texture({ source: sheet.source, frame: turretArt[id].headFrame }),
    };
    this.zoneArrowTexture = await Assets.load<Texture>('/assets/ui/zone-up.svg');
    const enemyEntries = await Promise.all((Object.keys(ENEMIES) as EnemyKind[]).map(async kind => {
      const sheet = await Assets.load<Texture>(`/assets/enemies/${enemyAsset[kind]}-sheet-v2.png`);
      const frameWidth = sheet.width / 4;
      return [kind, Array.from({ length: 4 }, (_, index) => new Texture({ source: sheet.source, frame: new Rectangle(index * frameWidth, 0, frameWidth, sheet.height) }))] as const;
    }));
    for (const [kind, frames] of enemyEntries) this.enemyFrames[kind] = frames;
    if (this.destroyed) return;
    this.initialized = true;
    this.app.canvas.className = 'game-canvas';
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    // The item-frame layer also paints the shop tray. Keep it below item sprites so
    // the tray never masks the traps it is meant to present.
    this.root.addChild(this.backgroundLayer, this.terrainLayer, this.fogLayer, this.boardLayer, this.itemFrameLayer, this.itemLayer, this.tierBadgeLayer, this.routeLayer, this.synergyHintLayer, this.portalLayer, this.enemyLayer, this.fxLayer, this.labelLayer);
    this.itemLayer.sortableChildren = true;
    this.portalLayer.addChild(this.portalGraphics);
    this.app.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.app.ticker.maxFPS = 30;
    this.app.ticker.add(this.tick);
    (window as Window & { __BACKPACK_DUNGEON__?: PivotEngine }).__BACKPACK_DUNGEON__ = this;
    this.drawBackground(); this.drawTerrain();
    this.emit();
  }

  destroy() {
    this.destroyed = true;
    if (!this.initialized) return;
    this.app.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    const debug = window as Window & { __BACKPACK_DUNGEON__?: PivotEngine };
    if (debug.__BACKPACK_DUNGEON__ === this) delete debug.__BACKPACK_DUNGEON__;
    this.app.destroy(true, { children: true });
  }

  private drawBackground() {
    const g = this.backgroundLayer; g.clear();
    g.rect(0, 0, WIDTH, HEIGHT).fill({ color: 0x100d15 });
    g.rect(0, SHOP_Y, WIDTH, HEIGHT - SHOP_Y).fill({ color: 0x17131e });
    for (let row = 0; row < 5; row++) for (let col = 0; col < 7; col++) {
      const offset = row % 2 ? -44 : 0, x = col * 108 + offset, y = SHOP_Y + row * 88;
      g.roundRect(x + 4, y + 5, 100, 78, 16).fill({ color: (row + col) % 2 ? 0x28212d : 0x211b27, alpha: .54 }).stroke({ color: 0x44344a, width: 2, alpha: .28 });
    }
    g.moveTo(0, SHOP_Y + 1).lineTo(WIDTH, SHOP_Y + 1).stroke({ color: 0x7b5b73, width: 3, alpha: .45 });
    g.circle(WIDTH / 2, SHOP_Y + 134, 54).stroke({ color: 0x6f4c7d, width: 3, alpha: .11 });
    g.moveTo(WIDTH / 2, SHOP_Y + 95).lineTo(WIDTH / 2 + 34, SHOP_Y + 153).lineTo(WIDTH / 2 - 34, SHOP_Y + 153).closePath().stroke({ color: 0x9b6baa, width: 4, alpha: .09 });
  }

  get shop() { return this.items.filter(item => item.location === 'shop'); }
  get boardItems() { return this.items.filter(item => item.location === 'board'); }
  get hold() { return this.items.find(item => item.location === 'hold') ?? null; }
  get entrances() { return activeEntrances(this.stage, this.expandCount); }
  get spawnPoints() { return activeSpawnPoints(this.stage, this.expandCount); }
  get gates() { return activeFlowGates(this.stage, this.expandCount); }
  get revealedFloorSet() { return revealedFloor(this.stage, this.expandCount); }
  get revealedMaskSet() { return revealedMask(this.stage, this.expandCount); }
  get rerollCost() { return REROLL_PRICES[Math.min(this.rerollIndex, REROLL_PRICES.length - 1)]; }
  get expandCost() { return this.expandCount < EXPAND_PRICES.length ? EXPAND_PRICES[this.expandCount] : null; }
  get recyclerTarget() { return RECYCLER_TARGETS[Math.min(this.recyclerLevel, RECYCLER_TARGETS.length - 1)] + Math.max(0, this.recyclerLevel - RECYCLER_TARGETS.length + 1) * 2; }

  get preview(): Record<EnemyKind, number> {
    return buildWavePreview(this.stage.archetype, this.wave);
  }

  private distributedRoster() {
    const entranceCount = Math.max(1, this.entrances.length);
    const kinds = (Object.entries(this.preview) as [EnemyKind, number][]).flatMap(([kind, count]) => Array.from({ length: count }, () => kind));
    const rosterRand = mulberry32(this.stage.seed ^ (this.wave * 0x9e3779b1) ^ (this.expandCount * 0x85ebca6b));
    for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(rosterRand() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
    const groups = Array.from({ length: entranceCount }, () => [] as EnemyKind[]);
    kinds.forEach((kind, index) => groups[index % entranceCount].push(kind));
    return groups;
  }

  getSnapshot(): GameSnapshot {
    return {
      phase: this.phase, wave: this.wave, coins: this.coins, hp: Math.max(0, Math.ceil(this.hp)), maxHp: this.maxHp,
      speed: this.speed, paused: this.paused, enemyCount: this.enemies.filter(enemy => !enemy.dead).length,
      shop: this.shop, hold: this.hold, selectedPerks: [...this.selectedPerks], perkChoices: this.perkChoices,
      rerollCost: this.rerollCost, rerollFree: this.freeRerolls > 0, freeRerolls: this.freeRerolls,
      recyclerPoints: this.recyclerPoints, recyclerTarget: this.recyclerTarget, expandCost: this.expandCost, expandCount: this.expandCount,
      activeEntrances: this.entrances, preview: this.preview, dragging: this.drag ? this.items.find(item => item.id === this.drag!.itemId) ?? null : null,
      dragZoneBonus: this.drag?.boardOrigin ? this.zoneBonus(this.items.find(item => item.id === this.drag!.itemId)!, this.drag.boardOrigin) : 0,
      message: this.message, enemyHint: this.enemyHint,
      recycleConfirm: this.pendingRecycleId ? this.items.find(item => item.id === this.pendingRecycleId) ?? null : null,
      shopTransitioning: this.phase !== 'prep' && this.shopSlide < 1,
      stats: this.stats, victory: this.victory,
    };
  }

  enemyDefinition(kind: EnemyKind) { return ENEMIES[kind]; }
  enemyAssetName(kind: EnemyKind) { return enemyAsset[kind]; }
  closeEnemyHint() { this.enemyHint = null; this.emit(); }

  cancelRecycle() { this.pendingRecycleId = null; this.emit(); }
  confirmRecycle() {
    const item = this.pendingRecycleId ? this.items.find(value => value.id === this.pendingRecycleId) : null;
    this.pendingRecycleId = null;
    if (item) { this.recycleItem(item); this.showMessage('Trap recycled'); }
    this.emit();
  }

  emit() { this.onSnapshot(this.getSnapshot()); }

  private showMessage(text: string, duration = 1.2) { this.message = text; this.messageTimer = duration; }

  private createItem(trapId: TrapId): TrapItem {
    return { id: `item-${this.nextItemId++}`, trapId, tier: 1, location: 'shop', cooldowns: TRAPS[trapId].shape.map(() => this.rand() * .25) };
  }

  private trapOfferWeight(trapId: TrapId) {
    const candidate = TRAPS[trapId], candidateTags: TrapTag[] = [candidate.element, ...(candidate.family ? [candidate.family] : [])];
    let weight = 1;
    for (const item of this.boardItems) {
      const present = TRAPS[item.trapId], presentTags: TrapTag[] = [present.element, ...(present.family ? [present.family] : [])];
      if (present.zone && candidateTags.includes(present.zone.checks)) weight += .34;
      if (candidate.zone && presentTags.includes(candidate.zone.checks)) weight += .24;
      if (item.trapId === trapId) weight += .14;
    }
    return Math.min(2.35, weight);
  }

  private rollTrapId() {
    const weights = TRAP_IDS.map(id => this.trapOfferWeight(id)), total = weights.reduce((sum, value) => sum + value, 0);
    let roll = this.rand() * total;
    for (let index = 0; index < TRAP_IDS.length; index++) { roll -= weights[index]; if (roll <= 0) return TRAP_IDS[index]; }
    return TRAP_IDS.at(-1)!;
  }

  private addShopBatch() {
    for (let index = 0; index < 3; index++) this.items.push(this.createItem(this.rollTrapId()));
  }

  reroll() {
    if (this.phase !== 'prep' || this.drag) return;
    if (this.freeRerolls > 0) this.freeRerolls--;
    else {
      if (this.coins < this.rerollCost) { this.showMessage('Not enough coins', 1); this.emit(); return; }
      this.coins -= this.rerollCost; this.rerollIndex++;
    }
    this.stats.rerolls++;
    this.recycleShop();
    this.addShopBatch();
    this.showMessage('Fresh traps arrived');
    this.emit();
  }

  expand() {
    if (this.phase !== 'prep' || this.drag || this.expandCost == null) return;
    if (this.coins < this.expandCost) { this.showMessage('Not enough coins', 1); this.emit(); return; }
    const beforeMask = this.revealedMaskSet;
    const beforeSpawns = new Set(this.spawnPoints.map(pkey));
    this.coins -= this.expandCost; this.expandCount++; this.stats.expands++;
    this.flow = buildFlowField(this.stage, this.expandCount);
    this.flyFlow = buildFlowField(this.stage, this.expandCount, true);
    this.gateFlows = this.gates.map(gate => buildFlowField(this.stage, this.expandCount, false, gate));
    this.routeSimulation = simulateTraffic(this.stage, this.expandCount);
    const newCells = [...this.revealedMaskSet].filter(value => !beforeMask.has(value));
    const focus = this.stage.revealPlan[this.expandCount - 1]?.cells[0] ?? this.stage.heartOrigin;
    this.revealFog = new Map(newCells.map(value => {
      const [x, y] = value.split(',').map(Number);
      return [value, -Math.min(.22, Math.hypot(x - focus.x, y - focus.y) * .035)];
    }));
    this.dust = [];
    for (const value of newCells) {
      const [x, y] = value.split(',').map(Number), cx = BOARD_X + (x + .5) * CELL, cy = BOARD_Y + (y + .5) * CELL;
      for (let index = 0; index < 2; index++) this.dust.push({
        x: cx + (this.rand() - .5) * CELL * .7, y: cy + (this.rand() - .5) * CELL * .65,
        vx: (this.rand() - .5) * 46, vy: -22 - this.rand() * 48, age: -this.rand() * .22,
        life: .58 + this.rand() * .42, size: 3 + this.rand() * 6, color: this.stage.fullGrid[y][x] === 'wall' ? 0xb39a78 : 0xe1c497,
      });
    }
    this.newPortalKeys = new Set(this.spawnPoints.map(pkey).filter(value => !beforeSpawns.has(value)));
    this.expandFx = 1.15;
    this.drawTerrain();
    this.showMessage('The dungeon grows');
    this.emit();
  }

  battle() {
    if (this.phase !== 'prep' || this.drag) return;
    this.recycleShop();
    this.phase = 'combat'; this.paused = false; this.enemies = []; this.spawnQueue = []; this.trafficHeat.clear(); this.trafficCoverage.clear(); this.obstacleAvoidance.clear();
    const entrances = this.entrances, spawnPoints = this.spawnPoints, groups = this.distributedRoster();
    const queue: { kind: EnemyKind; entrance: number }[] = [];
    const longest = Math.max(...groups.map(group => group.length));
    for (let row = 0; row < longest; row++) groups.forEach((group, entrance) => { if (group[row]) queue.push({ kind: group[row], entrance }); });
    const hpScale = enemyHpScale(this.wave);
    queue.forEach(({ kind, entrance }, index) => {
      const def = ENEMIES[kind], point = spawnPoints[entrance] ?? entrances[entrance];
      this.spawnQueue.push({
        id: this.nextEnemyId++, kind, x: BOARD_X + (point.x + .5) * CELL, y: BOARD_Y + (point.y + .5) * CELL,
        vx: 0, vy: 0, hp: def.hp * hpScale, maxHp: def.hp * hpScale, spawnDelay: index * .05, emerging: true,
        entrance, gateIndex: 0, laneBias: this.rand() * 2 - 1, burnDps: 0, burnTime: 0, burnSourceId: null, slow: 0, slowTime: 0, frostSourceId: null,
        vulnerable: 0, vulnerableTime: 0, hardControlLevel: 0, hardControlWindow: 0, hardControlImmune: 0,
        noProgressTime: 0, bestFlowDistance: Infinity, impulseTime: 0, airborneTime: 0, airborneDuration: 0, impactDamage: 0, impactRadius: 0, impactSourceId: null, impulseSourceId: null, launched: false, collisionSpent: false, dead: false,
      });
    });
    this.enemies = this.spawnQueue;
    this.payoutTimer = -1;
    this.shopSlide = .001;
    this.shopSlideDelay = .58;
    this.enemyHint = null;
    this.message = ''; this.messageTimer = 0;
    this.emit();
  }

  togglePause() { if (this.phase === 'combat') { this.paused = !this.paused; this.emit(); } }
  toggleSpeed() { if (this.phase === 'combat') { this.speed = this.speed === 1 ? 2 : 1; this.emit(); } }
  pauseForOverlay(value: boolean) { if (this.phase === 'combat') { this.paused = value; this.emit(); } }

  choosePerk(id: string) {
    if (this.phase !== 'perk') return;
    const chosen = this.perkChoices.find(perk => perk.id === id);
    if (!chosen) return;
    this.selectedPerks.push(id);
    const color = chosen.rarity === 'rare' ? 0x46a8ff : chosen.rarity === 'epic' ? 0xbe52ff : 0xff9b35;
    for (const item of this.boardItems) if (this.perkApplies(chosen, item)) this.boardFlash.set(item.id, { age: 0, color });
    this.perkChoices = [];
    this.wave++;
    this.phase = 'prep';
    this.shopSlide = 0;
    this.addShopBatch();
    this.showMessage('Rebuild your defense');
    this.emit();
  }

  retry() {
    const currentStage = this.stage;
    this.phase = 'prep'; this.wave = 1; this.coins = STARTING_COINS; this.hp = HEART_HP; this.maxHp = HEART_HP;
    this.expandCount = 0; this.rerollIndex = 0; this.recyclerPoints = 0; this.recyclerLevel = 0; this.freeRerolls = 0;
    this.items = []; this.selectedPerks = []; this.perkChoices = []; this.enemies = []; this.spawnQueue = []; this.dust = []; this.recycleFlights = []; this.itemMotions.clear(); this.obstacleAvoidance.clear();
    this.enemyHint = null; this.pendingRecycleId = null; this.revealFog.clear(); this.newPortalKeys.clear(); this.payoutTimer = -1; this.shopSlide = 0; this.shopSlideDelay = 0; this.message = ''; this.messageTimer = 0;
    this.stats = baseStats(); this.victory = null; this.stage = currentStage; this.flow = buildFlowField(this.stage, 0); this.flyFlow = buildFlowField(this.stage, 0, true); this.gateFlows = activeFlowGates(this.stage, 0).map(gate => buildFlowField(this.stage, 0, false, gate)); this.routeSimulation = simulateTraffic(this.stage, 0);
    this.addShopBatch(); this.drawTerrain(); this.emit();
  }

  affectedCount(perk: PerkDef) { return this.boardItems.filter(item => this.perkApplies(perk, item)).length; }
  trapPerkCount(item: TrapItem) { return this.selectedPerks.map(id => PERKS.find(perk => perk.id === id)!).filter(perk => perk && this.perkApplies(perk, item)).length; }
  getItemDamage(item: TrapItem, origin = item.origin) {
    const def = TRAPS[item.trapId];
    const perkBonus = this.selectedPerks.map(id => PERKS.find(perk => perk.id === id)).filter((perk): perk is PerkDef => !!perk && this.perkApplies(perk, item)).reduce((sum, perk) => sum + (perk.damageBonus ?? 0), 0);
    return def.damage * TIER_DAMAGE[item.tier] * (1 + perkBonus) * (1 + (origin ? this.zoneBonus(item, origin) : 0));
  }
  getItemArea(item: TrapItem, origin = item.origin) {
    const def = TRAPS[item.trapId], zone = def.zone;
    const bonus = zone?.areaPerCell && origin ? this.zoneMatchCount(item, origin) * zone.areaPerCell * TIER_ZONE[item.tier] : 0;
    return def.area * (1 + bonus);
  }
  getItemRange(item: TrapItem, origin = item.origin) {
    const def = TRAPS[item.trapId], zone = def.zone;
    const bonus = zone?.rangePerCell && origin ? this.zoneMatchCount(item, origin) * zone.rangePerCell * TIER_ZONE[item.tier] : 0;
    return def.range * (1 + bonus);
  }
  getItemCooldown(item: TrapItem) {
    const def = TRAPS[item.trapId];
    return this.selectedPerks.map(id => PERKS.find(perk => perk.id === id)).filter((perk): perk is PerkDef => !!perk && this.perkApplies(perk, item)).reduce((value, perk) => value * (perk.cooldownMultiplier ?? 1), def.cooldown);
  }

  private perkApplies(perk: PerkDef, item: TrapItem) {
    return perk.scope.element === TRAPS[item.trapId].element;
  }

  private selectedMechanic(mechanic: string, item?: TrapItem) {
    return this.selectedPerks.some(id => { const perk = PERKS.find(value => value.id === id); return perk?.mechanic === mechanic && (!item || this.perkApplies(perk, item)); });
  }

  private recycleShop() {
    const shop = [...this.shop], centers = this.itemCenters();
    shop.forEach((item, index) => {
      const from = centers.get(item.id); if (from) this.recycleFlights.push({ trapId: item.trapId, from: { ...from }, age: 0, delay: index * .075, life: .38, arrived: false });
      this.recycleItem(item, false);
    });
  }

  private recycleItem(item: TrapItem, remove = true) {
    if (remove) this.items = this.items.filter(other => other.id !== item.id);
    else this.items.splice(this.items.indexOf(item), 1);
    this.recyclerPoints++; this.stats.recycled++;
    while (this.recyclerPoints >= this.recyclerTarget) {
      this.recyclerPoints -= this.recyclerTarget; this.recyclerLevel++; this.freeRerolls++;
      this.bursts.push({ x: 64, y: 1100, age: 0, life: .7, size: 55, color: 0xff9f42, kind: 'burst' });
      this.bursts.push({ x: 64, y: 1100, age: 0, life: .72, size: 22, color: 0x64ef87, kind: 'reroll' });
    }
  }

  private pointFromEvent(event: PointerEvent) {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * WIDTH / rect.width, y: (event.clientY - rect.top) * HEIGHT / rect.height };
  }

  private itemCenters() {
    const result = new Map<string, Point>();
    const draggedId = this.drag?.itemId;
    const shop = this.shop.filter(item => item.id !== draggedId), left = 175, right = 545;
    // Keep shop silhouettes clearly above the wallet/actions dock on short phones.
    shop.forEach((item, index) => result.set(item.id, { x: shop.length === 1 ? 360 : left + (right - left) * index / Math.max(1, shop.length - 1), y: 1090 }));
    if (this.hold && this.hold.id !== draggedId) result.set(this.hold.id, { x: 655, y: 1094 });
    for (const item of this.boardItems) if (item.origin && item.id !== draggedId) {
      const def = TRAPS[item.trapId], maxX = Math.max(...def.shape.map(p => p.x)), maxY = Math.max(...def.shape.map(p => p.y));
      result.set(item.id, { x: BOARD_X + (item.origin.x + (maxX + 1) / 2) * CELL, y: BOARD_Y + (item.origin.y + (maxY + 1) / 2) * CELL });
    }
    if (this.drag) result.set(this.drag.itemId, { x: this.drag.x, y: this.drag.y });
    return result;
  }

  private animateLayout(before: Map<string, Point>, after: Map<string, Point>, life = .2) {
    for (const [id, to] of after) {
      const from = before.get(id); if (!from || distance(from, to) < 2) continue;
      this.itemMotions.set(id, { from: { ...from }, to: { ...to }, age: 0, life });
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    if (this.phase !== 'prep' || this.drag || this.pendingRecycleId) return;
    const point = this.pointFromEvent(event), centers = this.itemCenters();
    const previewHit = [...this.portalPreviewHits].sort((a, b) => distance(a, point) - distance(b, point))[0];
    if (previewHit && distance(previewHit, point) < 29) {
      this.enemyHint = this.enemyHint === previewHit.kind ? null : previewHit.kind;
      this.emit();
      return;
    }
    this.enemyHint = null;
    const candidates = this.items.map(item => ({ item, center: centers.get(item.id)! })).filter(entry => entry.center && distance(entry.center, point) < (entry.item.location === 'board' ? 58 : 72));
    candidates.sort((a, b) => distance(a.center, point) - distance(b.center, point));
    const hit = candidates[0];
    if (!hit) return;
    event.preventDefault();
    const beforeLayout = this.itemCenters();
    const item = hit.item, def = TRAPS[item.trapId];
    const boardCell = item.origin ? { x: Math.floor((point.x - BOARD_X) / CELL), y: Math.floor((point.y - BOARD_Y) / CELL) } : null;
    const grab = boardCell && item.origin ? { x: clamp(boardCell.x - item.origin.x, 0, Math.max(...def.shape.map(p => p.x))), y: clamp(boardCell.y - item.origin.y, 0, Math.max(...def.shape.map(p => p.y))) } : { x: 0, y: 0 };
    this.drag = { itemId: item.id, grab, origin: { location: item.location, origin: item.origin ? { ...item.origin } : undefined, index: this.shop.indexOf(item) }, x: point.x, y: point.y, boardOrigin: null, valid: false };
    this.updateDrag(point);
    this.animateLayout(beforeLayout, this.itemCenters(), .16);
    this.emit();
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.drag) return;
    event.preventDefault(); this.updateDrag(this.pointFromEvent(event));
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.drag) return;
    const point = this.pointFromEvent(event), drag = this.drag, item = this.items.find(value => value.id === drag.itemId);
    if (!item) { this.drag = null; return; }
    const beforeZones = new Map(this.boardItems.map(boardItem => [boardItem.id, this.zoneMatchCount(boardItem)]));
    const beforeLayout = this.itemCenters();
    const mergeTarget = this.mergeTargetAt(point, item);
    if (mergeTarget) this.performMerge(item, mergeTarget);
    else if (point.x < 112 && point.y > SHOP_Y + 20) {
      if (item.tier > 1) this.pendingRecycleId = item.id;
      else this.recycleItem(item);
    }
    else if (point.x > 610 && point.y > SHOP_Y + 15) this.dropHold(item);
    else if (drag.boardOrigin && drag.valid) this.dropBoard(item, drag.boardOrigin);
    else if (point.y > SHOP_Y) this.dropShop(item);
    this.drag = null;
    this.animateLayout(beforeLayout, this.itemCenters());
    this.celebrateZoneChanges(beforeZones);
    this.emit();
  };

  private updateDrag(point: Point) {
    if (!this.drag) return;
    this.drag.x = point.x; this.drag.y = point.y;
    if (point.x >= BOARD_X && point.x < BOARD_X + BOARD_W && point.y >= BOARD_Y && point.y < BOARD_Y + BOARD_H) {
      const item = this.items.find(value => value.id === this.drag!.itemId)!;
      const def = TRAPS[item.trapId];
      const shapeWidth = Math.max(...def.shape.map(offset => offset.x)) + 1;
      const shapeHeight = Math.max(...def.shape.map(offset => offset.y)) + 1;
      // Snap the rendered trap and its placement preview from the same centre.
      // Previously the sprite followed the pointer while the preview followed the
      // originally grabbed cell, making multi-cell traps appear one cell off.
      const origin = {
        x: Math.round((point.x - BOARD_X) / CELL - shapeWidth / 2),
        y: Math.round((point.y - BOARD_Y) / CELL - shapeHeight / 2),
      };
      this.drag.boardOrigin = origin; this.drag.valid = this.canPlace(item, origin);
      this.drag.x = BOARD_X + (origin.x + shapeWidth / 2) * CELL;
      this.drag.y = BOARD_Y + (origin.y + shapeHeight / 2) * CELL;
    } else { this.drag.boardOrigin = null; this.drag.valid = false; }
    this.emit();
  }

  private canPlace(item: TrapItem, origin: Point) {
    const def = TRAPS[item.trapId], floor = this.revealedFloorSet;
    return def.shape.every(offset => {
      const cell = { x: origin.x + offset.x, y: origin.y + offset.y };
      if (cell.x < 0 || cell.y < 0 || cell.x >= COLS || cell.y >= ROWS) return false;
      return this.stage.fullGrid[cell.y][cell.x] === 'floor' && floor.has(pkey(cell));
    });
  }

  private overlappingItems(item: TrapItem, origin: Point) {
    const cells = new Set(TRAPS[item.trapId].shape.map(p => `${origin.x + p.x},${origin.y + p.y}`));
    return this.boardItems.filter(other => other.id !== item.id && other.origin && TRAPS[other.trapId].shape.some(p => cells.has(`${other.origin!.x + p.x},${other.origin!.y + p.y}`)));
  }

  private dropBoard(item: TrapItem, origin: Point) {
    const displacedItems = this.overlappingItems(item, origin);
    for (const displaced of displacedItems) { displaced.location = 'shop'; displaced.origin = undefined; }
    item.location = 'board'; item.origin = { ...origin };
    item.cooldowns = TRAPS[item.trapId].shape.map((_, index) => item.cooldowns[index] ?? 0);
    if (displacedItems.length) this.showMessage(`${displacedItems.length} trap${displacedItems.length > 1 ? 's' : ''} returned to the tray`, 2);
  }

  private dropShop(item: TrapItem) { item.location = 'shop'; item.origin = undefined; }
  private dropHold(item: TrapItem) {
    const held = this.hold;
    if (held && held.id !== item.id) { held.location = item.location; held.origin = item.origin ? { ...item.origin } : undefined; }
    item.location = 'hold'; item.origin = undefined;
  }

  private mergeTargetAt(point: Point, source: TrapItem) {
    if (source.tier >= 3) return null;
    const centers = this.itemCenters();
    return this.items.filter(item => item.id !== source.id && item.trapId === source.trapId && item.tier === source.tier)
      .map(item => ({ item, d: distance(centers.get(item.id)!, point) })).filter(entry => entry.d < 76).sort((a, b) => a.d - b.d)[0]?.item ?? null;
  }

  private performMerge(source: TrapItem, target: TrapItem) {
    const centersBefore = this.itemCenters();
    const sourceCenter = centersBefore.get(source.id) ?? { x: this.drag?.x ?? 360, y: this.drag?.y ?? 600 };
    const targetCenter = centersBefore.get(target.id) ?? { x: 360, y: 600 };
    this.items = this.items.filter(item => item.id !== source.id);
    target.tier = (target.tier + 1) as TrapTier;
    target.cooldowns = TRAPS[target.trapId].shape.map(() => 0);
    TRAPS[target.trapId].shape.forEach((_, index) => this.segmentPulse.set(`${target.id}:${index}`, .28));
    this.bursts.push({ x: sourceCenter.x, y: sourceCenter.y, age: 0, life: .32, size: 40, color: 0xffcf55, kind: 'ring' });
    this.bursts.push({ x: targetCenter.x, y: targetCenter.y, age: 0, life: .55, size: 70, color: 0xffcf55, kind: 'burst' });
  }

  private trapTags(item: TrapItem): TrapTag[] {
    const def = TRAPS[item.trapId];
    return [def.element, ...(def.family ? [def.family] : [])];
  }

  hasZoneSynergy(source: TrapItem, target: TrapItem) {
    const sourceZone = TRAPS[source.trapId].zone, targetZone = TRAPS[target.trapId].zone;
    return !!(
      (sourceZone && this.trapTags(target).includes(sourceZone.checks))
      || (targetZone && this.trapTags(source).includes(targetZone.checks))
    );
  }

  zoneCells(item: TrapItem, origin = item.origin) {
    if (!origin) return [];
    const occupied = new Set(TRAPS[item.trapId].shape.map(p => `${origin.x + p.x},${origin.y + p.y}`));
    const zone = new Map<string, Point>();
    for (const offset of TRAPS[item.trapId].shape) for (const dir of dirs) {
      const cell = { x: origin.x + offset.x + dir.x, y: origin.y + offset.y + dir.y };
      if (cell.x >= 0 && cell.y >= 0 && cell.x < COLS && cell.y < ROWS && !occupied.has(pkey(cell))) zone.set(pkey(cell), cell);
    }
    return [...zone.values()];
  }

  zoneMatchCount(item: TrapItem, origin = item.origin) {
    const zone = TRAPS[item.trapId].zone;
    if (!zone || !origin) return 0;
    const zoneKeys = new Set(this.zoneCells(item, origin).map(pkey));
    let count = 0;
    for (const other of this.boardItems) if (other.id !== item.id && other.origin && this.trapTags(other).includes(zone.checks)) {
      for (const offset of TRAPS[other.trapId].shape) if (zoneKeys.has(`${other.origin.x + offset.x},${other.origin.y + offset.y}`)) count++;
    }
    return count;
  }

  zoneBonus(item: TrapItem, origin = item.origin) {
    const zone = TRAPS[item.trapId].zone;
    if (!zone) return 0;
    return this.zoneMatchCount(item, origin) * zone.damagePerCell * TIER_ZONE[item.tier];
  }

  private celebrateZoneChanges(before: Map<string, number>) {
    this.zonePops = [];
    for (const item of this.boardItems) {
      const def = TRAPS[item.trapId], zone = def.zone, current = this.zoneMatchCount(item), previous = before.get(item.id) ?? 0;
      if (!zone || current <= previous) continue;
      const delta = current * TIER_ZONE[item.tier];
      const messages = [`+${Math.round(delta * zone.damagePerCell * 100)}% DMG`];
      if (zone.areaPerCell) messages.push(`+${Math.round(delta * zone.areaPerCell * 100)}% AREA`);
      if (zone.rangePerCell) messages.push(`+${Math.round(delta * zone.rangePerCell * 100)}% RANGE`);
      messages.forEach((text, index) => this.zonePops.push({ itemId: item.id, text, age: 0, delay: index * .5 }));
    }
  }

  private drawTerrain() {
    if (!this.initialized) return;
    this.terrainLayer.removeChildren().forEach(child => child.destroy()); this.fogLayer.removeChildren().forEach(child => child.destroy()); this.terrainSprites.clear(); this.fogSprites.clear();
    this.fogCloudSprite = null;
    const visible = this.revealedMaskSet, activeFloor = this.revealedFloorSet;
    const wallTexture = this.terrainTextures.wall;
    if (wallTexture) {
      // One continuous low-frequency mass: repeating the rock bitmap per cell
      // reintroduced a false wall grid even when the source art itself was quiet.
      const wallBackdrop = new Sprite(wallTexture);
      wallBackdrop.x = BOARD_X; wallBackdrop.y = BOARD_Y; wallBackdrop.width = BOARD_W; wallBackdrop.height = BOARD_H;
      wallBackdrop.tint = 0x626b76; wallBackdrop.alpha = .78;
      this.terrainLayer.addChild(wallBackdrop); this.terrainSprites.set('__wall', wallBackdrop);
    }
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const value = `${x},${y}`, cell = this.stage.fullGrid[y][x];
      const shown = cell === 'heart' || activeFloor.has(value) || (cell === 'wall' && visible.has(value));
      if (cell === 'heart') continue;
      // Future floor does not exist visually until its reveal step. Drawing it
      // dimly under fog leaks the authored topology through colour and seams.
      if (cell === 'floor' && activeFloor.has(value) && this.terrainTextures.floor) {
        const sprite = new Sprite(this.terrainTextures.floor); sprite.x = BOARD_X + x * CELL; sprite.y = BOARD_Y + y * CELL; sprite.width = CELL; sprite.height = CELL;
        sprite.tint = 0xfff4df; sprite.alpha = 1;
        this.terrainLayer.addChild(sprite); this.terrainSprites.set(value, sprite);
      }
      if (!shown || this.revealFog.has(value)) {
        // An opaque base guarantees secrecy; the masked cloud layer above it
        // supplies motion and texture without exposing future terrain.
        const fog = new Sprite(Texture.WHITE);
        fog.x = BOARD_X + x * CELL; fog.y = BOARD_Y + y * CELL; fog.width = CELL; fog.height = CELL;
        fog.tint = 0x111a2a; fog.alpha = !shown || this.revealFog.has(value) ? .88 : 0;
        this.fogLayer.addChild(fog); this.fogSprites.set(value, fog);
      }
    }
    if (this.fogCloudTexture) {
      const mask = new Graphics();
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        const value = `${x},${y}`, cell = this.stage.fullGrid[y][x];
        const shown = cell === 'heart' || activeFloor.has(value) || (cell === 'wall' && visible.has(value));
        if (!shown) mask.rect(BOARD_X + x * CELL, BOARD_Y + y * CELL, CELL, CELL);
      }
      mask.fill(0xffffff);
      const cloud = new Sprite(this.fogCloudTexture); cloud.anchor.set(.5);
      cloud.x = BOARD_X + BOARD_W / 2; cloud.y = BOARD_Y + BOARD_H / 2;
      cloud.width = BOARD_W * 1.18; cloud.height = BOARD_H * 1.12;
      cloud.tint = 0x8fa9ff; cloud.alpha = .78; cloud.mask = mask;
      this.fogLayer.addChild(cloud, mask); this.fogCloudSprite = cloud;
    }
    const heart = this.stage.heartOrigin, heartTexture = this.terrainTextures.heart;
    if (heartTexture) {
      const sprite = new Sprite(heartTexture);
      sprite.x = BOARD_X + heart.x * CELL; sprite.y = BOARD_Y + heart.y * CELL;
      sprite.width = CELL * 2; sprite.height = CELL * 2;
      this.terrainLayer.addChild(sprite);
    }
  }

  private tick = (ticker: { deltaMS: number }) => {
    if (this.destroyed) return;
    const rawDt = Math.min(.05, ticker.deltaMS / 1000), dt = rawDt * (this.phase === 'combat' && !this.paused ? this.speed : 1);
    this.elapsed += rawDt;
    if (this.phase === 'combat' && !this.paused) this.updateCombat(dt);
    this.updateFx(rawDt);
    this.drawFrame();
    this.snapshotTimer += rawDt;
    if (this.snapshotTimer > .18) { this.snapshotTimer = 0; this.emit(); }
  };

  private updateCombat(dt: number) {
    for (const [cell, heat] of this.trafficHeat) {
      const next = Math.max(0, heat - dt * .22);
      if (next <= .001) this.trafficHeat.delete(cell); else this.trafficHeat.set(cell, next);
    }
    for (const item of this.boardItems) item.cooldowns = item.cooldowns.map(value => Math.max(0, value - dt));
    this.rebuildCrowdBuckets();
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (enemy.spawnDelay > 0) { enemy.spawnDelay -= dt; continue; }
      if (enemy.burnTime > 0) { enemy.burnTime -= dt; this.damageEnemy(enemy, enemy.burnDps * dt, this.itemById(enemy.burnSourceId), true); }
      // A damage-over-time kill must end this enemy's frame immediately. In
      // particular, a corpse already inside the Heart radius must never also
      // be counted as a leak.
      if (enemy.dead) continue;
      enemy.slowTime = Math.max(0, enemy.slowTime - dt); if (!enemy.slowTime) enemy.slow = 0;
      enemy.vulnerableTime = Math.max(0, enemy.vulnerableTime - dt); if (!enemy.vulnerableTime) enemy.vulnerable = 0;
      enemy.hardControlWindow = Math.max(0, enemy.hardControlWindow - dt); enemy.hardControlImmune = Math.max(0, enemy.hardControlImmune - dt);
      if (enemy.impulseTime > 0) {
        enemy.impulseTime -= dt; enemy.airborneTime = Math.max(0, enemy.airborneTime - dt); enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt; this.resolveTrapObstacleCollision(enemy); this.resolveTerrainCollision(enemy);
        if (enemy.impulseTime <= 0) { this.triggerImpact(enemy); enemy.launched = false; enemy.impulseSourceId = null; }
        continue;
      }
      this.steerEnemy(enemy, dt);
      const cell = `${Math.floor((enemy.x - BOARD_X) / CELL)},${Math.floor((enemy.y - BOARD_Y) / CELL)}`;
      this.trafficHeat.set(cell, (this.trafficHeat.get(cell) ?? 0) + dt * .12);
      this.trafficCoverage.set(cell, (this.trafficCoverage.get(cell) ?? 0) + dt);
      this.checkLeak(enemy);
      if (this.phase === 'result') return;
    }
    this.resolveCrowd(dt);
    this.updateTurretAim(dt);
    this.activateTraps();
    this.updateHeart(dt);
    if (this.enemies.every(enemy => enemy.dead)) {
      if (this.payoutTimer < 0) this.payoutTimer = .9;
      else { this.payoutTimer -= dt; if (this.payoutTimer <= 0) this.finishWave(); }
    }
  }

  private triggerImpact(enemy: EnemyState) {
    if (enemy.impactDamage <= 0) return;
    const source = enemy.impactSourceId ? this.items.find(item => item.id === enemy.impactSourceId) ?? null : null;
    for (const other of this.enemies) if (!other.dead && Math.hypot(other.x - enemy.x, other.y - enemy.y) <= enemy.impactRadius) this.damageEnemy(other, enemy.impactDamage, source);
    this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .38, size: enemy.impactRadius, color: 0x55dfeb, kind: 'ring' });
    enemy.impactDamage = 0; enemy.impactRadius = 0; enemy.impactSourceId = null;
  }

  private steerEnemy(enemy: EnemyState, dt: number) {
    const def = ENEMIES[enemy.kind];
    const entrance = this.entrances[enemy.entrance];
    if (entrance && enemy.emerging) {
      const tx = BOARD_X + (entrance.x + .5) * CELL, ty = BOARD_Y + (entrance.y + .5) * CELL;
      const dx = tx - enemy.x, dy = ty - enemy.y, length = Math.hypot(dx, dy);
      if (length > CELL * .28) {
        const speed = def.speed * (enemy.slowTime > 0 ? 1 - enemy.slow : 1);
        enemy.vx += (dx / length * speed - enemy.vx) * Math.min(1, dt * 8);
        enemy.vy += (dy / length * speed - enemy.vy) * Math.min(1, dt * 8);
        enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;
        return;
      }
      enemy.x = tx; enemy.y = ty; enemy.vx = 0; enemy.vy = 0;
      enemy.emerging = false;
      const firstField = this.gateFlows[0] ?? this.flow;
      enemy.bestFlowDistance = firstField[entrance.y]?.[entrance.x] ?? 0;
    }
    const gate = this.gates[enemy.gateIndex];
    // Flying only changes which traps can hit this enemy. It must not let the
    // enemy bypass the authored macro-flow that the player saw in preparation.
    const gateField = gate ? this.gateFlows[enemy.gateIndex] : null;
    const field = gateField ?? (def.flying ? this.flyFlow : this.flow);
    const cx = clamp(Math.floor((enemy.x - BOARD_X) / CELL), 0, COLS - 1), cy = clamp(Math.floor((enemy.y - BOARD_Y) / CELL), 0, ROWS - 1);
    if (gate?.some(point => (point.x === cx && point.y === cy) || Math.hypot(enemy.x - (BOARD_X + (point.x + .5) * CELL), enemy.y - (BOARD_Y + (point.y + .5) * CELL)) < CELL * .58)) { enemy.gateIndex++; enemy.bestFlowDistance = Infinity; return; }
    const current = field[cy]?.[cx] ?? Infinity;
    if (current < enemy.bestFlowDistance - .05) { enemy.bestFlowDistance = current; enemy.noProgressTime = 0; } else enemy.noProgressTime += dt;
    const recovering = enemy.noProgressTime > CONTROL_TUNING.noProgressTimeout;
    if (recovering) enemy.hardControlImmune = 1;
    const laneBias = recovering ? 0 : enemy.laneBias;
    const progressWeight = 1.15 + Math.min(3.85, enemy.noProgressTime * 1.35);
    // A very short exploration window lets a horde occupy side pockets, but it
    // closes well before a hesitation becomes visible. From then on every
    // chosen cell must make real flow progress.
    const exploring = !recovering && enemy.noProgressTime < .75;
    const candidates = dirs.map(dir => ({ x: cx + dir.x, y: cy + dir.y, dir })).filter(p => Number.isFinite(field[p.y]?.[p.x]) && (field[p.y][p.x] < current || (exploring && field[p.y][p.x] <= current + 1)));
    const scored = candidates.map(candidate => {
      const key = `${candidate.x},${candidate.y}`;
      const flow = field[candidate.y][candidate.x] * progressWeight;
      const density = this.localDensity(BOARD_X + (candidate.x + .5) * CELL, BOARD_Y + (candidate.y + .5) * CELL, enemy.id) * FLOW_DENSITY_AVOIDANCE;
      const heat = (this.trafficHeat.get(key) ?? 0) * 2.2;
      // Shared per-wave coverage pressure makes a large horde occupy side
      // pockets of a room before it reconverges, instead of merely drawing a
      // wider version of the shortest path.
      const coverage = (this.trafficCoverage.get(key) ?? 0) * 3.2;
      const lateral = (candidate.dir.x - candidate.dir.y) * laneBias * .45;
      return { candidate, score: recovering ? flow : flow + density + heat + coverage - lateral };
    }).sort((a, b) => a.score - b.score);
    const next = scored[0]?.candidate ?? { x: cx, y: cy, dir: { x: 0, y: -1 } };
    const tx = BOARD_X + (next.x + .5) * CELL - next.dir.y * laneBias * FLOW_LANE_SPREAD;
    const ty = BOARD_Y + (next.y + .5) * CELL + next.dir.x * laneBias * FLOW_LANE_SPREAD;
    const dx = tx - enemy.x, dy = ty - enemy.y, length = Math.hypot(dx, dy) || 1, slow = enemy.slowTime > 0 ? 1 - enemy.slow : 1;
    const steered = this.steerAroundTrapObstacles(enemy, dx / length, dy / length);
    const speed = def.speed * slow;
    enemy.vx += (steered.x * speed - enemy.vx) * Math.min(1, dt * 6);
    enemy.vy += (steered.y * speed - enemy.vy) * Math.min(1, dt * 6);
    enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;
    this.resolveTrapObstacleCollision(enemy);
    // Obstacle avoidance can push toward a wall, so terrain is deliberately
    // resolved last and remains the authoritative movement boundary.
    this.resolveTerrainCollision(enemy);
  }

  private obstacleCenters() {
    return this.boardItems.flatMap(item => {
      const obstacle = TRAPS[item.trapId].obstacle;
      if (!obstacle || !item.origin) return [];
      return [{
        itemId: item.id,
        x: BOARD_X + (item.origin.x + obstacle.offset.x) * CELL,
        y: BOARD_Y + (item.origin.y + obstacle.offset.y) * CELL,
        radius: obstacle.radius,
      }];
    });
  }

  private steerAroundTrapObstacles(enemy: EnemyState, directionX: number, directionY: number) {
    if (ENEMIES[enemy.kind].flying) return { x: directionX, y: directionY };
    const obstacles = this.obstacleCenters();
    let avoidance = this.obstacleAvoidance.get(enemy.id);
    let obstacle = avoidance ? obstacles.find(value => value.itemId === avoidance!.itemId) : undefined;
    if (obstacle && avoidance) {
      const toX = obstacle.x - enemy.x, toY = obstacle.y - enemy.y, distanceToCenter = Math.hypot(toX, toY) || .001;
      const ahead = (directionX * toX + directionY * toY) / distanceToCenter;
      const clearance = obstacle.radius + ENEMIES[enemy.kind].radius;
      if (ahead < -.3 && distanceToCenter > clearance + 10) { this.obstacleAvoidance.delete(enemy.id); avoidance = undefined; obstacle = undefined; }
    }
    if (!obstacle) {
      obstacle = obstacles.map(value => {
        const toX = value.x - enemy.x, toY = value.y - enemy.y, along = directionX * toX + directionY * toY;
        const perpendicular = Math.abs(directionX * toY - directionY * toX);
        const clearance = value.radius + ENEMIES[enemy.kind].radius;
        return { ...value, along, perpendicular, clearance };
      }).filter(value => value.along > -4 && value.along < value.clearance + 58 && value.perpendicular < value.clearance + 22)
        .sort((a, b) => a.along - b.along)[0];
      if (obstacle) {
        // Prefer an open arc around wall-adjacent turrets. Alternation remains
        // the tie-breaker when both sides are genuinely traversable.
        const fallback = ((enemy.id + Math.round((enemy.laneBias + 1) * 7)) & 1) ? -1 : 1;
        const side = this.openObstacleSide(enemy, obstacle, fallback);
        avoidance = { itemId: obstacle.itemId, side }; this.obstacleAvoidance.set(enemy.id, avoidance);
      }
    }
    if (!obstacle || !avoidance) return { x: directionX, y: directionY };
    const radialXRaw = enemy.x - obstacle.x, radialYRaw = enemy.y - obstacle.y, distanceToCenter = Math.hypot(radialXRaw, radialYRaw) || .001;
    const radialX = radialXRaw / distanceToCenter, radialY = radialYRaw / distanceToCenter;
    const tangentX = -radialY * avoidance.side, tangentY = radialX * avoidance.side;
    const clearance = obstacle.radius + ENEMIES[enemy.kind].radius, influence = clearance + 58;
    const weight = clamp((influence - distanceToCenter) / Math.max(1, influence - clearance), .22, 1);
    let x = directionX * (1 - weight * .78) + tangentX * weight * 1.18 + radialX * weight * .3;
    let y = directionY * (1 - weight * .78) + tangentY * weight * 1.18 + radialY * weight * .3;
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  }

  private openObstacleSide(enemy: EnemyState, obstacle: { x: number; y: number; radius: number }, fallback: -1 | 1): -1 | 1 {
    const dx = enemy.x - obstacle.x, dy = enemy.y - obstacle.y, angle = Math.atan2(dy, dx);
    const orbitRadius = obstacle.radius + ENEMIES[enemy.kind].radius + 2;
    const score = (side: -1 | 1) => [.32, .64, .96, 1.28].reduce((total, step) => {
      const sampleAngle = angle + side * step;
      const x = obstacle.x + Math.cos(sampleAngle) * orbitRadius, y = obstacle.y + Math.sin(sampleAngle) * orbitRadius;
      return total + (this.isTerrainClear(x, y, ENEMIES[enemy.kind].radius) ? 1 : 0);
    }, 0);
    const fallbackScore = score(fallback), opposite = -fallback as -1 | 1, oppositeScore = score(opposite);
    return oppositeScore > fallbackScore ? opposite : fallback;
  }

  private resolveTrapObstacleCollision(enemy: EnemyState) {
    if (ENEMIES[enemy.kind].flying) return;
    for (let pass = 0; pass < 2; pass++) for (const obstacle of this.obstacleCenters()) {
      let dx = enemy.x - obstacle.x, dy = enemy.y - obstacle.y, distanceToCenter = Math.hypot(dx, dy);
      const clearance = obstacle.radius + ENEMIES[enemy.kind].radius;
      if (distanceToCenter >= clearance) continue;
      if (distanceToCenter < .001) {
        const velocityLength = Math.hypot(enemy.vx, enemy.vy) || 1, side = this.obstacleAvoidance.get(enemy.id)?.side ?? ((enemy.id & 1) ? -1 : 1);
        dx = -enemy.vy / velocityLength * side; dy = enemy.vx / velocityLength * side; distanceToCenter = 1;
      }
      const push = clearance - distanceToCenter + .25, nx = dx / distanceToCenter, ny = dy / distanceToCenter;
      enemy.x += nx * push; enemy.y += ny * push;
      const side = this.obstacleAvoidance.get(enemy.id)?.side ?? ((enemy.id & 1) ? -1 : 1);
      const tangentX = -ny * side, tangentY = nx * side;
      const normalSpeed = Math.max(0, enemy.vx * nx + enemy.vy * ny);
      const tangentSpeed = Math.max(ENEMIES[enemy.kind].speed * .28, enemy.vx * tangentX + enemy.vy * tangentY);
      enemy.vx = nx * normalSpeed + tangentX * tangentSpeed;
      enemy.vy = ny * normalSpeed + tangentY * tangentSpeed;
    }
  }

  private localDensity(x: number, y: number, ignore: number) {
    let count = 0;
    const bx = Math.floor(x / CELL), by = Math.floor(y / CELL);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) for (const other of this.crowdBuckets.get(`${bx + ox},${by + oy}`) ?? []) {
      const dx = other.x - x, dy = other.y - y;
      if (other.id !== ignore && dx * dx + dy * dy < 68 * 68) count++;
    }
    return count;
  }

  private rebuildCrowdBuckets() {
    this.crowdBuckets.clear();
    for (const enemy of this.enemies) if (!enemy.dead && enemy.spawnDelay <= 0) {
      const key = `${Math.floor(enemy.x / CELL)},${Math.floor(enemy.y / CELL)}`;
      const bucket = this.crowdBuckets.get(key);
      if (bucket) bucket.push(enemy); else this.crowdBuckets.set(key, [enemy]);
    }
  }

  private crowdMove(enemy: EnemyState, dx: number, dy: number) {
    enemy.x += dx; enemy.y += dy;
    this.resolveTrapObstacleCollision(enemy);
    this.resolveTerrainCollision(enemy);
  }

  private resolveCrowd(dt: number) {
    this.rebuildCrowdBuckets();
    for (const a of this.enemies) if (!a.dead && a.spawnDelay <= 0 && !a.emerging) {
      const bx = Math.floor(a.x / CELL), by = Math.floor(a.y / CELL);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) for (const b of this.crowdBuckets.get(`${bx + ox},${by + oy}`) ?? []) {
        if (b.id <= a.id || b.emerging) continue;
        const dx = b.x - a.x, dy = b.y - a.y, min = (ENEMIES[a.kind].radius + ENEMIES[b.kind].radius) * .96, distance2 = dx * dx + dy * dy;
        if (distance2 >= min * min) continue;
        const d = Math.sqrt(distance2) || .1, force = (min - d) * Math.min(.6, dt * 12), nx = dx / d, ny = dy / d;
        this.crowdMove(a, -nx * force, -ny * force); this.crowdMove(b, nx * force, ny * force);
        if ((a.launched || b.launched) && !(a.collisionSpent && b.collisionSpent)) {
          if (a.launched && !a.collisionSpent) { this.collisionDamage(a, b); a.collisionSpent = true; }
          if (b.launched && !b.collisionSpent) { this.collisionDamage(b, a); b.collisionSpent = true; }
        }
      }
    }
  }

  private terrainCellPassable(x: number, y: number, floor: ReadonlySet<string>) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS && (floor.has(`${x},${y}`) || this.stage.fullGrid[y][x] === 'heart');
  }

  private isTerrainClear(x: number, y: number, radius: number) {
    if (x - radius < BOARD_X || y - radius < BOARD_Y || x + radius > BOARD_X + BOARD_W || y + radius > BOARD_Y + BOARD_H) return false;
    const floor = this.revealedFloorSet;
    const minX = Math.max(0, Math.floor((x - radius - BOARD_X) / CELL)), maxX = Math.min(COLS - 1, Math.floor((x + radius - BOARD_X) / CELL));
    const minY = Math.max(0, Math.floor((y - radius - BOARD_Y) / CELL)), maxY = Math.min(ROWS - 1, Math.floor((y + radius - BOARD_Y) / CELL));
    for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
      if (this.terrainCellPassable(cx, cy, floor)) continue;
      const left = BOARD_X + cx * CELL, top = BOARD_Y + cy * CELL;
      const closestX = clamp(x, left, left + CELL), closestY = clamp(y, top, top + CELL);
      if ((x - closestX) ** 2 + (y - closestY) ** 2 < radius ** 2 - .001) return false;
    }
    return true;
  }

  private resolveTerrainCollision(enemy: EnemyState) {
    const radius = ENEMIES[enemy.kind].radius, floor = this.revealedFloorSet;
    let collided = false;
    enemy.x = clamp(enemy.x, BOARD_X + radius, BOARD_X + BOARD_W - radius);
    enemy.y = clamp(enemy.y, BOARD_Y + radius, BOARD_Y + BOARD_H - radius);
    for (let pass = 0; pass < 3; pass++) {
      let corrected = false;
      const minX = Math.max(0, Math.floor((enemy.x - radius - BOARD_X) / CELL)), maxX = Math.min(COLS - 1, Math.floor((enemy.x + radius - BOARD_X) / CELL));
      const minY = Math.max(0, Math.floor((enemy.y - radius - BOARD_Y) / CELL)), maxY = Math.min(ROWS - 1, Math.floor((enemy.y + radius - BOARD_Y) / CELL));
      for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
        if (this.terrainCellPassable(cx, cy, floor)) continue;
        const left = BOARD_X + cx * CELL, top = BOARD_Y + cy * CELL;
        const closestX = clamp(enemy.x, left, left + CELL), closestY = clamp(enemy.y, top, top + CELL);
        let dx = enemy.x - closestX, dy = enemy.y - closestY, distanceToWall = Math.hypot(dx, dy), push = radius - distanceToWall + .01;
        if (distanceToWall >= radius) continue;
        if (distanceToWall < .001) {
          const exits = [
            { distance: enemy.x - left, nx: -1, ny: 0 }, { distance: left + CELL - enemy.x, nx: 1, ny: 0 },
            { distance: enemy.y - top, nx: 0, ny: -1 }, { distance: top + CELL - enemy.y, nx: 0, ny: 1 },
          ].sort((a, b) => a.distance - b.distance);
          dx = exits[0].nx; dy = exits[0].ny; distanceToWall = 1; push = exits[0].distance + radius + .01;
        }
        const nx = dx / distanceToWall, ny = dy / distanceToWall;
        enemy.x += nx * push; enemy.y += ny * push;
        const inwardSpeed = enemy.vx * nx + enemy.vy * ny;
        if (inwardSpeed < 0) { enemy.vx -= inwardSpeed * nx; enemy.vy -= inwardSpeed * ny; }
        corrected = true; collided = true;
      }
      if (!corrected) break;
    }
    if (collided && enemy.launched) {
      enemy.impulseTime = 0;
      if (!enemy.collisionSpent) { this.damageEnemy(enemy, 28, this.itemById(enemy.impulseSourceId)); enemy.collisionSpent = true; this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .35, size: 34, color: 0xf0c56d, kind: 'ring' }); }
    }
  }

  private collisionDamage(source: EnemyState, target: EnemyState) {
    const damage = 18;
    const trap = this.itemById(source.impulseSourceId);
    this.damageEnemy(source, damage, trap); this.damageEnemy(target, damage, trap);
    this.bursts.push({ x: (source.x + target.x) / 2, y: (source.y + target.y) / 2, age: 0, life: .35, size: 42, color: 0xf3c46e, kind: 'ring' });
  }

  private checkLeak(enemy: EnemyState) {
    const h = this.stage.heartOrigin, hx = BOARD_X + (h.x + 1) * CELL, hy = BOARD_Y + (h.y + 1) * CELL;
    if (Math.hypot(enemy.x - hx, enemy.y - hy) > CELL * .8) return;
    enemy.dead = true; this.obstacleAvoidance.delete(enemy.id); this.hp = Math.max(0, this.hp - ENEMIES[enemy.kind].heartDamage); this.stats.leaked++; this.stats.damageTaken += ENEMIES[enemy.kind].heartDamage;
    this.bursts.push({ x: hx, y: hy, age: 0, life: .5, size: 54, color: 0xff4f67, kind: 'burst' });
    this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .8, size: 18, color: 0xffd45c, kind: 'coin' });
    if (this.hp <= 0) { this.phase = 'result'; this.victory = false; this.paused = true; this.emit(); }
  }

  private trapWorldPoint(item: TrapItem, offset: Point) {
    return {
      x: BOARD_X + (item.origin!.x + offset.x) * CELL,
      y: BOARD_Y + (item.origin!.y + offset.y) * CELL,
    };
  }

  private angleDelta(from: number, to: number) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  private updateTurretAim(dt: number) {
    for (const item of this.boardItems) {
      const def = TRAPS[item.trapId];
      if (!def.turret || !item.origin) continue;
      const pivot = this.trapWorldPoint(item, def.turret.pivotOffset);
      const target = this.floorTargets(item, pivot)[0];
      const current = this.turretAngles.get(item.id) ?? 0;
      if (!target) { this.turretAngles.set(item.id, current); continue; }
      const desired = Math.atan2(target.y - pivot.y, target.x - pivot.x);
      const delta = this.angleDelta(current, desired), step = def.turret.turnSpeed * dt;
      this.turretAngles.set(item.id, current + clamp(delta, -step, step));
    }
  }

  private activateTraps() {
    for (const item of this.boardItems) {
      const def = TRAPS[item.trapId];
      const activators = trapActivationOffsets(def);
      activators.forEach(({ offset, segmentIndex, independent }) => {
        if (item.cooldowns[segmentIndex] > 0 || !item.origin) return;
        const cell = { x: item.origin.x + offset.x, y: item.origin.y + offset.y };
        const center = def.turret ? this.trapWorldPoint(item, def.turret.pivotOffset) : { x: BOARD_X + (cell.x + .5) * CELL, y: BOARD_Y + (cell.y + .5) * CELL };
        const targets = this.floorTargets(item, center, independent);
        if (!targets.length) return;
        if (def.turret) {
          const targetAngle = Math.atan2(targets[0].y - center.y, targets[0].x - center.x);
          if (Math.abs(this.angleDelta(this.turretAngles.get(item.id) ?? 0, targetAngle)) > .2) return;
        }
        item.cooldowns[segmentIndex] = this.getItemCooldown(item);
        if (independent) this.segmentPulse.set(`${item.id}:${segmentIndex}`, .28);
        else def.shape.forEach((_, index) => this.segmentPulse.set(`${item.id}:${index}`, .28));
        this.executeAttack(item, def, center, targets);
      });
    }
  }

  private floorTargets(item: TrapItem, center: Point, independent = false) {
    const def = TRAPS[item.trapId], area = this.getItemArea(item);
    const reach = Math.max(area, this.getItemRange(item));
    const footprintCenters = independent ? [center] : item.origin ? def.shape.map(offset => ({ x: BOARD_X + (item.origin!.x + offset.x + .5) * CELL, y: BOARD_Y + (item.origin!.y + offset.y + .5) * CELL })) : [center];
    return this.enemies.filter(enemy => {
      if (enemy.dead || enemy.spawnDelay > 0 || (!def.canTargetFlying && ENEMIES[enemy.kind].flying)) return false;
      const distanceToTrap = def.range > 0 ? Math.hypot(enemy.x - center.x, enemy.y - center.y) : Math.min(...footprintCenters.map(point => Math.hypot(enemy.x - point.x, enemy.y - point.y)));
      return distanceToTrap <= reach;
    }).sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y)).slice(0, def.targetCap ?? 99);
  }

  private executeAttack(item: TrapItem, def: TrapDef, center: Point, targets: EnemyState[]) {
    const damage = this.getItemDamage(item);
    for (const target of targets) this.hitEnemy(item, def, target, damage, center, true);
    if (this.selectedMechanic('storm-bolt', item)) {
      const target = this.nearestEnemy(center, targets.map(value => value.id), item);
      if (target) { this.damageEnemy(target, damage * .55, item); this.beams.push({ x: center.x, y: center.y, x2: target.x, y2: target.y, age: 0, life: .22, color: 0xc873ff, width: 5 }); }
    }
    if (this.selectedMechanic('heavy-shockwave', item)) {
      for (const primary of targets) for (const enemy of this.enemies) if (!enemy.dead && enemy.id !== primary.id && Math.hypot(enemy.x - primary.x, enemy.y - primary.y) < 58) this.damageEnemy(enemy, damage * .4, item);
      for (const primary of targets) this.bursts.push({ x: primary.x, y: primary.y, age: 0, life: .35, size: 58, color: 0xe9c37a, kind: 'ring' });
    }
    this.attackFx(item, def, center, targets);
  }

  private hitEnemy(item: TrapItem, def: TrapDef, enemy: EnemyState, damage: number, center: Point, native: boolean) {
    const finalDamage = damage;
    this.damageEnemy(enemy, finalDamage, item);
    if (!native || enemy.dead) return;
    if (def.element === 'Fire') { enemy.burnDps = Math.max(enemy.burnDps, finalDamage * .1); enemy.burnTime = CONTROL_TUNING.burnDuration; enemy.burnSourceId = item.id; }
    if (def.element === 'Frost') { enemy.slow = Math.max(enemy.slow, CONTROL_TUNING.slowStrength); enemy.slowTime = CONTROL_TUNING.slowDuration; enemy.frostSourceId = item.id; }
    if (def.element === 'Water') {
      const dx = enemy.x - center.x, dy = enemy.y - center.y, length = Math.hypot(dx, dy) || 1;
      const launched = this.applyImpulse(enemy, dx / length * (def.impulse ?? 90), dy / length * (def.impulse ?? 90), item);
      if (launched && def.id === 'geyser') { enemy.airborneDuration = enemy.impulseTime; enemy.airborneTime = enemy.airborneDuration; }
      if (launched && def.element === 'Water' && this.selectedMechanic('water-impact', item)) { enemy.impactDamage = Math.max(enemy.impactDamage, finalDamage * .45); enemy.impactRadius = Math.max(enemy.impactRadius, 54); enemy.impactSourceId = item.id; }
    }
  }

  private itemById(id: string | null) { return id ? this.items.find(item => item.id === id) ?? null : null; }

  private damageEnemy(enemy: EnemyState, amount: number, source: TrapItem | null, dot = false) {
    if (enemy.dead || amount <= 0) return;
    if (source && !TRAPS[source.trapId].canTargetFlying && ENEMIES[enemy.kind].flying) return;
    const damage = amount * (1 + enemy.vulnerable);
    enemy.hp -= damage;
    const pop = this.damagePops.get(enemy.id);
    if (pop && pop.age < .22) { pop.damage += damage; pop.x = enemy.x; pop.y = enemy.y; }
    else this.damagePops.set(enemy.id, { x: enemy.x, y: enemy.y, damage, age: 0 });
    if (source) this.stats.trapDamage[source.trapId] = (this.stats.trapDamage[source.trapId] ?? 0) + damage;
    if (enemy.hp > 0) return;
    enemy.dead = true; this.obstacleAvoidance.delete(enemy.id); this.stats.killed++;
    this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .4, size: ENEMIES[enemy.kind].radius * 2.4, color: ENEMIES[enemy.kind].accent, kind: dot ? 'ring' : 'burst' });
    this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .8, size: 18, color: 0xffd45c, kind: 'coin' });
    if (enemy.burnTime > 0 && this.selectedMechanic('fire-death-explosion')) {
      const burnSource = this.itemById(enemy.burnSourceId);
      const nearby = this.enemies.filter(other => !other.dead && Math.hypot(other.x - enemy.x, other.y - enemy.y) < 65);
      this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .42, size: 68, color: 0xff6b32, kind: 'burst' });
      for (const other of nearby) this.damageEnemy(other, 28, burnSource);
    }
    if (enemy.slowTime > 0 && this.selectedMechanic('frost-death-shards')) {
      const frostSource = this.itemById(enemy.frostSourceId);
      const nearby = this.enemies.filter(other => !other.dead && Math.hypot(other.x - enemy.x, other.y - enemy.y) < 74);
      for (const other of nearby) this.damageEnemy(other, 22, frostSource);
      for (let index = 0; index < 5; index++) this.bursts.push({ x: enemy.x, y: enemy.y, age: -index * .03, life: .42, size: 30 + index * 5, color: 0xc7f6ff, kind: 'shard' });
    }
  }

  private applyImpulse(enemy: EnemyState, vx: number, vy: number, source: TrapItem) {
    if (enemy.hardControlImmune > 0) return false;
    if (enemy.hardControlWindow <= 0) enemy.hardControlLevel = 0;
    const factor = CONTROL_TUNING.diminishingReturns[Math.min(3, enemy.hardControlLevel)];
    enemy.hardControlLevel++; enemy.hardControlWindow = CONTROL_TUNING.sequenceWindow;
    if (!factor) { enemy.hardControlImmune = CONTROL_TUNING.immunityDuration; return false; }
    enemy.vx = vx * factor; enemy.vy = vy * factor; enemy.impulseTime = CONTROL_TUNING.impulseDuration * factor; enemy.impulseSourceId = source.id; enemy.launched = true; enemy.collisionSpent = false;
    return true;
  }

  private nearestEnemy(point: Point, excluded: number[] = [], source: TrapItem | null = null) {
    return this.enemies.filter(enemy => !enemy.dead && enemy.spawnDelay <= 0 && !excluded.includes(enemy.id) && (!source || TRAPS[source.trapId].canTargetFlying || !ENEMIES[enemy.kind].flying)).sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y))[0];
  }

  private attackFx(item: TrapItem, def: TrapDef, center: Point, targets: EnemyState[]) {
    if (def.turret && (def.id === 'flame' || def.id === 'icicle' || def.id === 'cannon')) {
      const angle = this.turretAngles.get(item.id) ?? 0;
      const muzzle = { x: center.x + Math.cos(angle) * def.turret.muzzleDistance, y: center.y + Math.sin(angle) * def.turret.muzzleDistance };
      for (const target of targets.slice(0, def.id === 'flame' ? 4 : 1)) {
        const travel = Math.hypot(target.x - muzzle.x, target.y - muzzle.y) / def.turret.projectileSpeed;
        this.projectiles.push({ kind: def.id, x: muzzle.x, y: muzzle.y, x2: target.x, y2: target.y, age: 0, life: clamp(travel, .1, .38), color: def.accent });
      }
      this.turretRecoil.set(item.id, .14);
      this.bursts.push({ x: muzzle.x, y: muzzle.y, age: 0, life: .18, size: def.id === 'flame' ? 25 : 16, color: def.accent, kind: 'burst' });
    } else if (def.range > 0) {
      for (const target of targets) this.beams.push({ x: center.x, y: center.y, x2: target.x, y2: target.y, age: 0, life: .13, color: def.accent, width: 4 });
    }
    this.bursts.push({ x: center.x, y: center.y, age: 0, life: .32, size: Math.max(30, this.getItemArea(item) || 34), color: def.accent, kind: def.id === 'spikes' ? 'shard' : 'ring' });
  }

  private updateHeart(dt: number) {
    this.heartCooldown -= dt;
    if (this.heartCooldown > 0) return;
    const h = this.stage.heartOrigin, center = { x: BOARD_X + (h.x + 1) * CELL, y: BOARD_Y + (h.y + 1) * CELL };
    const target = this.nearestEnemy(center);
    if (!target || Math.hypot(target.x - center.x, target.y - center.y) > 125) return;
    this.heartCooldown = .85; this.damageEnemy(target, 4, null); this.beams.push({ x: center.x, y: center.y, x2: target.x, y2: target.y, age: 0, life: .18, color: 0xffd57e, width: 3 });
  }

  private finishWave() {
    if (this.phase !== 'combat') return;
    this.stats.wavesCleared++;
    if (this.wave >= 10) { this.phase = 'result'; this.victory = true; this.paused = true; this.emit(); return; }
    this.coins += WAVE_INCOME[this.wave - 1];
    this.phase = 'perk'; this.paused = true;
    this.perkChoices = this.rollPerks(3);
    this.emit();
  }

  private rollPerks(count: number) {
    const pool = PERKS.filter(perk => !this.selectedPerks.includes(perk.id));
    const choices: PerkDef[] = [];
    while (choices.length < count && pool.length) {
      const available = pool.filter(perk => !choices.includes(perk));
      if (!available.length) break;
      const weighted = available.map(perk => ({ perk, weight: perk.weight * (1 + Math.min(1, this.affectedCount(perk) * .24)) }));
      const total = weighted.reduce((sum, entry) => sum + entry.weight, 0), roll = this.rand() * total;
      let cursor = 0, picked = available[0];
      for (const entry of weighted) { cursor += entry.weight; if (roll <= cursor) { picked = entry.perk; break; } }
      choices.push(picked);
    }
    return choices;
  }

  private updateFx(dt: number) {
    this.bursts.forEach(value => value.age += dt); this.bursts = this.bursts.filter(value => value.age < value.life);
    this.beams.forEach(value => value.age += dt); this.beams = this.beams.filter(value => value.age < value.life);
    this.projectiles.forEach(value => value.age += dt); this.projectiles = this.projectiles.filter(value => value.age < value.life);
    for (const [itemId, recoil] of this.turretRecoil) { const next = recoil - dt; if (next <= 0) this.turretRecoil.delete(itemId); else this.turretRecoil.set(itemId, next); }
    this.zonePops.forEach(value => value.age += dt); this.zonePops = this.zonePops.filter(value => value.age < value.delay + 1.1);
    for (const [key, value] of this.segmentPulse) { const next = value - dt; if (next <= 0) this.segmentPulse.delete(key); else this.segmentPulse.set(key, next); }
    for (const [enemyId, pop] of this.damagePops) { pop.age += dt; if (pop.age > .62) this.damagePops.delete(enemyId); }
    for (const [key, value] of this.boardFlash) { value.age += dt; if (value.age > .85) this.boardFlash.delete(key); }
    for (const [key, value] of this.itemMotions) { value.age += dt; if (value.age >= value.life) this.itemMotions.delete(key); }
    if (this.messageTimer > 0) { this.messageTimer = Math.max(0, this.messageTimer - dt); if (!this.messageTimer) this.message = ''; }
    for (const particle of this.dust) { particle.age += dt; if (particle.age >= 0) { particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.vy += 96 * dt; } }
    this.dust = this.dust.filter(particle => particle.age < particle.life);
    for (const pop of this.damagePops.values()) {
      const t = clamp(pop.age / .62, 0, 1);
      const label = new Text({ text: `${Math.round(pop.damage)}`, style: new TextStyle({ fontFamily: 'Arial', fontSize: 18 * (1 - t * .2), fontWeight: '900', fill: 0xffeca0, stroke: { color: 0x24130f, width: 5 } }) });
      label.anchor.set(.5); label.x = pop.x; label.y = pop.y - 18 - t * 26; label.alpha = 1 - t; this.labelLayer.addChild(label);
    }
    for (const flight of this.recycleFlights) {
      flight.age += dt;
      if (!flight.arrived && flight.age >= flight.delay + flight.life) {
        flight.arrived = true;
        this.bursts.push({ x: 65, y: 1084, age: 0, life: .28, size: 34, color: 0xff9b42, kind: 'burst' });
      }
    }
    this.recycleFlights = this.recycleFlights.filter(flight => flight.age < flight.delay + flight.life + .04);
    this.expandFx = Math.max(0, this.expandFx - dt);
    if (this.phase === 'combat') {
      this.shopSlideDelay = Math.max(0, this.shopSlideDelay - dt);
      if (this.shopSlideDelay <= 0) this.shopSlide = Math.min(1, this.shopSlide + dt * 4.2);
    }
    for (const [key, age] of [...this.revealFog]) {
      const next = age + dt, fog = this.fogSprites.get(key);
      if (fog) {
        const t = clamp(next / .78, 0, 1), eased = 1 - Math.pow(1 - t, 3);
        fog.alpha = 1 - eased; fog.scale.set(1 + eased * .16);
      }
      if (next >= .78) { this.revealFog.delete(key); if (fog) { fog.destroy(); this.fogSprites.delete(key); } }
      else this.revealFog.set(key, next);
    }
    for (const [key, fog] of this.fogSprites) if (!this.revealFog.has(key)) {
      const [x, y] = key.split(',').map(Number), wave = this.elapsed * .42 + x * .71 + y * .39;
      fog.rotation = Math.sin(wave) * .008; fog.scale.set(1.04 + Math.sin(wave * .73) * .012);
    }
    if (this.fogCloudSprite) {
      this.fogCloudSprite.x = BOARD_X + BOARD_W / 2 + Math.sin(this.elapsed * .19) * 18;
      this.fogCloudSprite.y = BOARD_Y + BOARD_H / 2 + Math.cos(this.elapsed * .16) * 14;
      this.fogCloudSprite.rotation = Math.sin(this.elapsed * .11) * .012;
    }
  }

  private drawFrame() {
    this.drawBoardOverlay(); this.drawRoute(); this.drawItems(); this.drawEnemies(); this.drawPortals(); this.drawFx();
  }

  private drawBoardOverlay() {
    const g = this.boardLayer; g.clear();
    g.roundRect(BOARD_X - 8, BOARD_Y - 8, BOARD_W + 16, BOARD_H + 16, 18).stroke({ color: 0x9d7750, width: 5, alpha: .9 });
    const activeFloor = this.revealedFloorSet;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (activeFloor.has(`${x},${y}`)) {
      g.rect(BOARD_X + x * CELL, BOARD_Y + y * CELL, CELL, CELL).stroke({ color: 0x5b4738, width: 1.5, alpha: .32 });
      for (const dir of dirs) if (!activeFloor.has(`${x + dir.x},${y + dir.y}`)) {
        const x1 = BOARD_X + (x + (dir.x > 0 ? 1 : 0)) * CELL, y1 = BOARD_Y + (y + (dir.y > 0 ? 1 : 0)) * CELL;
        const x2 = x1 + (dir.y ? CELL : 0), y2 = y1 + (dir.x ? CELL : 0);
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: 0x17151b, width: 9, alpha: .38 });
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: 0xd4bd91, width: 2, alpha: .5 });
      }
    }
    if (!this.drag) {
      if (this.phase === 'prep' && this.boardItems.length === 0) {
        const pulse = .06 + (Math.sin(this.elapsed * 3) + 1) * .035;
        for (const value of activeFloor) {
          const [x, y] = value.split(',').map(Number);
          g.roundRect(BOARD_X + x * CELL + 6, BOARD_Y + y * CELL + 6, CELL - 12, CELL - 12, 9)
            .fill({ color: 0xffda73, alpha: pulse }).stroke({ color: 0xffe49a, width: 2, alpha: pulse * 2.5 });
        }
      }
      return;
    }
    const item = this.items.find(value => value.id === this.drag!.itemId)!; const def = TRAPS[item.trapId], floor = this.revealedFloorSet;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (floor.has(`${x},${y}`)) g.roundRect(BOARD_X + x * CELL + 4, BOARD_Y + y * CELL + 4, CELL - 8, CELL - 8, 8).fill({ color: 0xf6dc92, alpha: .14 });
    }
    if (this.drag.boardOrigin) {
      for (const cell of this.zoneCells(item, this.drag.boardOrigin)) g.roundRect(BOARD_X + cell.x * CELL + 4, BOARD_Y + cell.y * CELL + 4, CELL - 8, CELL - 8, 8).fill({ color: 0x35d8ff, alpha: .28 }).stroke({ color: 0x65e9ff, width: 3, alpha: .85 });
      for (const offset of def.shape) {
        const x = this.drag.boardOrigin.x + offset.x, y = this.drag.boardOrigin.y + offset.y;
        if (x >= 0 && y >= 0 && x < COLS && y < ROWS) g.roundRect(BOARD_X + x * CELL + 3, BOARD_Y + y * CELL + 3, CELL - 6, CELL - 6, 9).fill({ color: this.drag.valid ? 0x68e9a1 : 0xff5968, alpha: .34 }).stroke({ color: this.drag.valid ? 0x9affc3 : 0xff8b95, width: 4, alpha: .92 });
      }
    }
  }

  private drawRoute() {
    const g = this.routeLayer; g.clear();
    if (this.phase !== 'prep') return;
    const routes = this.routeSimulation.routes, strongest = Math.max(.001, ...routes.map(route => route.amount));
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex], spawn = this.spawnPoints[route.entranceIndex] ?? route.points[0];
      const gridPoints = [spawn, ...route.points].map(point => ({ x: BOARD_X + (point.x + .5) * CELL, y: BOARD_Y + (point.y + .5) * CELL }));
      const points = curvedRoutePoints(gridPoints, routeIndex + route.entranceIndex * 7);
      const load = Math.sqrt(route.amount / strongest), cycle = 3.2 + routeIndex * .13;
      const progress = (this.elapsed / cycle + routeIndex * .173 + route.entranceIndex * .11) % 1;
      const head = pointOnRoute(points, progress), tailProgress = Math.max(0, progress - (.09 + load * .055));
      const tailSamples = Array.from({ length: 9 }, (_, index) => pointOnRoute(points, tailProgress + (progress - tailProgress) * index / 8));
      const coreWidth = 1.4 + load * 5.8, alpha = (this.drag ? .95 : .68) * (.24 + load * .76);
      const drawTrail = (width: number, trailAlpha: number, color: number) => {
        g.moveTo(tailSamples[0].x, tailSamples[0].y);
        for (const point of tailSamples.slice(1)) g.lineTo(point.x, point.y);
        g.stroke({ color, width, alpha: trailAlpha, cap: 'round', join: 'round' });
      };
      drawTrail(coreWidth * 3.8, alpha * .09, 0xffc94f);
      drawTrail(coreWidth * 2.1, alpha * .18, 0xffd45f);
      drawTrail(coreWidth, alpha * .9, 0xffe27a);
      const ux = Math.cos(head.angle), uy = Math.sin(head.angle), nx = -uy, ny = ux;
      const size = 7 + load * 9, half = size * (.42 + load * .08);
      g.moveTo(head.x + ux * size * .34, head.y + uy * size * .34)
        .lineTo(head.x - ux * size + nx * half, head.y - uy * size + ny * half)
        .lineTo(head.x - ux * size - nx * half, head.y - uy * size - ny * half).closePath()
        .fill({ color: 0xffdf72, alpha }).stroke({ color: 0xfff2b0, width: .7 + load * 1.2, alpha: alpha * .9 });
    }
  }

  private drawItems() {
    const centers = this.itemCenters(), used = new Set<string>(), usedTurretBases = new Set<string>(), usedTurretHeads = new Set<string>(), usedSynergyArrows = new Set<string>();
    this.itemFrameLayer.clear(); this.tierBadgeLayer.clear();
    const draggedItem = this.drag ? this.items.find(item => item.id === this.drag!.itemId) ?? null : null;
    const trayOffset = this.shopSlide * (HEIGHT - SHOP_Y + 24);
    this.itemFrameLayer.roundRect(0, SHOP_Y + trayOffset, WIDTH, HEIGHT - SHOP_Y, 0).fill({ color: 0xd9ae69, alpha: .95 }).stroke({ color: 0x6c452d, width: 4 });
    this.itemFrameLayer.roundRect(20, 1039 + trayOffset, 90, 112, 18).fill({ color: 0x3c2723, alpha: .92 }).stroke({ color: 0xffa64f, width: 4 });
    this.itemFrameLayer.circle(65, 1084 + trayOffset, 27).fill({ color: 0x170f13, alpha: .9 }).stroke({ color: 0xffa64f, width: 4 });
    this.itemFrameLayer.roundRect(43, 1031 + trayOffset, 44, 18, 7).fill({ color: 0x55362c, alpha: .98 }).stroke({ color: 0xc98046, width: 3 });
    this.itemFrameLayer.circle(48, 1062 + trayOffset, 5).fill({ color: 0xffc86b, alpha: .8 });
    this.itemFrameLayer.circle(82, 1062 + trayOffset, 5).fill({ color: 0xffc86b, alpha: .8 });
    const flame = 3 + Math.sin(this.elapsed * 8) * 2;
    this.itemFrameLayer.moveTo(54, 1103 + trayOffset).bezierCurveTo(50, 1092 + trayOffset, 59, 1086 - flame + trayOffset, 64, 1076 + trayOffset).bezierCurveTo(67, 1088 + trayOffset, 79, 1091 + trayOffset, 75, 1103 + trayOffset).closePath().fill({ color: 0xff733c, alpha: .9 });
    this.itemFrameLayer.moveTo(60, 1102 + trayOffset).bezierCurveTo(58, 1096 + trayOffset, 64, 1092 + trayOffset, 66, 1087 + trayOffset).bezierCurveTo(69, 1094 + trayOffset, 73, 1097 + trayOffset, 70, 1102 + trayOffset).closePath().fill({ color: 0xffdc69, alpha: .95 });
    this.itemFrameLayer.roundRect(610, 1039 + trayOffset, 90, 112, 18).fill({ color: 0x6e583e, alpha: .96 }).stroke({ color: 0xf5d590, width: 4 });
    this.itemFrameLayer.moveTo(629, 1122 + trayOffset).bezierCurveTo(625, 1105 + trayOffset, 629, 1090 + trayOffset, 637, 1085 + trayOffset)
      .lineTo(637, 1065 + trayOffset).bezierCurveTo(637, 1057 + trayOffset, 648, 1057 + trayOffset, 648, 1065 + trayOffset).lineTo(648, 1081 + trayOffset)
      .lineTo(652, 1058 + trayOffset).bezierCurveTo(653, 1050 + trayOffset, 664, 1052 + trayOffset, 663, 1060 + trayOffset).lineTo(662, 1082 + trayOffset)
      .lineTo(668, 1065 + trayOffset).bezierCurveTo(671, 1058 + trayOffset, 680, 1062 + trayOffset, 677, 1069 + trayOffset).lineTo(673, 1087 + trayOffset)
      .bezierCurveTo(689, 1081 + trayOffset, 692, 1094 + trayOffset, 685, 1101 + trayOffset).bezierCurveTo(677, 1111 + trayOffset, 680, 1118 + trayOffset, 676, 1122 + trayOffset).closePath()
      .fill({ color: 0xe8c997, alpha: .82 }).stroke({ color: 0x765b3d, width: 3, alpha: .8 });
    const allItems = this.items;
    for (const item of allItems) {
      const def = TRAPS[item.trapId], baseCenter = centers.get(item.id); if (!baseCenter) continue;
      const isDragged = this.drag?.itemId === item.id;
      let center = isDragged ? { x: this.drag!.x, y: this.drag!.y } : item.location === 'board' ? baseCenter : { x: baseCenter.x, y: baseCenter.y + trayOffset };
      const motion = !isDragged ? this.itemMotions.get(item.id) : null;
      if (motion) {
        const raw = clamp(motion.age / motion.life, 0, 1), t = 1 - Math.pow(1 - raw, 3);
        center = { x: motion.from.x + (motion.to.x - motion.from.x) * t, y: motion.from.y + (motion.to.y - motion.from.y) * t + Math.sin(raw * Math.PI) * -9 };
      }
      const maxX = Math.max(...def.shape.map(p => p.x)), maxY = Math.max(...def.shape.map(p => p.y));
      const unit = item.location === 'board' || (isDragged && this.drag?.boardOrigin) ? CELL : Math.min(54, 190 / Math.max(maxX + 1, maxY + 1));
      const originX = center.x - (maxX + 1) * unit / 2, originY = center.y - (maxY + 1) * unit / 2;
      const flash = this.boardFlash.get(item.id);
      if (def.shape.length > 1) {
        for (let index = 1; index < def.shape.length; index++) {
          const previous = def.shape[index - 1], current = def.shape[index];
          this.itemFrameLayer.moveTo(originX + (previous.x + .5) * unit, originY + (previous.y + .5) * unit)
            .lineTo(originX + (current.x + .5) * unit, originY + (current.y + .5) * unit)
            .stroke({ color: def.accent, width: Math.max(6, unit * .13), alpha: .48 });
        }
      }
      const spriteKey = item.id, texture = this.trapTextures[item.trapId];
      const rotatingId = rotatingTurretIds.includes(def.id as RotatingTurretId) ? def.id as RotatingTurretId : null;
      const combatParts = rotatingId ? this.combatTurretTextures[rotatingId] : null;
      const articulated = !!(this.phase === 'combat' && item.location === 'board' && item.origin && def.turret && rotatingId && combatParts);
      const tierFilters = this.phase === 'combat' ? null : this.tierFilters[item.tier];
      if (texture && !articulated) {
        let sprite = this.segmentSprites.get(spriteKey);
        if (!sprite) { sprite = new Sprite(texture); sprite.anchor.set(.5); this.segmentSprites.set(spriteKey, sprite); this.itemLayer.addChild(sprite); }
        used.add(spriteKey); sprite.visible = true; sprite.x = center.x; sprite.y = center.y;
        const activePulse = Math.max(0, ...def.shape.map((_, index) => this.segmentPulse.get(`${item.id}:${index}`) ?? 0));
        const pulseScale = activePulse > 0 ? 1 + Math.sin((.28 - activePulse) * 34) * .07 : 1;
        sprite.width = (maxX + 1) * unit * .86 * pulseScale; sprite.height = (maxY + 1) * unit * .86 * pulseScale;
        sprite.rotation = activePulse > 0 ? Math.sin((.28 - activePulse) * 38) * (def.element === 'Water' ? .06 : .025) : 0; sprite.filters = tierFilters;
        sprite.alpha = isDragged ? .96 : this.phase === 'combat' ? .62 : 1; sprite.tint = flash ? flash.color : 0xffffff;
      }
      if (articulated && def.turret && rotatingId && combatParts && item.origin) {
        const art = turretArt[rotatingId], basePoint = this.trapWorldPoint(item, def.turret.baseOffset), pivot = this.trapWorldPoint(item, def.turret.pivotOffset);
        let base = this.turretBaseSprites.get(item.id);
        if (!base) { base = new Sprite(combatParts.base); this.turretBaseSprites.set(item.id, base); this.itemLayer.addChild(base); }
        usedTurretBases.add(item.id); base.visible = true; base.texture = combatParts.base; base.anchor.set(art.baseAnchor.x, art.baseAnchor.y);
        base.x = basePoint.x; base.y = basePoint.y; base.width = art.baseSize.x; base.height = art.baseSize.y; base.alpha = .9; base.tint = flash ? flash.color : 0xffffff; base.filters = tierFilters; base.zIndex = 1;
        let head = this.turretHeadSprites.get(item.id);
        if (!head) { head = new Sprite(combatParts.head); this.turretHeadSprites.set(item.id, head); this.itemLayer.addChild(head); }
        const angle = this.turretAngles.get(item.id) ?? 0, recoilAge = this.turretRecoil.get(item.id) ?? 0;
        const recoil = recoilAge > 0 ? Math.sin((.14 - recoilAge) / .14 * Math.PI) * 4 : 0;
        usedTurretHeads.add(item.id); head.visible = true; head.texture = combatParts.head; head.anchor.set(art.headAnchor.x, art.headAnchor.y);
        head.x = pivot.x - Math.cos(angle) * recoil; head.y = pivot.y - Math.sin(angle) * recoil; head.rotation = angle;
        head.width = art.headSize.x; head.height = art.headSize.y; head.alpha = .96; head.tint = flash ? flash.color : 0xffffff; head.filters = tierFilters; head.zIndex = 2;
      }
      for (let index = 0; index < def.shape.length; index++) {
        const offset = def.shape[index], pulse = this.segmentPulse.get(`${item.id}:${index}`) ?? 0;
        const pad = unit * .12;
        if (pulse > 0) this.itemFrameLayer.circle(originX + (offset.x + .5) * unit, originY + (offset.y + .5) * unit, unit * (.38 + (.28 - pulse) * 1.1)).fill({ color: def.accent, alpha: pulse * .72 });
        this.itemFrameLayer.roundRect(originX + offset.x * unit + pad, originY + offset.y * unit + pad, unit - pad * 2, unit - pad * 2, unit * .16)
          .stroke({ color: 0x171019, width: item.location === 'board' ? 2.5 : 2, alpha: .5 })
          .stroke({ color: def.accent, width: 1, alpha: .2 });
      }
      const stars = item.tier === 1 ? 0 : item.tier === 2 ? 2 : 3;
      const starRadius = Math.max(10, unit * .14), starGap = starRadius * 2.12, starY = originY + starRadius * .9;
      for (let star = 0; star < stars; star++) {
        const starX = center.x + (star - (stars - 1) / 2) * starGap;
        drawTierStar(this.tierBadgeLayer, starX, starY, starRadius);
      }
      const synergyMatched = !!(draggedItem && item.id !== draggedItem.id && item.location === 'board' && item.origin && this.hasZoneSynergy(draggedItem, item));
      if (synergyMatched) {
        const width = (maxX + 1) * unit, height = (maxY + 1) * unit;
        const pulse = (Math.sin(this.elapsed * 5.2) + 1) / 2;
        this.itemFrameLayer.roundRect(center.x - width / 2 - 5, center.y - height / 2 - 5, width + 10, height + 10, 14)
          .stroke({ color: 0x5ef397, width: 4 + pulse * 1.5, alpha: .48 + pulse * .34 });
        if (this.zoneArrowTexture) {
          let arrow = this.synergyArrowSprites.get(item.id);
          if (!arrow) { arrow = new Sprite(this.zoneArrowTexture); arrow.anchor.set(.5); this.synergyArrowSprites.set(item.id, arrow); this.synergyHintLayer.addChild(arrow); }
          const arrowSize = clamp(unit * .48, 32, 42) * (1 + pulse * .07);
          usedSynergyArrows.add(item.id); arrow.visible = true; arrow.x = center.x + width / 2 - 5; arrow.y = center.y - height / 2 + 5;
          arrow.width = arrowSize; arrow.height = arrowSize; arrow.alpha = .9 + pulse * .1;
        }
      }
      if (draggedItem?.id === item.id && item.origin && this.zoneMatchCount(item, this.drag?.boardOrigin ?? undefined) > 0) {
        const width = (maxX + 1) * unit, height = (maxY + 1) * unit;
        this.itemFrameLayer.roundRect(center.x - width / 2 - 9, center.y - height / 2 - 9, width + 18, height + 18, 16)
          .stroke({ color: 0x5ef397, width: 5, alpha: .8 });
      }
      if (flash) {
        const t = clamp(flash.age / .85, 0, 1), pad = 5 + t * 18, width = (maxX + 1) * unit, height = (maxY + 1) * unit;
        this.itemFrameLayer.roundRect(center.x - width / 2 - pad, center.y - height / 2 - pad, width + pad * 2, height + pad * 2, 15 + pad * .25)
          .stroke({ color: flash.color, width: 7 * (1 - t), alpha: (1 - t) * .88 });
      }
    }
    for (const [key, sprite] of this.segmentSprites) if (!used.has(key)) { sprite.destroy(); this.segmentSprites.delete(key); }
    for (const [key, sprite] of this.turretBaseSprites) if (!usedTurretBases.has(key)) { sprite.destroy(); this.turretBaseSprites.delete(key); }
    for (const [key, sprite] of this.turretHeadSprites) if (!usedTurretHeads.has(key)) { sprite.destroy(); this.turretHeadSprites.delete(key); }
    for (const [key, sprite] of this.synergyArrowSprites) if (!usedSynergyArrows.has(key)) { sprite.destroy(); this.synergyArrowSprites.delete(key); }
    if (this.drag) {
      const source = this.items.find(item => item.id === this.drag!.itemId)!;
      const sourceCenter = centers.get(source.id)!;
      const compatible = this.items.filter(item => item.id !== source.id && item.trapId === source.trapId && item.tier === source.tier && source.tier < 3);
      for (const target of compatible) {
        const targetCenter = centers.get(target.id)!;
        this.itemFrameLayer.moveTo(this.drag.x, this.drag.y).bezierCurveTo((this.drag.x + targetCenter.x) / 2, Math.min(this.drag.y, targetCenter.y) - 55, (this.drag.x + targetCenter.x) / 2, Math.min(this.drag.y, targetCenter.y) - 55, targetCenter.x, targetCenter.y).stroke({ color: 0xffd84f, width: 5, alpha: .9 });
        this.itemFrameLayer.circle(targetCenter.x, targetCenter.y, 32 + Math.sin(this.elapsed * 8) * 3).stroke({ color: 0xffe477, width: 4, alpha: .75 });
      }
      void sourceCenter;
    }
  }

  private drawEnemies() {
    const used = new Set<number>();
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.spawnDelay > 0) continue;
      const frames = this.enemyFrames[enemy.kind]; if (!frames) continue;
      let sprite = this.enemySprites.get(enemy.id);
      if (!sprite) { sprite = new Sprite(frames[0]); sprite.anchor.set(.5); this.enemySprites.set(enemy.id, sprite); this.enemyLayer.addChild(sprite); }
      used.add(enemy.id); sprite.visible = true; sprite.texture = frames[Math.floor(this.elapsed * 8 + enemy.id) % frames.length]; sprite.x = enemy.x;
      const airborneProgress = enemy.airborneDuration > 0 ? 1 - enemy.airborneTime / enemy.airborneDuration : 1;
      sprite.y = enemy.y - (enemy.airborneTime > 0 ? Math.sin(airborneProgress * Math.PI) * 30 : 0);
      const size = ENEMIES[enemy.kind].radius * (enemy.kind === 'brute' ? 3.5 : 3.2); sprite.width = size; sprite.height = size;
      sprite.tint = enemy.burnTime > 0 ? 0xff8a55 : enemy.slowTime > 0 ? 0xbcefff : 0xffffff;
      const entrance = this.entrances[enemy.entrance], emerging = enemy.emerging && entrance;
      const emergence = emerging ? clamp(1 - Math.hypot(enemy.x - (BOARD_X + (entrance.x + .5) * CELL), enemy.y - (BOARD_Y + (entrance.y + .5) * CELL)) / CELL, 0, 1) : 1;
      sprite.alpha = (enemy.hardControlImmune > 0 ? .82 : 1) * (.18 + emergence * .82);
    }
    for (const [id, sprite] of this.enemySprites) if (!used.has(id)) { sprite.destroy(); this.enemySprites.delete(id); }
  }

  private drawPortals() {
    const g = this.portalGraphics; g.clear();
    this.portalPreviewHits = [];
    const usedIcons = new Set<string>(), usedCounts = new Set<number>();
    const groups = this.distributedRoster();
    this.entrances.forEach((entrance, entranceIndex) => {
      const spawn = this.spawnPoints[entranceIndex] ?? entrance;
      const rawX = BOARD_X + (spawn.x + .5) * CELL, rawY = BOARD_Y + (spawn.y + .5) * CELL;
      // The DOM HUD covers the literal off-board top cell. Keep the actual
      // spawn there, but let the arrowhead pierce the visible dungeon edge.
      const x = rawX, y = spawn.y < 0 ? BOARD_Y - 4 : rawY;
      const entryX = BOARD_X + (entrance.x + .5) * CELL, entryY = BOARD_Y + (entrance.y + .5) * CELL;
      const length = Math.hypot(entryX - x, entryY - y) || 1, nx = (entryX - x) / length, ny = (entryY - y) / length;
      const isNew = this.newPortalKeys.has(pkey(spawn)), revealAge = 1.15 - this.expandFx;
      if (isNew && this.expandFx > 0 && revealAge < .68) return;
      const portalScale = isNew && this.expandFx > 0 ? clamp((revealAge - .68) / .34, 0, 1) : 1;
      const pulse = Math.sin(this.elapsed * 5 + entranceIndex * 1.7), shift = pulse * 5, cx = x + nx * shift, cy = y + ny * shift;
      g.circle(cx, cy, 26 * portalScale).fill({ color: 0x410c18, alpha: .48 }).stroke({ color: 0xff4057, width: 2, alpha: .55 });
      g.moveTo(cx - nx * 20, cy - ny * 20).lineTo(cx + nx * 14, cy + ny * 14).stroke({ color: 0xff334d, width: 10 * portalScale, alpha: .95 });
      g.poly([cx + nx * 29, cy + ny * 29, cx + nx * 8 - ny * 13, cy + ny * 8 + nx * 13, cx + nx * 8 + ny * 13, cy + ny * 8 - nx * 13]).fill({ color: 0xff334d, alpha: .98 });
      if (this.phase === 'prep') {
        const group = groups[entranceIndex] ?? [], kinds = ([...new Set(group)] as EnemyKind[]).slice(0, 4);
        const totalWidth = Math.max(0, (kinds.length - 1) * 18), tangentX = -ny, tangentY = nx;
        kinds.forEach((kind, kindIndex) => {
          const iconX = clamp(x + tangentX * 43 - totalWidth / 2 + kindIndex * 18 - 15, 14, WIDTH - 46);
          const iconY = spawn.y < 0 ? BOARD_Y + 27 : clamp(y + tangentY * 43, 82, BOARD_Y + BOARD_H - 16);
          g.circle(iconX, iconY, 15).fill({ color: 0x1b1720, alpha: .94 }).stroke({ color: ENEMIES[kind].accent, width: 2 });
          const texture = this.enemyFrames[kind]?.[0];
          if (texture) {
            const iconKey = `${entranceIndex}:${kind}`; let icon = this.portalIconSprites.get(iconKey);
            if (!icon) { icon = new Sprite(texture); icon.anchor.set(.5); this.portalIconSprites.set(iconKey, icon); this.portalLayer.addChild(icon); }
            usedIcons.add(iconKey); icon.texture = texture; icon.x = iconX; icon.y = iconY; icon.width = 27; icon.height = 27; icon.visible = true;
          }
          this.portalPreviewHits.push({ x: iconX, y: iconY, kind });
        });
        let count = this.portalCountTexts.get(entranceIndex);
        if (!count) { count = new Text({ text: '', style: new TextStyle({ fontFamily: 'Arial', fontSize: 15, fontWeight: '900', fill: 0xffe6a7, stroke: { color: 0x1a101d, width: 5 } }) }); this.portalCountTexts.set(entranceIndex, count); this.portalLayer.addChild(count); }
        usedCounts.add(entranceIndex); count.text = `×${group.length}`; count.visible = true;
        const labelX = x + tangentX * 43 + totalWidth / 2 + 6, labelY = spawn.y < 0 ? BOARD_Y + 27 : y + tangentY * 43;
        count.anchor.set(0, .5); count.x = clamp(labelX, 18, WIDTH - 36); count.y = clamp(labelY, 82, BOARD_Y + BOARD_H - 16); this.portalLayer.addChild(count);
      }
    });
    for (const [key, icon] of this.portalIconSprites) if (!usedIcons.has(key)) icon.visible = false;
    for (const [key, count] of this.portalCountTexts) if (!usedCounts.has(key)) count.visible = false;
  }

  private drawFx() {
    const g = this.fxLayer; g.clear(); this.labelLayer.removeChildren().forEach(child => child.destroy());
    for (const beam of this.beams) { if (beam.age < 0) continue; const t = 1 - beam.age / beam.life; g.moveTo(beam.x, beam.y).lineTo(beam.x2, beam.y2).stroke({ color: beam.color, width: beam.width * t, alpha: t }); }
    for (const projectile of this.projectiles) {
      const t = clamp(projectile.age / projectile.life, 0, 1), eased = 1 - Math.pow(1 - t, 2);
      const x = projectile.x + (projectile.x2 - projectile.x) * eased, y = projectile.y + (projectile.y2 - projectile.y) * eased;
      const dx = projectile.x2 - projectile.x, dy = projectile.y2 - projectile.y, length = Math.hypot(dx, dy) || 1, nx = dx / length, ny = dy / length;
      if (projectile.kind === 'cannon') {
        g.moveTo(x - nx * 24, y - ny * 24).lineTo(x, y).stroke({ color: 0x66f7ff, width: 9, alpha: .3 + (1 - t) * .5 });
        g.circle(x, y, 7).fill({ color: 0x23cfe8, alpha: .92 }).stroke({ color: 0xd3ffff, width: 3, alpha: .96 });
      } else if (projectile.kind === 'icicle') {
        const sideX = -ny * 5, sideY = nx * 5;
        g.poly([x + nx * 12, y + ny * 12, x - nx * 8 + sideX, y - ny * 8 + sideY, x - nx * 8 - sideX, y - ny * 8 - sideY]).fill({ color: 0xc9f8ff, alpha: .96 }).stroke({ color: 0x58c9f1, width: 2, alpha: .9 });
        g.moveTo(x - nx * 25, y - ny * 25).lineTo(x - nx * 5, y - ny * 5).stroke({ color: projectile.color, width: 3, alpha: .55 });
      } else {
        for (let index = 0; index < 4; index++) {
          const back = index * 8, wobble = Math.sin(projectile.age * 70 + index * 1.7) * 3;
          g.circle(x - nx * back - ny * wobble, y - ny * back + nx * wobble, 7 - index * 1.1).fill({ color: index < 2 ? 0xffdf55 : 0xff6534, alpha: .82 - index * .12 });
        }
      }
    }
    for (const burst of this.bursts) {
      if (burst.age < 0) continue; const t = clamp(burst.age / burst.life, 0, 1), radius = burst.size * (.35 + t * .9);
      if (burst.kind === 'coin') {
        const coinX = burst.x + (575 - burst.x) * t;
        const coinY = burst.y + (72 - burst.y) * t - Math.sin(t * Math.PI) * 80;
        g.circle(coinX, coinY, 7 * (1 - t * .35)).fill({ color: 0xffd45c, alpha: 1 - t * .55 }).stroke({ color: 0xfff0a8, width: 2, alpha: 1 - t }); continue;
      }
      if (burst.kind === 'reroll') {
        const rerollX = burst.x + (360 - burst.x) * t, rerollY = burst.y + (1225 - burst.y) * t - Math.sin(t * Math.PI) * 62;
        g.circle(rerollX, rerollY, 10 - t * 3).fill({ color: 0x5df08a, alpha: 1 - t * .45 }).stroke({ color: 0xc6ffd6, width: 3, alpha: 1 - t }); continue;
      }
      if (burst.kind === 'shard') { g.moveTo(burst.x - radius, burst.y + radius * .2).lineTo(burst.x + radius, burst.y - radius * .2).stroke({ color: burst.color, width: 5 * (1 - t), alpha: 1 - t }); continue; }
      if (burst.kind === 'burst') g.circle(burst.x, burst.y, radius * .7).fill({ color: burst.color, alpha: (1 - t) * .28 });
      g.circle(burst.x, burst.y, radius).stroke({ color: burst.color, width: 6 * (1 - t), alpha: 1 - t });
    }
    for (const particle of this.dust) {
      if (particle.age < 0) continue; const t = clamp(particle.age / particle.life, 0, 1);
      g.circle(particle.x, particle.y, particle.size * (1 - t * .45)).fill({ color: particle.color, alpha: (1 - t) * .62 });
    }
    for (const flight of this.recycleFlights) {
      const localAge = flight.age - flight.delay; if (localAge < 0 || localAge > flight.life) continue;
      const t = clamp(localAge / flight.life, 0, 1), eased = t * t * (3 - 2 * t);
      const x = flight.from.x + (65 - flight.from.x) * eased, y = flight.from.y + (1084 - flight.from.y) * eased - Math.sin(t * Math.PI) * 62;
      const texture = this.trapTextures[flight.trapId]; if (!texture) continue;
      const sprite = new Sprite(texture); sprite.anchor.set(.5); sprite.x = x; sprite.y = y; sprite.rotation = t * -1.7;
      sprite.width = 42 * (1 - t * .52); sprite.height = 42 * (1 - t * .52); sprite.alpha = 1 - t * .34; this.labelLayer.addChild(sprite);
    }
    const centers = this.itemCenters();
    for (const pop of this.zonePops) {
      const localAge = pop.age - pop.delay; if (localAge < 0) continue;
      const center = centers.get(pop.itemId); if (!center) continue;
      const item = this.items.find(value => value.id === pop.itemId)!; const def = TRAPS[item.trapId]; const maxX = Math.max(...def.shape.map(p => p.x)), maxY = Math.max(...def.shape.map(p => p.y));
      const arrowX = center.x + (maxX + 1) * CELL / 2 - 12, arrowY = center.y - (maxY + 1) * CELL / 2 + 10;
      const t = clamp(localAge / .75, 0, 1);
      if (this.zoneArrowTexture) {
        const arrow = new Sprite(this.zoneArrowTexture); arrow.anchor.set(.5); arrow.x = arrowX; arrow.y = arrowY - Math.sin(t * Math.PI) * 14;
        const arrowScale = 1.05 + Math.sin(Math.min(1, t * 3) * Math.PI) * .28; arrow.width = 42 * arrowScale; arrow.height = 42 * arrowScale;
        arrow.alpha = 1 - Math.max(0, t - .65) / .35; this.labelLayer.addChild(arrow);
      }
      const label = new Text({ text: pop.text, style: new TextStyle({ fontFamily: 'Arial', fontSize: 21 * (1 - t * .45), fontWeight: '900', fill: 0x5af394, stroke: { color: 0x163a24, width: 6 } }) }); label.anchor.set(.5); label.x = center.x; label.y = center.y - 55 + t * 44; label.alpha = 1 - t; this.labelLayer.addChild(label);
    }
    if (this.expandFx > 0) {
      const t = this.expandFx;
      g.roundRect(BOARD_X - 6, BOARD_Y - 6, BOARD_W + 12, BOARD_H + 12, 18).stroke({ color: 0x8fe8ff, width: 9 * t, alpha: t * .65 });
    }
  }
}
