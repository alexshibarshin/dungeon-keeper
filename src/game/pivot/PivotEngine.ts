import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import {
  BOARD_H, BOARD_W, BOARD_X, BOARD_Y, CELL, COLS, CONTROL_TUNING, ENEMIES, EXPAND_PRICES, FLOW_DENSITY_AVOIDANCE, FLOW_LANE_SPREAD, HEIGHT, HEART_HP, PERKS,
  RECYCLER_TARGETS, REROLL_PRICES, ROWS, SHOP_Y, STARTING_COINS, TIER_DAMAGE, TIER_ZONE, TRAPS, TRAP_IDS,
  WAVE_INCOME, WIDTH, buildWavePreview, trapActivationOffsets,
} from './config';
import { activeEntrances, activeFlowGates, buildFlowField, generateDungeon, mulberry32, revealedFloor, revealedMask, simulateTraffic } from './generator';
import type { TrafficSimulation } from './generator';
import type {
  DungeonStage, EnemyKind, EnemyState, GameSnapshot, PerkDef, Point, RunStats, TrapDef, TrapId, TrapItem, TrapTag, TrapTier,
} from './types';

type DragOrigin = { location: TrapItem['location']; origin?: Point; index?: number };
type DragState = { itemId: string; grab: Point; origin: DragOrigin; x: number; y: number; boardOrigin: Point | null; valid: boolean };
type Burst = { x: number; y: number; age: number; life: number; size: number; color: number; kind: 'ring' | 'burst' | 'coin' | 'shard' | 'reroll' };
type Beam = { x: number; y: number; x2: number; y2: number; age: number; life: number; color: number; width: number };
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
  tierArtLayer = new Container();
  enemyLayer = new Container();
  portalLayer = new Container();
  portalGraphics = new Graphics();
  fxLayer = new Graphics();
  labelLayer = new Container();

  terrainTextures: Partial<Record<'wall' | 'floor' | 'heart' | 'fog', Texture>> = {};
  trapTextures: Partial<Record<TrapId, Texture>> = {};
  zoneArrowTexture: Texture | null = null;
  enemyFrames: Partial<Record<EnemyKind, Texture[]>> = {};
  terrainSprites = new Map<string, Sprite>();
  fogSprites = new Map<string, Sprite>();
  segmentSprites = new Map<string, Sprite>();
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
    const terrainEntries = await Promise.all((['wall', 'floor', 'heart', 'fog'] as const).map(async kind => [kind, await Assets.load<Texture>(`/assets/terrain/pivot-${kind === 'wall' ? 'rock-v2' : kind === 'floor' ? 'floor-v2' : `${kind}-v1`}.png`)] as const));
    for (const [kind, texture] of terrainEntries) this.terrainTextures[kind] = texture;
    const trapEntries = await Promise.all(TRAP_IDS.map(async id => [id, await Assets.load<Texture>(`/assets/traps/${TRAPS[id].assetId}.png`)] as const));
    for (const [id, texture] of trapEntries) this.trapTextures[id] = texture;
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
    this.root.addChild(this.backgroundLayer, this.terrainLayer, this.fogLayer, this.boardLayer, this.itemFrameLayer, this.tierArtLayer, this.itemLayer, this.routeLayer, this.portalLayer, this.enemyLayer, this.fxLayer, this.labelLayer);
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
    const beforeEntrances = new Set(this.entrances.map(pkey));
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
    this.newPortalKeys = new Set(this.entrances.map(pkey).filter(value => !beforeEntrances.has(value)));
    this.expandFx = 1.15;
    this.drawTerrain();
    this.showMessage('The dungeon grows');
    this.emit();
  }

  battle() {
    if (this.phase !== 'prep' || this.drag) return;
    this.recycleShop();
    this.phase = 'combat'; this.paused = false; this.enemies = []; this.spawnQueue = []; this.trafficHeat.clear(); this.trafficCoverage.clear();
    const entrances = this.entrances, groups = this.distributedRoster();
    const queue: { kind: EnemyKind; entrance: number }[] = [];
    const longest = Math.max(...groups.map(group => group.length));
    for (let row = 0; row < longest; row++) groups.forEach((group, entrance) => { if (group[row]) queue.push({ kind: group[row], entrance }); });
    const hpScale = 1 + Math.pow((this.wave - 1) / 9, 1.55) * 2.15;
    queue.forEach(({ kind, entrance }, index) => {
      const def = ENEMIES[kind], point = entrances[entrance];
      this.spawnQueue.push({
        id: this.nextEnemyId++, kind, x: BOARD_X + (point.x + .5) * CELL, y: BOARD_Y + (point.y + .5) * CELL,
        vx: 0, vy: 0, hp: def.hp * hpScale, maxHp: def.hp * hpScale, spawnDelay: index * .05,
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
    this.items = []; this.selectedPerks = []; this.perkChoices = []; this.enemies = []; this.spawnQueue = []; this.dust = []; this.recycleFlights = []; this.itemMotions.clear();
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
    const visible = this.revealedMaskSet;
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
      const value = `${x},${y}`, cell = this.stage.fullGrid[y][x], shown = visible.has(value) || cell === 'heart';
      if (cell === 'heart') continue;
      if (cell === 'floor' && this.terrainTextures.floor) {
        const sprite = new Sprite(this.terrainTextures.floor); sprite.x = BOARD_X + x * CELL; sprite.y = BOARD_Y + y * CELL; sprite.width = CELL; sprite.height = CELL;
        sprite.tint = 0xfff4df; sprite.alpha = shown ? 1 : .2;
        this.terrainLayer.addChild(sprite); this.terrainSprites.set(value, sprite);
      }
      if (!shown || this.revealFog.has(value)) {
        // Fog intentionally stays almost flat: it conceals topology without
        // competing with traps, enemies, or the readable stone grid.
        const fog = new Sprite(Texture.WHITE);
        fog.x = BOARD_X + x * CELL; fog.y = BOARD_Y + y * CELL; fog.width = CELL; fog.height = CELL;
        fog.tint = 0x172331; fog.alpha = !shown || this.revealFog.has(value) ? .94 : 0;
        this.fogLayer.addChild(fog); this.fogSprites.set(value, fog);
      }
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
        enemy.impulseTime -= dt; enemy.airborneTime = Math.max(0, enemy.airborneTime - dt); enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt; this.resolveTerrainCollision(enemy);
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
    const gate = this.gates[enemy.gateIndex];
    // Flying only changes which traps can hit this enemy. It must not let the
    // enemy bypass the authored macro-flow that the player saw in preparation.
    const gateField = gate ? this.gateFlows[enemy.gateIndex] : null;
    const field = gateField ?? (def.flying ? this.flyFlow : this.flow);
    const cx = clamp(Math.floor((enemy.x - BOARD_X) / CELL), 0, COLS - 1), cy = clamp(Math.floor((enemy.y - BOARD_Y) / CELL), 0, ROWS - 1);
    if (gate?.some(point => point.x === cx && point.y === cy)) { enemy.gateIndex++; enemy.bestFlowDistance = Infinity; return; }
    const current = field[cy]?.[cx] ?? Infinity;
    if (current < enemy.bestFlowDistance - .05) { enemy.bestFlowDistance = current; enemy.noProgressTime = 0; } else enemy.noProgressTime += dt;
    if (enemy.noProgressTime > CONTROL_TUNING.noProgressTimeout) enemy.hardControlImmune = 1;
    const progressWeight = 1.15 + Math.min(3.85, enemy.noProgressTime * 1.35);
    const candidates = dirs.map(dir => ({ x: cx + dir.x, y: cy + dir.y, dir })).filter(p => field[p.y]?.[p.x] <= current + 1 && Number.isFinite(field[p.y]?.[p.x]));
    const scored = candidates.map(candidate => {
      const key = `${candidate.x},${candidate.y}`;
      const flow = field[candidate.y][candidate.x] * progressWeight;
      const density = this.localDensity(BOARD_X + (candidate.x + .5) * CELL, BOARD_Y + (candidate.y + .5) * CELL, enemy.id) * FLOW_DENSITY_AVOIDANCE;
      const heat = (this.trafficHeat.get(key) ?? 0) * 2.2;
      // Shared per-wave coverage pressure makes a large horde occupy side
      // pockets of a room before it reconverges, instead of merely drawing a
      // wider version of the shortest path.
      const coverage = (this.trafficCoverage.get(key) ?? 0) * 3.2;
      const lateral = (candidate.dir.x - candidate.dir.y) * enemy.laneBias * .45;
      return { candidate, score: flow + density + heat + coverage - lateral };
    }).sort((a, b) => a.score - b.score);
    const next = scored[0]?.candidate ?? { x: cx, y: cy, dir: { x: 0, y: -1 } };
    const tx = BOARD_X + (next.x + .5) * CELL - next.dir.y * enemy.laneBias * FLOW_LANE_SPREAD;
    const ty = BOARD_Y + (next.y + .5) * CELL + next.dir.x * enemy.laneBias * FLOW_LANE_SPREAD;
    const dx = tx - enemy.x, dy = ty - enemy.y, length = Math.hypot(dx, dy) || 1, slow = enemy.slowTime > 0 ? 1 - enemy.slow : 1;
    const speed = def.speed * slow;
    enemy.vx += (dx / length * speed - enemy.vx) * Math.min(1, dt * 6);
    enemy.vy += (dy / length * speed - enemy.vy) * Math.min(1, dt * 6);
    enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;
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
    const before = { x: enemy.x, y: enemy.y };
    enemy.x += dx; enemy.y += dy;
    const cx = Math.floor((enemy.x - BOARD_X) / CELL), cy = Math.floor((enemy.y - BOARD_Y) / CELL);
    const passable = this.revealedFloorSet.has(`${cx},${cy}`) || (cx >= this.stage.heartOrigin.x && cx < this.stage.heartOrigin.x + 2 && cy >= this.stage.heartOrigin.y && cy < this.stage.heartOrigin.y + 2);
    if (!passable) { enemy.x = before.x; enemy.y = before.y; }
  }

  private resolveCrowd(dt: number) {
    this.rebuildCrowdBuckets();
    for (const a of this.enemies) if (!a.dead && a.spawnDelay <= 0) {
      const bx = Math.floor(a.x / CELL), by = Math.floor(a.y / CELL);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) for (const b of this.crowdBuckets.get(`${bx + ox},${by + oy}`) ?? []) {
        if (b.id <= a.id) continue;
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

  private resolveTerrainCollision(enemy: EnemyState) {
    const cx = Math.floor((enemy.x - BOARD_X) / CELL), cy = Math.floor((enemy.y - BOARD_Y) / CELL);
    const passable = cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS && (this.revealedFloorSet.has(`${cx},${cy}`) || this.stage.fullGrid[cy][cx] === 'heart');
    if (!passable) {
      enemy.x -= enemy.vx * .04; enemy.y -= enemy.vy * .04; enemy.vx *= -.25; enemy.vy *= -.25; enemy.impulseTime = 0;
      if (enemy.launched && !enemy.collisionSpent) { this.damageEnemy(enemy, 28, this.itemById(enemy.impulseSourceId)); enemy.collisionSpent = true; this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .35, size: 34, color: 0xf0c56d, kind: 'ring' }); }
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
    enemy.dead = true; this.hp = Math.max(0, this.hp - ENEMIES[enemy.kind].heartDamage); this.stats.leaked++; this.stats.damageTaken += ENEMIES[enemy.kind].heartDamage;
    this.bursts.push({ x: hx, y: hy, age: 0, life: .5, size: 54, color: 0xff4f67, kind: 'burst' });
    this.bursts.push({ x: enemy.x, y: enemy.y, age: 0, life: .8, size: 18, color: 0xffd45c, kind: 'coin' });
    if (this.hp <= 0) { this.phase = 'result'; this.victory = false; this.paused = true; this.emit(); }
  }

  private activateTraps() {
    for (const item of this.boardItems) {
      const def = TRAPS[item.trapId];
      const activators = trapActivationOffsets(def);
      activators.forEach(({ offset, segmentIndex, independent }) => {
        if (item.cooldowns[segmentIndex] > 0 || !item.origin) return;
        const cell = { x: item.origin.x + offset.x, y: item.origin.y + offset.y }, center = { x: BOARD_X + (cell.x + .5) * CELL, y: BOARD_Y + (cell.y + .5) * CELL };
        const targets = this.floorTargets(item, center, independent);
        if (!targets.length) return;
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
    enemy.dead = true; this.stats.killed++;
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
    if (def.range > 0) for (const target of targets.slice(0, def.id === 'flame' ? 4 : targets.length)) this.beams.push({ x: center.x, y: center.y, x2: target.x, y2: target.y, age: 0, life: def.id === 'flame' ? .18 : .13, color: def.accent, width: def.id === 'flame' ? 9 : 4 });
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
    const { links: linkTraffic } = this.routeSimulation;
    for (const link of linkTraffic.values()) {
      if (link.amount < .011) continue;
      const from = { x: BOARD_X + (link.from.x + .5) * CELL, y: BOARD_Y + (link.from.y + .5) * CELL };
      const to = { x: BOARD_X + (link.to.x + .5) * CELL, y: BOARD_Y + (link.to.y + .5) * CELL };
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length, ny = dx / length, ux = dx / length, uy = dy / length;
      const count = link.amount >= .22 ? 3 : link.amount >= .055 ? 2 : 1;
      for (let particle = 0; particle < count; particle++) {
        const speed = .38 + Math.min(.2, Math.sqrt(link.amount) * .18) + particle * .025;
        const pulse = ((this.elapsed * speed + particle / count + link.from.x * .071 + link.from.y * .043) % 1);
        const laneOffset = count > 1 ? (particle - (count - 1) / 2) * 10 : 0;
        const tipX = from.x + dx * pulse + nx * laneOffset, tipY = from.y + dy * pulse + ny * laneOffset;
        const size = count === 3 ? 13 : count === 2 ? 11 : 9, alpha = this.drag ? .86 : count === 3 ? .8 : count === 2 ? .68 : .54;
        g.moveTo(tipX + ux * 2, tipY + uy * 2).lineTo(tipX - ux * size + nx * size * .55, tipY - uy * size + ny * size * .55).lineTo(tipX - ux * size - nx * size * .55, tipY - uy * size - ny * size * .55).closePath()
          .fill({ color: 0x17121d, alpha: alpha * .8 });
        g.moveTo(tipX, tipY).lineTo(tipX - ux * (size - 2) + nx * (size - 2) * .46, tipY - uy * (size - 2) + ny * (size - 2) * .46).lineTo(tipX - ux * (size - 2) - nx * (size - 2) * .46, tipY - uy * (size - 2) - ny * (size - 2) * .46).closePath()
          .fill({ color: 0xffd968, alpha: alpha * .9 });
      }
    }
  }

  private drawItems() {
    const centers = this.itemCenters(), used = new Set<string>(); this.itemFrameLayer.clear();
    const draggedItem = this.drag ? this.items.find(item => item.id === this.drag!.itemId) ?? null : null;
    const zoneCoverage = draggedItem && this.drag?.boardOrigin ? new Set(this.zoneCells(draggedItem, this.drag.boardOrigin).map(pkey)) : new Set<string>();
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
      if (texture) {
        let sprite = this.segmentSprites.get(spriteKey);
        if (!sprite) { sprite = new Sprite(texture); sprite.anchor.set(.5); this.segmentSprites.set(spriteKey, sprite); this.itemLayer.addChild(sprite); }
        used.add(spriteKey); sprite.visible = true; sprite.x = center.x; sprite.y = center.y;
        const activePulse = Math.max(0, ...def.shape.map((_, index) => this.segmentPulse.get(`${item.id}:${index}`) ?? 0));
        const pulseScale = activePulse > 0 ? 1 + Math.sin((.28 - activePulse) * 34) * .07 : 1;
        sprite.width = (maxX + 1) * unit * .86 * pulseScale; sprite.height = (maxY + 1) * unit * .86 * pulseScale;
        sprite.rotation = activePulse > 0 ? Math.sin((.28 - activePulse) * 38) * (def.element === 'Water' ? .06 : .025) : 0;
        sprite.alpha = isDragged ? .96 : this.phase === 'combat' ? .62 : 1; sprite.tint = flash ? flash.color : 0xffffff;
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
      for (let star = 0; star < stars; star++) this.itemFrameLayer.star(center.x + (star - (stars - 1) / 2) * unit * .18, originY + unit * .15, unit * .1, 5, .46).fill({ color: 0xffd56d, alpha: .98 });
      const zoneMatched = !!(draggedItem && item.id !== draggedItem.id && item.origin && def.shape.some(offset => zoneCoverage.has(`${item.origin!.x + offset.x},${item.origin!.y + offset.y}`)));
      if (zoneMatched) {
        const width = (maxX + 1) * unit, height = (maxY + 1) * unit;
        this.itemFrameLayer.roundRect(center.x - width / 2 - 5, center.y - height / 2 - 5, width + 10, height + 10, 14)
          .stroke({ color: 0x5ef397, width: 5, alpha: .92 });
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
      sprite.tint = enemy.burnTime > 0 ? 0xff8a55 : enemy.slowTime > 0 ? 0xbcefff : 0xffffff; sprite.alpha = enemy.hardControlImmune > 0 ? .82 : 1;
    }
    for (const [id, sprite] of this.enemySprites) if (!used.has(id)) { sprite.destroy(); this.enemySprites.delete(id); }
  }

  private drawPortals() {
    const g = this.portalGraphics; g.clear();
    this.portalPreviewHits = [];
    const usedIcons = new Set<string>(), usedCounts = new Set<number>();
    const groups = this.distributedRoster();
    this.entrances.forEach((entrance, entranceIndex) => {
      const x = BOARD_X + (entrance.x + .5) * CELL, y = BOARD_Y + (entrance.y + .5) * CELL;
      const isNew = this.newPortalKeys.has(pkey(entrance)), revealAge = 1.15 - this.expandFx;
      if (isNew && this.expandFx > 0 && revealAge < .68) return;
      const portalScale = isNew && this.expandFx > 0 ? clamp((revealAge - .68) / .34, 0, 1) : 1;
      g.circle(x, y, (25 + Math.sin(this.elapsed * 4 + entranceIndex) * 3) * portalScale).fill({ color: 0x311a4d, alpha: .78 }).stroke({ color: isNew ? 0xd99cff : 0xbc6cff, width: 5 + (1 - portalScale) * 7, alpha: .9 });
      if (this.phase === 'prep') {
        const group = groups[entranceIndex] ?? [], kinds = ([...new Set(group)] as EnemyKind[]).slice(0, 4);
        const totalWidth = Math.max(0, (kinds.length - 1) * 18), iconY = entrance.y === 0 ? y + 42 : y - 42;
        kinds.forEach((kind, kindIndex) => {
          const iconX = clamp(x - totalWidth / 2 + kindIndex * 18 - 15, BOARD_X + 14, BOARD_X + BOARD_W - 46);
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
        count.anchor.set(0, .5); count.x = clamp(x + totalWidth / 2 + 6, BOARD_X + 18, BOARD_X + BOARD_W - 36); count.y = iconY; this.portalLayer.addChild(count);
      }
    });
    for (const [key, icon] of this.portalIconSprites) if (!usedIcons.has(key)) icon.visible = false;
    for (const [key, count] of this.portalCountTexts) if (!usedCounts.has(key)) count.visible = false;
  }

  private drawFx() {
    const g = this.fxLayer; g.clear(); this.labelLayer.removeChildren().forEach(child => child.destroy());
    for (const beam of this.beams) { if (beam.age < 0) continue; const t = 1 - beam.age / beam.life; g.moveTo(beam.x, beam.y).lineTo(beam.x2, beam.y2).stroke({ color: beam.color, width: beam.width * t, alpha: t }); }
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
