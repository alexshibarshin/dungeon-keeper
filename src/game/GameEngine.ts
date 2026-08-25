import { Application, Assets, Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import { BOARD_H, BOARD_W, BOARD_X, BOARD_Y, BOUNTY_COIN_FACTOR, CELL, COLS, ELEMENT_COLORS, ENEMIES, GUARANTEED_OFFER_MAX_PRICE, HEART_SHOT_COOLDOWN, HEART_SHOT_DAMAGE, HEIGHT, PERKS, ROWS, STARTING_COINS, terrainEditPrice, TRAPS, TRAP_TARGET_CAPS, trapUpgradePrice, WIDTH } from './config';
import { activeEntranceCount, allEntrancesConnected, buildFlowField, enemyHpScale, generateStage, mulberry32, offerFor, openFacesFor, reactionName, waveClearReward, wavePreview } from './rules';
import type { CellKind, ElementType, Enemy, EnemyKind, GameSnapshot, GameStats, PerkDef, PlacedTrap, Point, StageSpec, TrapOffer } from './types';

interface Burst { x: number; y: number; age: number; life: number; color: number; kind: string; size: number }
interface FloatText { x: number; y: number; age: number; text: string; baseText: string; count: number; color: number }
interface Beam { x: number; y: number; x2: number; y2: number; age: number; life: number; color: number; kind: string; width: number }
interface FxParticle { view: Particle; layer: 'soft' | 'sharp'; vx: number; vy: number; age: number; life: number; startScale: number; endScale: number; spin: number; gravity: number; alpha: number }

const baseStats = (): GameStats => ({
  killed: 0, pitKills: 0, leaked: 0, damageTaken: 0, reactionCount: {}, reactionDamage: {}, primerCount: {}, triggerCount: {}, burnDamage: {}, trapDamage: {}, trapLevels: {}, heartDamage: 0,
  maxHeartLevel: 1, builtWalls: 0, digs: 0, spentTraps: 0, spentUpgrades: 0, spentHeart: 0, spentRepair: 0, spentReroll: 0, spentTerrain: 0, wavesCleared: 0,
});

export class GameEngine {
  app = new Application();
  stage: StageSpec;
  grid: CellKind[][];
  deck: string[];
  onSnapshot: (state: GameSnapshot) => void;
  root = new Container();
  terrainSpriteLayer = new Container();
  terrainLayer = new Graphics();
  routeLayer = new Graphics();
  trapLayer = new Graphics();
  hintLabelLayer = new Container();
  trapSpriteLayer = new Container();
  heartLayer = new Graphics();
  enemyLayer = new Graphics();
  enemyAuraLayer = new Container();
  enemySpriteLayer = new Container();
  enemyOverlayLayer = new Graphics();
  softParticleLayer = new ParticleContainer({ boundsArea: new Rectangle(0, 0, WIDTH, HEIGHT), dynamicProperties: { position: true, rotation: true, vertex: true, color: true } });
  sharpParticleLayer = new ParticleContainer({ boundsArea: new Rectangle(0, 0, WIDTH, HEIGHT), dynamicProperties: { position: true, rotation: true, vertex: true, color: true } });
  vfxLayer = new Graphics();
  labelLayer = new Container();
  debugText = new Text({ text: '', style: new TextStyle({ fontFamily: 'monospace', fontSize: 14, fill: 0xb8f5de, stroke: { color: 0x09070c, width: 4 } }) });
  rand: () => number;
  flow: number[][];
  flyFlow: number[][];
  traps: PlacedTrap[] = [];
  enemies: Enemy[] = [];
  bursts: Burst[] = [];
  floatTexts: FloatText[] = [];
  beams: Beam[] = [];
  particles: FxParticle[] = [];
  particlePool: Record<'soft' | 'sharp', Particle[]> = { soft: [], sharp: [] };
  particleTextures: Partial<Record<'soft' | 'sharp', Texture>> = {};
  offers: TrapOffer[] = [];
  selectedOffer: string | null = null;
  selectedTrap: string | null = null;
  moveMode = false;
  movingTrap: string | null = null;
  moveOrigin: Point | null = null;
  moveSnapshot = new Map<string, Point>();
  dragOfferId: string | null = null;
  dragPreview: { origin: Point; valid: boolean } | null = null;
  dragGrabOffset: Point = { x: 0, y: 0 };
  terrainMode: 'dig' | 'build' | null = null;
  phase: GameSnapshot['phase'] = 'prep';
  wave = 1;
  coins = STARTING_COINS;
  hp = 100;
  maxHp = 100;
  heartLevel = 1;
  simSpeed = 1;
  activeEntrances = 1;
  spawnQueue: Enemy[] = [];
  nextEnemyId = 1;
  heartCooldown = 0;
  volleyCount = 0;
  message = 'Изучи маршрут. Построй машину смерти.';
  perks: string[] = [];
  perkChoices: PerkDef[] = [];
  stats = baseStats();
  stars = 0;
  rerollCost = 3;
  repairCost = 8;
  digActionsThisWave = 0;
  buildActionsThisWave = 0;
  elapsed = 0;
  paused = false;
  destroyed = false;
  initialized = false;
  snapshotTimer = 0;
  fixedAccumulator = 0;
  debug = false;
  neighborChecks = 0;
  blazeCooldown = 0;
  bountyProgress = 0;
  enemyFrames: Partial<Record<EnemyKind, Texture[]>> = {};
  enemySprites = new Map<number, Sprite>();
  enemyAuraSprites = new Map<number, Sprite>();
  trapTextures: Partial<Record<string, Texture>> = {};
  trapSprites = new Map<string, Sprite>();
  terrainTextures: Partial<Record<CellKind, Texture>> = {};

  constructor(seed: number, deck: string[], onSnapshot: (state: GameSnapshot) => void) {
    this.stage = generateStage(seed);
    this.grid = this.stage.grid.map(r => [...r]);
    this.deck = deck;
    this.onSnapshot = onSnapshot;
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.flow = buildFlowField(this.grid, this.stage.heart);
    this.flyFlow = buildFlowField(this.grid, this.stage.heart, true);
    this.refreshShop(true);
  }

  async mount(host: HTMLElement) {
    await this.app.init({ width: WIDTH, height: HEIGHT, backgroundColor: 0x0d0b13, antialias: true, resolution: Math.min(devicePixelRatio, 2), autoDensity: true });
    await Promise.all((Object.keys(ENEMIES) as EnemyKind[]).map(async kind => {
      const sheet = await Assets.load<Texture>(`/assets/enemies/${kind}-sheet-v2.png`);
      const frameWidth = sheet.width / 4;
      this.enemyFrames[kind] = Array.from({ length: 4 }, (_, i) => new Texture({ source: sheet.source, frame: new Rectangle(i * frameWidth, 0, frameWidth, sheet.height) }));
    }));
    const puffSource = new Graphics().circle(16, 16, 13).fill(0xffffff);
    const shardSource = new Graphics().roundRect(2, 12, 28, 8, 4).fill(0xffffff);
    this.particleTextures.soft = this.app.renderer.generateTexture(puffSource);
    this.particleTextures.sharp = this.app.renderer.generateTexture(shardSource);
    puffSource.destroy(); shardSource.destroy();
    this.initialized = true;
    if (this.destroyed) { this.app.destroy(true, { children: true }); return; }
    this.app.canvas.className = 'game-canvas';
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.root.addChild(this.terrainSpriteLayer, this.terrainLayer, this.routeLayer, this.trapSpriteLayer, this.trapLayer, this.hintLabelLayer, this.heartLayer, this.enemyLayer, this.enemyAuraLayer, this.enemySpriteLayer, this.enemyOverlayLayer, this.softParticleLayer, this.sharpParticleLayer, this.vfxLayer, this.labelLayer, this.debugText);
    this.debugText.x = 12; this.debugText.y = 110; this.debugText.visible = false;
    this.drawTerrain();
    this.app.canvas.addEventListener('pointerdown', this.handlePointer);
    window.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKey);
    this.app.ticker.maxFPS = 30;
    this.app.ticker.add(this.tick);
    (window as Window & { __DUNGEON_KEEPER__?: GameEngine }).__DUNGEON_KEEPER__ = this;
    this.emit();
  }

  destroy() {
    this.destroyed = true;
    if (!this.initialized) return;
    this.app.canvas.removeEventListener('pointerdown', this.handlePointer);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKey);
    const debugWindow = window as Window & { __DUNGEON_KEEPER__?: GameEngine };
    if (debugWindow.__DUNGEON_KEEPER__ === this) delete debugWindow.__DUNGEON_KEEPER__;
    this.app.destroy(true, { children: true });
  }

  get preview(): Record<EnemyKind, number> {
    return wavePreview(this.wave, this.stage.archetype);
  }

  get digCost() { return terrainEditPrice('dig', this.digActionsThisWave); }
  get buildCost() { return terrainEditPrice('build', this.buildActionsThisWave); }

  getSnapshot(): GameSnapshot {
    return {
      phase: this.phase, wave: this.wave, coins: this.coins, hp: Math.max(0, Math.ceil(this.hp)), maxHp: this.maxHp,
      heartLevel: this.heartLevel, speed: this.simSpeed, enemyCount: this.enemies.filter(e => !e.dead && e.spawnDelay <= 0).length,
      offers: this.offers, selectedOffer: this.selectedOffer, selectedTrap: this.selectedTrap, terrainMode: this.terrainMode, moveMode: this.moveMode, movingTrap: this.movingTrap,
      message: this.message, activeEntrances: this.activeEntrances, preview: this.preview, perks: this.perks,
      perkChoices: this.perkChoices, stats: this.stats, stars: this.stars,
    };
  }

  emit() { this.onSnapshot(this.getSnapshot()); }

  private refreshShop(initial = false) {
    const kept = initial ? [] : this.offers.filter(o => o.frozen);
    this.offers = [...kept];
    if (this.offers.length < 3 && !this.offers.some(offer => offer.price <= GUARANTEED_OFFER_MAX_PRICE)) this.offers.push(offerFor(this.rand, this.deck, this.offers.length, GUARANTEED_OFFER_MAX_PRICE));
    while (this.offers.length < 3) this.offers.push(offerFor(this.rand, this.deck, this.offers.length));
  }

  selectOffer(id: string) {
    if (this.phase !== 'prep' || this.movingTrap) return;
    const offer = this.offers.find(o => o.id === id);
    if (!offer) return;
    if (this.coins < offer.price) { this.message = 'Не хватает золота.'; this.emit(); return; }
    this.selectedOffer = this.selectedOffer === id ? null : id;
    this.selectedTrap = null; this.terrainMode = null;
    this.message = this.selectedOffer ? `Размести: ${TRAPS[offer.trapId].name}` : 'Выбор отменён.';
    this.emit();
  }

  beginOfferDrag(id: string, clientX: number, clientY: number) {
    if (this.phase !== 'prep' || this.moveMode || this.terrainMode) return;
    const offer = this.offers.find(o => o.id === id);
    if (!offer) return;
    if (this.coins < offer.price) { this.message = 'Не хватает золота.'; this.emit(); return; }
    const maxX = Math.max(...offer.shape.map(p => p.x)), maxY = Math.max(...offer.shape.map(p => p.y));
    this.dragGrabOffset = { x: Math.floor(maxX / 2), y: Math.floor(maxY / 2) };
    this.dragOfferId = id; this.selectedOffer = id; this.selectedTrap = null;
    this.message = `Перетащи ${TRAPS[offer.trapId].name} на подсвеченные клетки.`;
    this.updateDragPreview(clientX, clientY); this.emit();
  }

  toggleFreeze(id: string) {
    if (this.phase !== 'prep' || this.movingTrap) return;
    const offer = this.offers.find(o => o.id === id);
    if (offer) { offer.frozen = !offer.frozen; this.emit(); }
  }

  selectHeart() {
    if (this.phase !== 'prep' || this.moveMode || this.terrainMode) return;
    this.selectedTrap = this.selectedTrap === 'heart' ? null : 'heart';
    this.selectedOffer = null; this.message = this.selectedTrap ? 'Dungeon Heart: улучшить или отремонтировать.' : 'Выбор снят.'; this.emit();
  }

  reroll() {
    if (this.phase !== 'prep' || this.movingTrap || this.coins < this.rerollCost) return;
    this.coins -= this.rerollCost; this.stats.spentReroll += this.rerollCost; this.rerollCost += 2;
    this.refreshShop();
    this.selectedOffer = null; this.message = 'Механизмы обновлены.'; this.emit();
  }

  setTerrainMode(mode: 'dig' | 'build') {
    if (this.phase !== 'prep' || this.moveMode || this.movingTrap) return;
    this.terrainMode = this.terrainMode === mode ? null : mode;
    this.selectedOffer = null; this.selectedTrap = null;
    this.message = this.terrainMode === 'dig' ? 'Выбери обычную породу.' : this.terrainMode === 'build' ? 'Путь от каждого входа должен сохраниться.' : 'Режим строительства закрыт.';
    this.refreshHintLabels(); this.emit();
  }

  private handlePointer = (event: PointerEvent) => {
    if (this.phase !== 'prep') return;
    const rect = this.app.canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * WIDTH / rect.width;
    const py = (event.clientY - rect.top) * HEIGHT / rect.height;
    const x = Math.floor((px - BOARD_X) / CELL), y = Math.floor((py - BOARD_Y) / CELL);
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;

    const hitTrap = this.traps.find(t => t.shape.some(p => t.origin.x + p.x === x && t.origin.y + p.y === y));
    if (this.moveMode) {
      if (!hitTrap) return;
      event.preventDefault();
      this.movingTrap = hitTrap.id; this.moveOrigin = { ...hitTrap.origin }; this.selectedTrap = hitTrap.id;
      this.dragGrabOffset = { x: x - hitTrap.origin.x, y: y - hitTrap.origin.y };
      this.updateDragPreview(event.clientX, event.clientY); this.message = 'Тащи фигуру. Невалидный отпуск вернёт её назад.'; this.emit();
      return;
    }
    if (!this.selectedOffer && !this.terrainMode && hitTrap) {
      this.selectedTrap = this.selectedTrap === hitTrap.id ? null : hitTrap.id;
      this.message = this.selectedTrap ? `${TRAPS[hitTrap.trapId].name} · уровень ${hitTrap.level}` : 'Выбор снят.';
      this.emit(); return;
    }

    if (this.grid[y][x] === 'heart' && !this.selectedOffer && !this.terrainMode) {
      this.selectedTrap = this.selectedTrap === 'heart' ? null : 'heart'; this.message = 'Dungeon Heart: сила подземелья.'; this.emit(); return;
    }

    if (this.terrainMode) { this.editTerrain(x, y); return; }
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.dragOfferId && !this.movingTrap) return;
    event.preventDefault(); this.updateDragPreview(event.clientX, event.clientY);
  };

  private handlePointerUp = () => {
    if (!this.dragOfferId && !this.movingTrap) return;
    const preview = this.dragPreview;
    if (this.dragOfferId) {
      if (preview?.valid) this.placeOffer(preview.origin.x, preview.origin.y);
      else { this.message = 'Фигура вернулась в магазин: здесь её поставить нельзя.'; this.shakeBoard(); }
      this.dragOfferId = null; this.selectedOffer = null; this.dragPreview = null; this.emit();
      return;
    }
    const trap = this.traps.find(t => t.id === this.movingTrap);
    if (trap && preview?.valid) { trap.origin = { ...preview.origin }; this.message = `${TRAPS[trap.trapId].name} перемещена бесплатно.`; }
    else if (trap && this.moveOrigin) { trap.origin = { ...this.moveOrigin }; this.message = 'Невалидная позиция: ловушка вернулась назад.'; this.shakeBoard(); }
    this.movingTrap = null; this.moveOrigin = null; this.dragPreview = null; this.emit();
  };

  private updateDragPreview(clientX: number, clientY: number) {
    const rect = this.app.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * WIDTH / rect.width, py = (clientY - rect.top) * HEIGHT / rect.height;
    const cellX = Math.floor((px - BOARD_X) / CELL), cellY = Math.floor((py - BOARD_Y) / CELL);
    const origin = { x: cellX - this.dragGrabOffset.x, y: cellY - this.dragGrabOffset.y };
    const offer = this.offers.find(o => o.id === this.dragOfferId), moving = this.traps.find(t => t.id === this.movingTrap);
    const trapId = offer?.trapId ?? moving?.trapId, shape = offer?.shape ?? moving?.shape;
    if (!trapId || !shape) { this.dragPreview = null; return; }
    this.dragPreview = { origin, valid: this.canPlaceTrap(trapId, shape, origin.x, origin.y, moving?.id) };
  }

  private handleKey = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (key === 'd') {
      this.debug = !this.debug; this.debugText.visible = this.debug;
      return;
    }
    if (key === 's' && this.debug) this.spawnStressTest();
  };

  private spawnStressTest() {
    const kinds: EnemyKind[] = ['delver', 'runner', 'delver', 'shield', 'delver', 'wing', 'delver', 'brute'];
    const scale = enemyHpScale(10) * 8;
    this.phase = 'combat'; this.paused = false; this.simSpeed = 1; this.routeLayer.visible = false; this.enemies = [];
    for (let i = 0; i < 300; i++) {
      const kind = kinds[i % kinds.length], def = ENEMIES[kind], entrance = i % this.stage.entrances.length, p = this.stage.entrances[entrance];
      this.enemies.push({
        id: this.nextEnemyId++, kind,
        x: BOARD_X + (p.x + .5) * CELL + (this.rand() - .5) * 34,
        y: BOARD_Y + (p.y + .5) * CELL + (this.rand() - .5) * 34,
        vx: 0, vy: 0, hp: def.hp * scale, maxHp: def.hp * scale,
        speed: def.speed * 1.1, radius: def.radius, mass: def.mass, baseDamage: 0,
        aura: null, auraSource: null, auraTime: 0, sourceLevel: 1, frozen: 0, hit: false,
        flying: !!def.flying, dead: false, spawnDelay: 0, entrance, angle: 0,
        laneBias: this.rand() * 2 - 1, lastCellX: p.x, lastCellY: p.y, impulseTime: 0,
      });
    }
    this.message = 'STRESS · 300 активных врагов'; this.emit();
  }

  private canPlaceTrap(trapId: string, shape: Point[], x: number, y: number, ignoreTrapId?: string) {
    const def = TRAPS[trapId];
    const occupied = new Set(this.traps.filter(t => t.id !== ignoreTrapId).flatMap(t => t.shape.map(p => `${t.origin.x + p.x},${t.origin.y + p.y}`)));
    return shape.every(p => {
      const cx = x + p.x, cy = y + p.y;
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || occupied.has(`${cx},${cy}`)) return false;
      const kind = this.grid[cy][cx];
      if (def.placement === 'floor') return kind === 'floor';
      if (!['rock', 'eternal', 'built'].includes(kind)) return false;
      return this.openFaces(cx, cy).length > 0;
    });
  }

  startMoveSelected() {
    if (this.phase !== 'prep' || !this.selectedTrap || this.selectedTrap === 'heart') return;
    this.moveMode = true; this.moveSnapshot = new Map(this.traps.map(t => [t.id, { ...t.origin }]));
    this.selectedOffer = null; this.selectedTrap = null; this.terrainMode = null; this.refreshHintLabels();
    this.message = 'Режим перемещения: перетаскивай любые ловушки, затем нажми галочку.'; this.emit();
  }

  finishMoveMode() {
    if (!this.moveMode || this.movingTrap) return;
    this.moveMode = false; this.moveSnapshot.clear(); this.selectedTrap = null;
    this.message = 'Новая расстановка сохранена.'; this.emit();
  }

  cancelMove() {
    if (!this.moveMode) return;
    for (const trap of this.traps) { const origin = this.moveSnapshot.get(trap.id); if (origin) trap.origin = { ...origin }; }
    this.moveMode = false; this.movingTrap = null; this.moveOrigin = null; this.dragPreview = null; this.moveSnapshot.clear(); this.selectedTrap = null;
    this.message = 'Все перемещения отменены.'; this.emit();
  }

  private placeOffer(x: number, y: number) {
    const offer = this.offers.find(o => o.id === this.selectedOffer);
    if (!offer) return;
    const def = TRAPS[offer.trapId];
    const valid = this.canPlaceTrap(offer.trapId, offer.shape, x, y);
    if (!valid) { this.message = 'Здесь фигура не помещается.'; this.shakeBoard(); this.emit(); return; }
    this.coins -= offer.price;
    this.stats.spentTraps += offer.price;
    this.traps.push({ id: `trap-${Date.now()}-${this.traps.length}`, trapId: offer.trapId, origin: { x, y }, shape: offer.shape, level: 1, pricePaid: offer.price, cooldowns: offer.shape.map(() => this.rand() * .3) });
    this.stats.trapLevels[offer.trapId] = Math.max(this.stats.trapLevels[offer.trapId] ?? 0, 1);
    this.offers = this.offers.filter(o => o.id !== offer.id);
    this.selectedOffer = null;
    this.message = `${def.name} установлена. Каждая клетка активна.`;
    this.drawTerrain(); this.emit();
  }

  private openFaces(x: number, y: number) {
    return openFacesFor(this.grid, x, y);
  }

  private editTerrain(x: number, y: number) {
    const price = this.terrainMode === 'dig' ? this.digCost : this.buildCost;
    if (this.coins < price) { this.message = 'Не хватает золота.'; this.emit(); return; }
    if (this.terrainMode === 'dig') {
      if (!['rock', 'built'].includes(this.grid[y][x])) { this.message = 'Эту клетку нельзя раскопать.'; this.emit(); return; }
      if (this.traps.some(t => t.shape.some(p => t.origin.x + p.x === x && t.origin.y + p.y === y))) { this.message = 'Сначала перенеси настенную ловушку.'; this.emit(); return; }
      this.grid[y][x] = 'floor';
    } else {
      if (this.grid[y][x] !== 'floor' || this.traps.some(t => t.shape.some(p => t.origin.x + p.x === x && t.origin.y + p.y === y))) { this.message = 'Здесь нельзя построить стену.'; this.emit(); return; }
      const before = this.grid[y][x]; this.grid[y][x] = 'built';
      if (!allEntrancesConnected(this.grid, this.stage)) { this.grid[y][x] = before; this.message = 'Нельзя перекрыть путь к сердцу.'; this.shakeBoard(); this.emit(); return; }
    }
    this.coins -= price; this.stats.spentTerrain += price;
    if (this.terrainMode === 'dig') this.stats.digs++; else this.stats.builtWalls++;
    if (this.terrainMode === 'dig') this.digActionsThisWave++; else this.buildActionsThisWave++;
    this.flow = buildFlowField(this.grid, this.stage.heart); this.flyFlow = buildFlowField(this.grid, this.stage.heart, true);
    this.message = this.terrainMode === 'dig' ? 'Проход раскопан.' : 'Стена возведена.';
    this.drawTerrain(); this.refreshHintLabels(); this.emit();
  }

  private terrainCellValid(x: number, y: number) {
    if (!this.terrainMode) return false;
    const occupied = this.traps.some(t => t.shape.some(p => t.origin.x + p.x === x && t.origin.y + p.y === y));
    if (this.terrainMode === 'dig') return ['rock', 'built'].includes(this.grid[y][x]) && !occupied;
    if (this.grid[y][x] !== 'floor' || occupied) return false;
    const copy = this.grid.map(row => [...row]); copy[y][x] = 'built';
    return allEntrancesConnected(copy, this.stage);
  }

  private refreshHintLabels() {
    this.hintLabelLayer.removeChildren().forEach(child => child.destroy());
    if (!this.terrainMode || this.phase !== 'prep') return;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (!this.terrainCellValid(x, y)) continue;
      const price = this.terrainMode === 'dig' ? this.digCost : this.buildCost;
      const label = new Text({ text: `◆${price}`, style: new TextStyle({ fontFamily: 'system-ui', fontSize: 12, fontWeight: '900', fill: 0xffdda0, stroke: { color: 0x161019, width: 4 } }) });
      label.anchor.set(.5); label.x = BOARD_X + (x + .5) * CELL; label.y = BOARD_Y + (y + .73) * CELL;
      this.hintLabelLayer.addChild(label);
    }
  }

  upgradeSelected() {
    if (this.phase !== 'prep' || !this.selectedTrap || this.selectedTrap === 'heart') return;
    const trap = this.traps.find(t => t.id === this.selectedTrap); if (!trap || trap.level >= 3) return;
    const price = trapUpgradePrice(trap.pricePaid, trap.level);
    if (this.coins < price) { this.message = 'Не хватает золота.'; this.emit(); return; }
    this.coins -= price; this.stats.spentUpgrades += price; trap.level++;
    this.stats.trapLevels[trap.trapId] = Math.max(this.stats.trapLevels[trap.trapId] ?? 0, trap.level);
    this.message = `${TRAPS[trap.trapId].name}: уровень ${trap.level}`; this.emit();
  }

  sellSelected() {
    if (this.phase !== 'prep' || !this.selectedTrap || this.selectedTrap === 'heart') return;
    const index = this.traps.findIndex(t => t.id === this.selectedTrap); if (index < 0) return;
    const refund = Math.floor(this.traps[index].pricePaid / 2); this.coins += refund; this.traps.splice(index, 1);
    this.selectedTrap = null; this.message = `Механизм разобран: +${refund} золота.`; this.emit();
  }

  upgradeHeart() {
    if (this.phase !== 'prep' || this.heartLevel >= 10) return;
    const price = 22 + this.heartLevel * 7;
    if (this.coins < price) { this.message = 'Не хватает золота.'; this.emit(); return; }
    this.coins -= price; this.heartLevel++; this.stats.spentHeart += price; this.stats.maxHeartLevel = Math.max(this.stats.maxHeartLevel, this.heartLevel);
    this.perkChoices = this.pickPerks(); this.phase = 'perk'; this.selectedTrap = null; this.message = 'Сердце пробудило новую силу.'; this.emit();
  }

  repairHeart() {
    if (this.phase !== 'prep' || this.hp >= this.maxHp || this.coins < this.repairCost) return;
    this.coins -= this.repairCost; this.stats.spentRepair += this.repairCost; this.hp = Math.min(this.maxHp, this.hp + 24); this.repairCost += 4; this.message = 'Трещины сердца затянулись.'; this.emit();
  }

  choosePerk(id: string) {
    if (this.phase !== 'perk') return;
    this.perks.push(id); this.perkChoices = []; this.phase = 'prep'; this.message = `${PERKS.find(p => p.id === id)?.name} добавлен в билд.`; this.emit();
  }

  private pickPerks() {
    const pool = PERKS.filter(p => !this.perks.includes(p.id) && (!p.prerequisite || this.perks.includes(p.prerequisite)));
    const out: PerkDef[] = [];
    while (out.length < Math.min(3, pool.length)) {
      const p = pool[Math.floor(this.rand() * pool.length)]; if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  startWave() {
    if (this.phase !== 'prep') return;
    if (this.moveMode || this.movingTrap) { this.message = 'Сначала подтверди расстановку галочкой.'; this.emit(); return; }
    this.phase = 'combat'; this.selectedOffer = null; this.selectedTrap = null; this.terrainMode = null; this.paused = false;
    this.routeLayer.visible = false;
    this.message = `Волна ${this.wave}: герои входят в подземелье.`;
    this.spawnWave(); this.emit();
  }

  togglePause() { if (this.phase === 'combat') { this.paused = !this.paused; this.emit(); } }
  toggleSpeed() { if (this.phase === 'combat') { this.simSpeed = this.simSpeed === 1 ? 2 : 1; this.emit(); } }

  private spawnWave() {
    const preview = this.preview;
    const roster: EnemyKind[] = [];
    (Object.keys(preview) as EnemyKind[]).forEach(kind => { for (let i = 0; i < preview[kind]; i++) roster.push(kind); });
    for (let i = roster.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [roster[i], roster[j]] = [roster[j], roster[i]]; }
    const newestShare = this.activeEntrances > 1 ? .2 : 1;
    const weights = this.activeEntrances === 1 ? [1] : Array.from({ length: this.activeEntrances }, (_, i) => i === this.activeEntrances - 1 ? newestShare : (1 - newestShare) / (this.activeEntrances - 1));
    const entranceFor = (index: number) => {
      const sample = (index * .61803398875 + .17) % 1; let cumulative = 0;
      for (let i = 0; i < weights.length; i++) { cumulative += weights[i]; if (sample <= cumulative) return i; }
      return weights.length - 1;
    };
    const spawnDelayFor = (index: number) => {
      if (this.stage.archetype === 'Зелёная волна') return index * .1;
      if (this.stage.archetype === 'Железное шествие') return Math.floor(index / 7) * 1.35 + (index % 7) * .11;
      if (this.stage.archetype === 'Осада со всех сторон') return index * .14;
      return index * .17;
    };
    this.spawnQueue = roster.map((kind, i) => {
      const def = ENEMIES[kind];
      const entrance = entranceFor(i);
      const p = this.stage.entrances[entrance];
      const scale = enemyHpScale(this.wave);
      return { id: this.nextEnemyId++, kind, x: BOARD_X + (p.x + .5) * CELL + (this.rand() - .5) * 20, y: BOARD_Y + (p.y + .5) * CELL + (this.rand() - .5) * 14,
        vx: 0, vy: 0, hp: def.hp * scale, maxHp: def.hp * scale, speed: def.speed * (1 + this.wave * .01), radius: def.radius, mass: def.mass,
        baseDamage: def.baseDamage, aura: null, auraSource: null, auraTime: 0, sourceLevel: 1, frozen: 0, hit: false, flying: !!def.flying, dead: false,
        spawnDelay: spawnDelayFor(i), entrance, angle: 0,
        laneBias: this.rand() * 2 - 1, lastCellX: p.x, lastCellY: p.y, impulseTime: 0 };
    });
    this.enemies = [...this.spawnQueue];
  }

  private tick = (ticker: { deltaMS: number }) => {
    const raw = Math.min(ticker.deltaMS / 1000, .05);
    this.elapsed += raw;
    if (!this.paused && this.phase === 'combat') {
      this.fixedAccumulator = Math.min(.2, this.fixedAccumulator + raw * this.simSpeed);
      const step = 1 / 30;
      while (this.fixedAccumulator >= step && this.phase === 'combat') {
        this.fixedAccumulator -= step;
        this.blazeCooldown = Math.max(0, this.blazeCooldown - step);
        this.updateEnemies(step); this.updateTraps(step); this.updateHeart(step); this.updateBursts(step);
        if (this.hp <= 0) this.finish(false);
        else if (this.enemies.length > 0 && this.enemies.every(e => e.dead)) this.completeWave();
      }
      this.snapshotTimer += raw;
      if (this.snapshotTimer >= .25) { this.snapshotTimer = 0; this.emit(); }
    } else this.updateBursts(raw);
    this.drawDynamic();
  };

  private updateEnemies(dt: number) {
    const alive = this.enemies.filter(e => !e.dead && e.spawnDelay <= 0);
    const bucketSize = 48;
    const buckets = new Map<string, Enemy[]>();
    const density = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    for (const e of alive) {
      const key = `${Math.floor(e.x / bucketSize)},${Math.floor(e.y / bucketSize)}`;
      const bucket = buckets.get(key); if (bucket) bucket.push(e); else buckets.set(key, [e]);
      const cx = Math.max(0, Math.min(COLS - 1, Math.floor((e.x - BOARD_X) / CELL)));
      const cy = Math.max(0, Math.min(ROWS - 1, Math.floor((e.y - BOARD_Y) / CELL)));
      density[cy][cx]++;
    }
    this.neighborChecks = 0;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (enemy.spawnDelay > 0) { enemy.spawnDelay -= dt; continue; }
      enemy.auraTime -= dt; if (enemy.auraTime <= 0) { enemy.aura = null; enemy.auraSource = null; }
      enemy.frozen = Math.max(0, enemy.frozen - dt);
      if (enemy.aura === 'fire') {
        const burn = 4 * dt * (this.perks.includes('burn') ? 1.7 : 1);
        this.damageEnemy(enemy, burn, 'burn');
        const source = enemy.auraSource ?? 'unknown'; this.stats.burnDamage[source] = (this.stats.burnDamage[source] ?? 0) + burn;
      }
      const gx = Math.max(0, Math.min(COLS - 1, Math.floor((enemy.x - BOARD_X) / CELL)));
      const gy = Math.max(0, Math.min(ROWS - 1, Math.floor((enemy.y - BOARD_Y) / CELL)));
      if (!enemy.flying && this.touchesTerrain(enemy, 'pit')) { enemy.dead = true; this.stats.killed++; this.stats.pitKills++; this.burst(enemy.x, enemy.y, 0x17111f, 'pit', 42); continue; }
      if (this.grid[gy][gx] === 'heart') { enemy.dead = true; this.hp -= enemy.baseDamage; this.stats.leaked++; this.stats.damageTaken += enemy.baseDamage; this.burst(enemy.x, enemy.y, 0xff4c5b, 'hit', 34); this.emit(); continue; }

      const field = enemy.flying ? this.flyFlow : this.flow;
      const options = [{ x: gx + 1, y: gy }, { x: gx - 1, y: gy }, { x: gx, y: gy + 1 }, { x: gx, y: gy - 1 }]
        .filter(n => n.x >= 0 && n.y >= 0 && n.x < COLS && n.y < ROWS && Number.isFinite(field[n.y][n.x]) && field[n.y][n.x] <= field[gy][gx] + 1);
      const forward = options.filter(n => n.x !== enemy.lastCellX || n.y !== enemy.lastCellY);
      const pool = forward.length ? forward : options;
      let bx = gx, by = gy, bestScore = Infinity;
      for (const n of pool) {
        const progressPenalty = field[n.y][n.x] > field[gy][gx] ? .7 : 0;
        const noise = Math.sin(enemy.id * 12.9898 + n.x * 78.233 + n.y * 37.719) * .16;
        const score = field[n.y][n.x] + progressPenalty + density[n.y][n.x] * .13 + noise;
        if (score < bestScore) { bestScore = score; bx = n.x; by = n.y; }
      }
      if (bx !== gx || by !== gy) { enemy.lastCellX = gx; enemy.lastCellY = gy; }
      let tx = BOARD_X + (bx + .5) * CELL, ty = BOARD_Y + (by + .5) * CELL;
      if (bx === gx) tx += enemy.laneBias * CELL * .27;
      if (by === gy) ty += enemy.laneBias * CELL * .27;
      let dx = tx - enemy.x, dy = ty - enemy.y; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      let sx = 0, sy = 0;
      if (!enemy.flying) {
        const bxx = Math.floor(enemy.x / bucketSize), byy = Math.floor(enemy.y / bucketSize);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) for (const other of buckets.get(`${bxx + ox},${byy + oy}`) ?? []) {
          this.neighborChecks++;
          if (other === enemy || other.flying) continue;
          const ox2 = enemy.x - other.x, oy2 = enemy.y - other.y, d2 = ox2 * ox2 + oy2 * oy2, min = enemy.radius + other.radius + 5;
          if (d2 > .01 && d2 < min * min) {
            const d = Math.sqrt(d2), overlap = (min - d) / min;
            sx += ox2 / d * overlap * (70 + density[gy][gx] * 3); sy += oy2 / d * overlap * (70 + density[gy][gx] * 3);
          }
        }
      }
      const slow = enemy.frozen > 0 ? 0 : enemy.aura === 'frost' ? .55 : 1;
      enemy.impulseTime = Math.max(0, enemy.impulseTime - dt);
      const traction = enemy.impulseTime > 0 ? .45 : enemy.aura === 'water' ? 1.05 : 5.4;
      const desiredX = dx * enemy.speed * slow + sx / enemy.mass, desiredY = dy * enemy.speed * slow + sy / enemy.mass;
      const blend = Math.min(1, traction * dt); enemy.vx += (desiredX - enemy.vx) * blend; enemy.vy += (desiredY - enemy.vy) * blend;
      enemy.x += enemy.vx * dt; enemy.y += enemy.vy * dt;
      if (!enemy.flying) {
        const impact = this.resolveTerrainCollision(enemy);
        if (impact > 105 && this.perks.includes('impact')) this.damageEnemy(enemy, Math.min(35, impact * .18), 'impact');
      } else {
        this.resolveTerrainCollision(enemy);
      }
      if (Math.hypot(enemy.vx, enemy.vy) > 2) enemy.angle = Math.atan2(enemy.vy, enemy.vx) + Math.PI / 2;
    }
  }

  private touchesTerrain(enemy: Enemy, kind: CellKind) {
    const minX = Math.max(0, Math.floor((enemy.x - enemy.radius - BOARD_X) / CELL));
    const maxX = Math.min(COLS - 1, Math.floor((enemy.x + enemy.radius - BOARD_X) / CELL));
    const minY = Math.max(0, Math.floor((enemy.y - enemy.radius - BOARD_Y) / CELL));
    const maxY = Math.min(ROWS - 1, Math.floor((enemy.y + enemy.radius - BOARD_Y) / CELL));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (this.grid[y][x] !== kind) continue;
      const rx = BOARD_X + x * CELL, ry = BOARD_Y + y * CELL;
      const cx = Math.max(rx, Math.min(enemy.x, rx + CELL)), cy = Math.max(ry, Math.min(enemy.y, ry + CELL));
      if ((enemy.x - cx) ** 2 + (enemy.y - cy) ** 2 < enemy.radius ** 2) return true;
    }
    return false;
  }

  private resolveTerrainCollision(enemy: Enemy) {
    let strongestImpact = 0;
    const minX = Math.max(0, Math.floor((enemy.x - enemy.radius - BOARD_X) / CELL));
    const maxX = Math.min(COLS - 1, Math.floor((enemy.x + enemy.radius - BOARD_X) / CELL));
    const minY = Math.max(0, Math.floor((enemy.y - enemy.radius - BOARD_Y) / CELL));
    const maxY = Math.min(ROWS - 1, Math.floor((enemy.y + enemy.radius - BOARD_Y) / CELL));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (['floor', 'heart', 'pit'].includes(this.grid[y][x])) continue;
      const rx = BOARD_X + x * CELL, ry = BOARD_Y + y * CELL;
      const cx = Math.max(rx, Math.min(enemy.x, rx + CELL)), cy = Math.max(ry, Math.min(enemy.y, ry + CELL));
      let dx = enemy.x - cx, dy = enemy.y - cy, d = Math.hypot(dx, dy);
      if (d >= enemy.radius) continue;
      if (d < .001) {
        const left = Math.abs(enemy.x - rx), right = Math.abs(rx + CELL - enemy.x), top = Math.abs(enemy.y - ry), bottom = Math.abs(ry + CELL - enemy.y);
        const m = Math.min(left, right, top, bottom);
        dx = m === left ? -1 : m === right ? 1 : 0; dy = m === top ? -1 : m === bottom ? 1 : 0; d = 1;
      }
      const nx = dx / d, ny = dy / d, penetration = enemy.radius - d;
      const impact = Math.abs(enemy.vx * nx + enemy.vy * ny); strongestImpact = Math.max(strongestImpact, impact);
      enemy.x += nx * penetration; enemy.y += ny * penetration;
      const vn = enemy.vx * nx + enemy.vy * ny;
      if (vn < 0) { enemy.vx -= vn * nx * 1.25; enemy.vy -= vn * ny * 1.25; }
    }
    enemy.x = Math.max(BOARD_X + enemy.radius, Math.min(BOARD_X + BOARD_W - enemy.radius, enemy.x));
    enemy.y = Math.max(BOARD_Y + enemy.radius, Math.min(BOARD_Y + BOARD_H - enemy.radius, enemy.y));
    return strongestImpact;
  }

  private updateTraps(dt: number) {
    for (const trap of this.traps) {
      const def = TRAPS[trap.trapId]; const levelScale = [0, 1, 1.5, 2][trap.level];
      trap.shape.forEach((p, i) => {
        trap.cooldowns[i] -= dt; if (trap.cooldowns[i] > 0) return;
        const cellX = trap.origin.x + p.x, cellY = trap.origin.y + p.y;
        const x = BOARD_X + (cellX + .5) * CELL, y = BOARD_Y + (cellY + .5) * CELL;
        const candidates = this.targetsForSegment(def.id, cellX, cellY, x, y);
        if (!candidates.length) return;
        const count = Math.min(TRAP_TARGET_CAPS[def.id] ?? 1, candidates.length);
        candidates.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
        const perkScale = (def.placement === 'floor' && this.perks.includes('floor') ? 1.35 : 1) * (def.element === 'fire' && this.perks.includes('hotter') ? 1.4 : 1) * (def.impulse && this.perks.includes('pressure') ? 1.25 : 1);
        for (const target of candidates.slice(0, count)) {
          const damage = def.damage * levelScale * perkScale; this.damageEnemy(target, damage, def.id); this.stats.trapDamage[def.id] = (this.stats.trapDamage[def.id] || 0) + damage;
          if (def.element) this.applyElement(target, def.element, trap.level, def.id);
          if (def.impulse) { const d = Math.hypot(target.x - x, target.y - y) || 1; const force = def.impulse * (this.perks.includes('pressure') ? 1.55 : 1) / target.mass; target.vx += (target.x - x) / d * force; target.vy += (target.y - y) / d * force; target.impulseTime = .38; }
          if (def.placement === 'wall') this.beam(x, y, target.x, target.y, def.accent, def.id, def.id === 'jet' ? 9 : def.id === 'flame' ? 13 : 4);
        }
        trap.cooldowns[i] = def.cooldown * (def.placement === 'floor' && this.perks.includes('reset') ? .75 : 1);
        this.burst(x, y, def.accent, def.id, def.radius * .7);
      });
    }
  }

  private targetsForSegment(trapId: string, cellX: number, cellY: number, x: number, y: number) {
    const def = TRAPS[trapId];
    const living = this.enemies.filter(e => !e.dead && e.spawnDelay <= 0 && (!e.flying || def.placement === 'wall'));
    if (def.placement === 'floor') {
      if (['mine', 'geyser'].includes(trapId)) return living.filter(e => Math.hypot(e.x - x, e.y - y) <= def.radius + e.radius);
      const left = BOARD_X + cellX * CELL, top = BOARD_Y + cellY * CELL;
      return living.filter(e => e.x + e.radius >= left + 5 && e.x - e.radius <= left + CELL - 5 && e.y + e.radius >= top + 5 && e.y - e.radius <= top + CELL - 5);
    }
    const faces = this.openFaces(cellX, cellY);
    return living.filter(e => faces.some(face => {
      const dx = e.x - x, dy = e.y - y;
      const forward = dx * face.x + dy * face.y;
      const side = Math.abs(dx * -face.y + dy * face.x);
      if (forward < CELL * .35 || forward > def.radius + e.radius) return false;
      if (trapId === 'flame') return side <= 15 + forward * .62;
      if (trapId === 'tesla') return side <= Math.max(28, forward * .9);
      if (trapId === 'piston') return side <= 24 + e.radius;
      return side <= 15 + e.radius;
    }));
  }

  private applyElement(enemy: Enemy, element: Exclude<ElementType, null>, sourceLevel: number, sourceTrapId: string) {
    if (!enemy.aura || enemy.aura === element) { enemy.aura = element; enemy.auraSource = sourceTrapId; enemy.auraTime = element === 'fire' && this.perks.includes('burn') ? 6 : 4; enemy.sourceLevel = sourceLevel; return; }
    const prior = enemy.aura; const name = reactionName(prior, element); const avgLevel = (sourceLevel + enemy.sourceLevel) / 2;
    const primer = enemy.auraSource ?? 'unknown'; enemy.aura = null; enemy.auraSource = null; enemy.auraTime = 0;
    this.stats.reactionCount[name] = (this.stats.reactionCount[name] || 0) + 1;
    this.stats.primerCount[primer] = (this.stats.primerCount[primer] || 0) + 1;
    this.stats.triggerCount[sourceTrapId] = (this.stats.triggerCount[sourceTrapId] || 0) + 1;
    const color = name === 'ПАР' ? 0xe7f4ef : name === 'ТЕРМОУДАР' ? 0xffffff : name === 'ПЕРЕГРУЗКА' ? 0xb95cff : name === 'ЗАМОРОЗКА' ? 0xcaf6ff : name === 'ПРОВОДИМОСТЬ' ? 0x9c6cff : 0xaeeeff;
    if (name === 'ЗАМОРОЗКА') enemy.frozen = 1.2 + .25 * avgLevel;
    else { const reactionDamage = 18 * avgLevel; this.damageEnemy(enemy, reactionDamage, `reaction:${name}`); this.stats.reactionDamage[name] = (this.stats.reactionDamage[name] || 0) + reactionDamage; }
    if (['ПАР', 'ПЕРЕГРУЗКА'].includes(name)) for (const other of this.enemies) {
      if (!other.dead && other !== enemy && Math.hypot(other.x - enemy.x, other.y - enemy.y) < 52) {
        const reactionDamage = 11 * avgLevel; this.damageEnemy(other, reactionDamage, `reaction:${name}`); this.stats.reactionDamage[name] = (this.stats.reactionDamage[name] || 0) + reactionDamage;
        const dx = other.x - enemy.x, dy = other.y - enemy.y, d = Math.hypot(dx, dy) || 1, force = (name === 'ПЕРЕГРУЗКА' ? 105 : 55) / other.mass;
        other.vx += dx / d * force; other.vy += dy / d * force; other.impulseTime = .3;
      }
    }
    if (name === 'ПРОВОДИМОСТЬ') {
      const chain = this.enemies.filter(e => !e.dead && e !== enemy && Math.hypot(e.x - enemy.x, e.y - enemy.y) < 90).slice(0, 3);
      let from = enemy;
      chain.forEach(e => { const reactionDamage = 12 * avgLevel; this.damageEnemy(e, reactionDamage, `reaction:${name}`); this.stats.reactionDamage[name] = (this.stats.reactionDamage[name] || 0) + reactionDamage; this.beam(from.x, from.y, e.x, e.y, 0xad65ff, 'conduct', 3); from = e; });
    }
    if (name === 'ЛЕДЯНОЙ РАСКОЛ') {
      const base = Math.atan2(enemy.vy, enemy.vx);
      for (let i = -2; i <= 2; i++) this.beam(enemy.x, enemy.y, enemy.x + Math.cos(base + i * .18) * 75, enemy.y + Math.sin(base + i * .18) * 75, i % 2 ? 0xa968ff : 0xcaf6ff, 'shatter', 3);
      for (const other of this.enemies.filter(e => !e.dead && e !== enemy)) {
        const dx = other.x - enemy.x, dy = other.y - enemy.y, distance = Math.hypot(dx, dy);
        let delta = Math.atan2(dy, dx) - base; delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        if (distance < 88 && Math.abs(delta) < .55) { const reactionDamage = 14 * avgLevel; this.damageEnemy(other, reactionDamage, `reaction:${name}`); this.stats.reactionDamage[name] = (this.stats.reactionDamage[name] || 0) + reactionDamage; }
      }
    }
    this.burst(enemy.x, enemy.y, color, name, 58);
    if (this.rand() < .32) {
      const aggregate = this.floatTexts.find(t => t.baseText === name && t.age < .18 && Math.hypot(t.x - enemy.x, t.y - enemy.y) < 85);
      if (aggregate) { aggregate.count++; aggregate.text = `${name} ×${aggregate.count}`; aggregate.age = 0; aggregate.x = (aggregate.x + enemy.x) / 2; aggregate.y = Math.min(aggregate.y, enemy.y - 18); }
      else if (this.floatTexts.filter(t => t.age < .8).length < 3) this.floatTexts.push({ x: enemy.x, y: enemy.y - 18, age: 0, text: name, baseText: name, count: 1, color });
    }
  }

  private updateHeart(dt: number) {
    this.heartCooldown -= dt; if (this.heartCooldown > 0) return;
    const living = this.enemies.filter(e => !e.dead && e.spawnDelay <= 0); if (!living.length) return;
    const hx = BOARD_X + (this.stage.heart.x + 1) * CELL, hy = BOARD_Y + (this.stage.heart.y + 1) * CELL;
    living.sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy));
    const shots = Math.min(this.heartLevel, living.length);
    const floorSegments = this.traps.filter(t => TRAPS[t.trapId].placement === 'floor').reduce((sum, t) => sum + t.shape.length, 0);
    const baseDamage = HEART_SHOT_DAMAGE * (this.perks.includes('arrows') ? 1.35 : 1) * (this.perks.includes('positions') ? Math.min(1.3, 1 + floorSegments * .012) : 1);
    this.volleyCount++; const double = this.perks.includes('volley') && this.volleyCount % 4 === 0;
    for (let i = 0; i < shots; i++) {
      const target = living[i];
      const situational = (this.perks.includes('fireSpotters') && target.aura === 'fire' ? 1.35 : 1) * (this.perks.includes('marked') && this.isOnFloorTrap(target) ? 1.25 : 1) * (this.perks.includes('observers') && (target.aura === 'water' || target.flying || target.impulseTime > 0) ? 1.35 : 1);
      const damage = baseDamage * situational * (double ? 2 : 1);
      this.damageEnemy(target, damage, 'heart'); this.stats.heartDamage += damage; this.beam(hx, hy, target.x, target.y, 0xf4c86e, 'arrow', 3); this.burst(target.x, target.y, 0xf4c86e, 'arrow-hit', 20);
      if (this.perks.includes('pierce')) {
        const secondary = living.find(e => e !== target && !e.dead && Math.hypot(e.x - target.x, e.y - target.y) < 55);
        if (secondary) { this.damageEnemy(secondary, damage * .55, 'heart'); this.stats.heartDamage += damage * .55; }
      }
      if (this.perks.includes('ram') && this.volleyCount % 6 === 0 && !target.dead) {
        const dx = target.x - hx, dy = target.y - hy, d = Math.hypot(dx, dy) || 1;
        target.vx += dx / d * 145 / target.mass; target.vy += dy / d * 145 / target.mass; target.impulseTime = .45;
      }
    }
    if (this.perks.includes('rain') && this.volleyCount % 10 === 0) for (const target of living.slice(0, 12)) {
      this.damageEnemy(target, baseDamage * .7, 'heart'); this.stats.heartDamage += baseDamage * .7; this.burst(target.x, target.y, 0xf8d88b, 'arrow-rain', 28);
    }
    this.heartCooldown = HEART_SHOT_COOLDOWN;
  }

  private isOnFloorTrap(enemy: Enemy) {
    const x = Math.floor((enemy.x - BOARD_X) / CELL), y = Math.floor((enemy.y - BOARD_Y) / CELL);
    return this.traps.some(t => TRAPS[t.trapId].placement === 'floor' && t.shape.some(p => t.origin.x + p.x === x && t.origin.y + p.y === y));
  }

  private damageEnemy(enemy: Enemy, amount: number, _source: string) {
    if (enemy.dead) return;
    const wasBurning = enemy.aura === 'fire';
    const vulnerability = enemy.aura === 'storm' ? 1.25 : 1;
    const shield = enemy.kind === 'shield' && !enemy.aura ? .55 : 1;
    enemy.hp -= amount * vulnerability * shield; enemy.hit = true;
    if (enemy.hp <= 0) {
      enemy.dead = true; this.stats.killed++; this.bountyProgress += ENEMIES[enemy.kind].reward * BOUNTY_COIN_FACTOR;
      const payout = Math.floor(this.bountyProgress); if (payout > 0) { this.coins += payout; this.bountyProgress -= payout; }
      this.burst(enemy.x, enemy.y, ENEMIES[enemy.kind].accent, 'death', 26);
      if (wasBurning && this.perks.includes('blaze') && this.blazeCooldown <= 0) {
        this.blazeCooldown = .16;
        for (const other of this.enemies.filter(e => !e.dead && Math.hypot(e.x - enemy.x, e.y - enemy.y) < 58).slice(0, 8)) this.damageEnemy(other, 22, 'blaze');
        this.burst(enemy.x, enemy.y, 0xff7042, 'blaze', 62);
      }
    }
  }

  private completeWave() {
    this.stats.wavesCleared = this.wave;
    if (this.wave >= 10) { this.finish(true); return; }
    const reward = waveClearReward(this.wave); this.coins += reward; this.wave++;
    this.activeEntrances = activeEntranceCount(this.wave, this.stage.entrances.length);
    this.phase = 'prep'; this.routeLayer.visible = true; this.rerollCost = 3; this.digActionsThisWave = 0; this.buildActionsThisWave = 0;
    this.refreshShop(); this.message = `Волна очищена. +${reward} золота. Готовься к волне ${this.wave}.`; this.emit();
  }

  private finish(win: boolean) {
    this.phase = 'result'; this.hp = Math.max(0, this.hp);
    if (!win) this.stats.wavesCleared = Math.max(this.stats.wavesCleared, this.wave);
    this.stars = win ? (this.hp / this.maxHp >= .8 ? 3 : this.hp / this.maxHp >= .5 ? 2 : 1) : 0;
    this.message = win ? 'Dungeon Heart выстояло. Герои стали удобрением.' : 'Dungeon Heart разрушено.'; this.emit();
  }

  private burst(x: number, y: number, color: number, kind: string, size: number) {
    const reaction = ['ПАР', 'ТЕРМОУДАР', 'ПЕРЕГРУЗКА', 'ЗАМОРОЗКА', 'ПРОВОДИМОСТЬ', 'ЛЕДЯНОЙ РАСКОЛ'].includes(kind);
    const aggregate = reaction ? this.bursts.find(b => b.kind === kind && b.age < .11 && Math.hypot(b.x - x, b.y - y) < 52) : undefined;
    if (aggregate) { aggregate.x = (aggregate.x + x) / 2; aggregate.y = (aggregate.y + y) / 2; aggregate.size = Math.min(86, aggregate.size + size * .18); aggregate.age = 0; }
    else this.bursts.push({ x, y, age: 0, life: .35 + this.rand() * .25, color, kind, size });
    this.emitParticles(x, y, color, kind, size, aggregate ? .4 : 1);
  }
  private beam(x: number, y: number, x2: number, y2: number, color: number, kind: string, width: number) { this.beams.push({ x, y, x2, y2, age: 0, life: kind === 'arrow' ? .2 : kind === 'jet' || kind === 'flame' ? .2 : .12, color, kind, width }); }
  private updateBursts(dt: number) {
    this.bursts.forEach(b => b.age += dt); this.bursts = this.bursts.filter(b => b.age < b.life);
    this.beams.forEach(b => b.age += dt); this.beams = this.beams.filter(b => b.age < b.life);
    this.floatTexts.forEach(t => t.age += dt); this.floatTexts = this.floatTexts.filter(t => t.age < 1.05);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.age += dt;
      if (p.age >= p.life) {
        (p.layer === 'soft' ? this.softParticleLayer : this.sharpParticleLayer).removeParticle(p.view);
        this.particlePool[p.layer].push(p.view); this.particles.splice(i, 1); continue;
      }
      const t = p.age / p.life, scale = p.startScale + (p.endScale - p.startScale) * t;
      p.vy += p.gravity * dt; p.view.x += p.vx * dt; p.view.y += p.vy * dt; p.view.rotation += p.spin * dt;
      p.view.scaleX = scale; p.view.scaleY = scale; p.view.alpha = p.alpha * (1 - t) * (1 - t * .2);
    }
  }

  private emitParticles(x: number, y: number, color: number, kind: string, size: number, intensity: number) {
    if (!this.particleTextures.soft || !this.particleTextures.sharp) return;
    const reaction = ['ПАР', 'ТЕРМОУДАР', 'ПЕРЕГРУЗКА', 'ЗАМОРОЗКА', 'ПРОВОДИМОСТЬ', 'ЛЕДЯНОЙ РАСКОЛ'].includes(kind);
    const stressed = this.app.ticker.deltaMS > 38 || this.particles.length > 420;
    const baseCount = reaction ? (kind === 'ПАР' ? 10 : 8) : 3;
    const count = Math.max(1, Math.round(baseCount * intensity * (stressed ? .5 : 1)));
    if (this.particles.length >= 560) return;
    for (let i = 0; i < count && this.particles.length < 560; i++) {
      const soft = kind === 'ПАР' || ['flame', 'ember', 'death', 'pit', 'geyser', 'jet'].includes(kind) || (!reaction && i % 3 === 0);
      const layer: 'soft' | 'sharp' = soft ? 'soft' : 'sharp';
      const texture = this.particleTextures[layer]!;
      const view = this.particlePool[layer].pop() ?? new Particle({ texture, anchorX: .5, anchorY: .5 });
      view.texture = texture; view.x = x + (this.rand() - .5) * 8; view.y = y + (this.rand() - .5) * 8; view.rotation = this.rand() * Math.PI * 2;
      view.tint = kind === 'ПЕРЕГРУЗКА' && i % 3 === 0 ? 0xffdc66 : color; view.alpha = 1;
      const angle = this.rand() * Math.PI * 2, speed = (18 + this.rand() * (reaction ? 78 : 40)) * Math.min(1.35, size / 40);
      const startScale = soft ? .12 + this.rand() * .16 : .16 + this.rand() * .13;
      const particle: FxParticle = { view, layer, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, age: 0, life: soft ? .28 + this.rand() * .3 : .16 + this.rand() * .22, startScale, endScale: soft ? startScale * 2.2 : startScale * .45, spin: (this.rand() - .5) * 8, gravity: kind === 'ПАР' ? -18 : 18, alpha: soft ? .54 : .9 };
      view.scaleX = startScale; view.scaleY = startScale;
      (layer === 'soft' ? this.softParticleLayer : this.sharpParticleLayer).addParticle(view); this.particles.push(particle);
    }
  }

  private shakeBoard() {
    this.root.x = 5; setTimeout(() => { this.root.x = -4; setTimeout(() => { this.root.x = 0; }, 55); }, 55);
  }

  private drawTerrain() {
    const g = this.terrainLayer; g.clear();
    this.terrainSpriteLayer.removeChildren().forEach(child => child.destroy());
    g.roundRect(BOARD_X - 9, BOARD_Y - 7, BOARD_W + 18, BOARD_H + 14, 12).fill({ color: 0x15111a }).stroke({ color: 0x4d3b4b, width: 3 });
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const px = BOARD_X + x * CELL, py = BOARD_Y + y * CELL, cell = this.grid[y][x];
      if (cell === 'floor' || cell === 'heart') {
        const alt = ((x * 11 + y * 7 + this.stage.seed) & 3) === 0;
        g.rect(px, py, CELL, CELL).fill(alt ? 0x4c414d : 0x473c48).stroke({ color: 0x695b68, width: 1, alpha: .36 });
      } else if (cell === 'pit') {
        g.rect(px, py, CELL, CELL).fill(0x08060b);
        g.roundRect(px + 7, py + 7, CELL - 14, CELL - 14, 15).fill(0x030205).stroke({ color: 0x624668, width: 3, alpha: .8 });
      } else {
        const built = cell === 'built', eternal = cell === 'eternal';
        const fill = eternal ? 0x0b0c12 : built ? 0x55463d : 0x1e1921;
        const edge = eternal ? 0x45475b : built ? 0x9a7b59 : 0x574454;
        g.rect(px, py, CELL, CELL).fill(fill);
        if (built) {
          g.moveTo(px, py + CELL / 2).lineTo(px + CELL, py + CELL / 2).stroke({ color: edge, width: 3, alpha: .62 });
          g.moveTo(px + CELL / 2, py).lineTo(px + CELL / 2, py + CELL / 2).stroke({ color: edge, width: 3, alpha: .45 });
        } else if (eternal) {
          g.poly([px + 36, py + 10, px + 61, py + 35, px + 36, py + 62, px + 11, py + 35]).stroke({ color: 0x5b5972, width: 3, alpha: .48 });
        }
        for (const face of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
          const nx = x + face.x, ny = y + face.y;
          const neighbor = nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS ? this.grid[ny][nx] : null;
          const solidNeighbor = neighbor && ['rock', 'eternal', 'built'].includes(neighbor);
          if (solidNeighbor) continue;
          if (face.x === 1) g.moveTo(px + CELL - 2, py).lineTo(px + CELL - 2, py + CELL).stroke({ color: edge, width: 5 });
          if (face.x === -1) g.moveTo(px + 2, py + CELL).lineTo(px + 2, py).stroke({ color: edge, width: 5 });
          if (face.y === 1) g.moveTo(px + CELL, py + CELL - 2).lineTo(px, py + CELL - 2).stroke({ color: edge, width: 5 });
          if (face.y === -1) g.moveTo(px, py + 2).lineTo(px + CELL, py + 2).stroke({ color: edge, width: 5 });
        }
      }
    }
    for (const e of this.stage.entrances) {
      const x = BOARD_X + (e.x + .5) * CELL, y = BOARD_Y + (e.y + .5) * CELL;
      g.circle(x, y, 18).fill(0x151019).stroke({ color: 0xd05b59, width: 4 });
      g.circle(x, y, 7).fill(0xf37565);
    }
    const hx = BOARD_X + (this.stage.heart.x + 1) * CELL, hy = BOARD_Y + (this.stage.heart.y + 1) * CELL;
    g.roundRect(hx - 59, hy - 59, 118, 118, 30).fill(0x251c27).stroke({ color: 0x8f4c59, width: 6 });
    for (const [ox, oy] of [[-43, -43], [43, -43], [-43, 43], [43, 43]]) g.circle(hx + ox, hy + oy, 10).fill(0x4b3541).stroke({ color: 0xb36a6c, width: 2 });
    g.circle(hx, hy, 38).fill(0x5f2030).stroke({ color: 0xf0676d, width: 4 });
    g.poly([hx, hy - 34, hx + 28, hy, hx, hy + 36, hx - 28, hy]).fill(0xe8455c).stroke({ color: 0xff8a8c, width: 3 });
    g.poly([hx, hy - 25, hx + 10, hy, hx, hy + 21, hx - 8, hy]).fill({ color: 0xff8791, alpha: .62 });
  }

  private drawDynamic() {
    this.drawRoutes(); this.drawTraps(); this.drawHeartDefenders(); this.drawEnemies(); this.drawVfx();
    if (this.debug) {
      const segments = this.traps.reduce((sum, trap) => sum + trap.shape.length, 0);
      this.debugText.text = `FPS ${Math.round(this.app.ticker.FPS)}  FRAME ${this.app.ticker.deltaMS.toFixed(1)}ms\nENEMIES ${this.enemies.filter(e => !e.dead && e.spawnDelay <= 0).length}  PARTICLES ${this.particles.length}  NEIGHBOR ${this.neighborChecks}\nTRAPS ${this.traps.length}/${segments} seg  SEED ${this.stage.seed}  WAVE ${this.wave}`;
    }
  }

  private drawHeartDefenders() {
    const g = this.heartLayer; g.clear();
    const hx = BOARD_X + (this.stage.heart.x + 1) * CELL, hy = BOARD_Y + (this.stage.heart.y + 1) * CELL;
    const pulse = .5 + .5 * Math.sin(this.elapsed * 3.4);
    g.circle(hx, hy, 43 + pulse * 4).stroke({ color: 0xff6a68, width: 2, alpha: .18 + pulse * .2 });
    const recoil = this.heartCooldown > .38 ? 3 : 0;
    for (let i = 0; i < this.heartLevel; i++) {
      const a = -Math.PI / 2 + i / Math.max(1, this.heartLevel) * Math.PI * 2;
      const x = hx + Math.cos(a) * 47, y = hy + Math.sin(a) * 47;
      g.ellipse(x + 1, y + 7, 10, 5).fill({ color: 0x09070c, alpha: .48 });
      g.circle(x, y, 7).fill(0x3c2a42).stroke({ color: 0xe2b967, width: 2 });
      g.circle(x, y - 4, 4).fill(0xd8c09c);
      const aim = a - Math.PI / 2;
      const weaponX = x + Math.cos(aim) * (7 - recoil), weaponY = y + Math.sin(aim) * (7 - recoil);
      g.circle(weaponX, weaponY, 3).fill({ color: 0xe2b967, alpha: .95 });
      g.circle(weaponX - Math.cos(aim) * 5, weaponY - Math.sin(aim) * 5, 1.5).fill({ color: 0xffefb0, alpha: .8 });
    }
  }

  private drawRoutes() {
    const g = this.routeLayer; g.clear(); if (this.phase !== 'prep') return;
    for (let i = 0; i < this.activeEntrances; i++) {
      let p = this.stage.entrances[i]; const points: Point[] = [p]; let guard = 0;
      while (this.flow[p.y][p.x] > 0 && guard++ < 60) {
        let best = p, value = this.flow[p.y][p.x];
        for (const n of [{ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 }]) if (n.x >= 0 && n.y >= 0 && n.x < COLS && n.y < ROWS && this.flow[n.y][n.x] < value) { best = n; value = this.flow[n.y][n.x]; }
        if (best === p) break; p = best; points.push(p);
      }
      if (points.length < 2) continue;
      for (let j = 0; j < points.length - 1; j++) {
        const a = points[j], b = points[j + 1];
        g.moveTo(BOARD_X + (a.x + .5) * CELL, BOARD_Y + (a.y + .5) * CELL).lineTo(BOARD_X + (b.x + .5) * CELL, BOARD_Y + (b.y + .5) * CELL).stroke({ color: 0xffd17b, width: 3, alpha: .09 });
      }
      const travel = (this.elapsed * 3.1 + i * 1.7) % Math.max(1, points.length - 1);
      const head = Math.floor(travel), local = travel - head;
      for (let tail = 5; tail >= 0; tail--) {
        const index = head - tail;
        if (index < 0 || index >= points.length - 1) continue;
        const a = points[index], b = points[index + 1];
        const endT = tail === 0 ? local : 1, alpha = (1 - tail / 6) * .72;
        const ax = BOARD_X + (a.x + .5) * CELL, ay = BOARD_Y + (a.y + .5) * CELL;
        const bx = BOARD_X + (a.x + (b.x - a.x) * endT + .5) * CELL, by = BOARD_Y + (a.y + (b.y - a.y) * endT + .5) * CELL;
        g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: 0xffd98a, width: 8, alpha });
      }
      const a = points[head], b = points[Math.min(points.length - 1, head + 1)];
      const hx = BOARD_X + (a.x + (b.x - a.x) * local + .5) * CELL, hy = BOARD_Y + (a.y + (b.y - a.y) * local + .5) * CELL;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      g.poly([hx + Math.cos(angle) * 13, hy + Math.sin(angle) * 13, hx + Math.cos(angle + 2.45) * 10, hy + Math.sin(angle + 2.45) * 10, hx + Math.cos(angle - 2.45) * 10, hy + Math.sin(angle - 2.45) * 10]).fill({ color: 0xffe2a0, alpha: .9 });
    }
  }

  private drawTraps() {
    const g = this.trapLayer; g.clear();
    const visibleSprites = new Set<string>();
    this.drawPlacementHints(g);
    for (const trap of this.traps) {
      const def = TRAPS[trap.trapId]; const selected = trap.id === this.selectedTrap;
      trap.shape.forEach((p, segmentIndex) => {
        const x = BOARD_X + (trap.origin.x + p.x) * CELL, y = BOARD_Y + (trap.origin.y + p.y) * CELL;
        const cooldown = trap.cooldowns[segmentIndex], ready = cooldown <= 0, triggered = cooldown > def.cooldown * .72;
        const spriteKey = `${trap.id}:${segmentIndex}`, texture = this.trapTextures[def.id];
        if (texture) {
          visibleSprites.add(spriteKey);
          let sprite = this.trapSprites.get(spriteKey);
          if (!sprite) { sprite = new Sprite(texture); sprite.anchor.set(.5); this.trapSpriteLayer.addChild(sprite); this.trapSprites.set(spriteKey, sprite); }
          const punch = triggered ? .9 : ready ? 1 + Math.sin(this.elapsed * 5 + segmentIndex) * .025 : .96;
          sprite.width = (CELL - 8) * punch; sprite.height = (CELL - 8) * punch; sprite.x = x + CELL / 2; sprite.y = y + CELL / 2;
          sprite.alpha = ready ? 1 : .84; sprite.tint = triggered ? 0xffd7bd : 0xffffff;
          if (def.placement === 'wall') {
            const faces = this.openFaces(trap.origin.x + p.x, trap.origin.y + p.y), primary = faces[0];
            sprite.rotation = primary ? Math.atan2(primary.y, primary.x) - Math.PI / 2 : 0;
            for (const face of faces) {
              const cx = x + CELL / 2, cy = y + CELL / 2;
              g.moveTo(cx + face.x * 22 - face.y * 5, cy + face.y * 22 + face.x * 5).lineTo(cx + face.x * 29, cy + face.y * 29).lineTo(cx + face.x * 22 + face.y * 5, cy + face.y * 22 - face.x * 5).stroke({ color: def.accent, width: 3, alpha: .9 });
            }
          } else sprite.rotation = 0;
        } else {
          if (def.placement === 'floor') {
            // Floor mechanisms are broad plates laid over the walkable tile.
            g.roundRect(x + 7, y + 7, CELL - 14, CELL - 14, 12).fill(def.color).stroke({ color: def.accent, width: 3, alpha: .9 });
            g.circle(x + 36, y + 36, 20).fill({ color: 0x15111a, alpha: .8 }).stroke({ color: def.accent, width: 2, alpha: .65 });
            for (const [ox, oy] of [[13, 13], [59, 13], [13, 59], [59, 59]]) g.circle(x + ox, y + oy, 2.4).fill({ color: 0xd9c6aa, alpha: .72 });
          } else {
            // Wall mechanisms stay compact. The untouched rock around the socket
            // is a permanent topological cue even when wall and floor traps touch.
            g.roundRect(x + 5, y + 5, CELL - 10, CELL - 10, 9).stroke({ color: 0x766070, width: 2, alpha: .72 });
            g.circle(x + 36, y + 36, 23).fill(0x121016).stroke({ color: 0x9a8391, width: 4, alpha: .9 });
            g.circle(x + 36, y + 36, 18).fill(def.color).stroke({ color: def.accent, width: 3, alpha: .95 });
          }
          if (def.id === 'spikes') for (let i = 0; i < 4; i++) { const tip = triggered ? 13 : 25; g.poly([x + 14 + i * 11, y + 49, x + 19 + i * 11, y + tip, x + 24 + i * 11, y + 49]).fill(def.accent); }
          else if (def.id === 'piston') { g.roundRect(x + 17, y + 27, 38, 18, 5).fill(def.accent); g.rect(x + 29, y + 15, 14, 42).fill({ color: 0xf3d38b, alpha: .55 }); }
          else if (def.id === 'flame') { g.circle(x + 36, y + 36, 13).fill(0x09070b).stroke({ color: 0xff8a32, width: 5 }); for (let a = 0; a < 4; a++) { const angle = a * Math.PI / 2; g.circle(x + 36 + Math.cos(angle) * 23, y + 36 + Math.sin(angle) * 23, 4).fill(0xff8a32); } }
          else if (def.id === 'frost') { for (let a = 0; a < 3; a++) { const angle = a * Math.PI / 3; g.moveTo(x + 19 + Math.cos(angle) * 1, y + 36 + Math.sin(angle) * 1).lineTo(x + 53, y + 36).stroke({ color: def.accent, width: 4 }); g.moveTo(x + 36, y + 19).lineTo(x + 36, y + 53).stroke({ color: def.accent, width: 3 }); } }
          else if (def.id === 'icicle') g.poly([x + 36, y + 12, x + 49, y + 34, x + 36, y + 59, x + 23, y + 34]).fill(def.accent).stroke({ color: 0xffffff, width: 2 });
          else if (def.id === 'geyser') { g.circle(x + 36, y + 38, triggered ? 18 : 14).fill(0x176d79).stroke({ color: def.accent, width: 4 }); g.circle(x + 36, y + 35, 6).fill(0xbfffff); }
          else if (def.id === 'jet') { g.circle(x + 36, y + 36, 13).fill(0x071b25).stroke({ color: def.accent, width: 5 }); for (let a = 0; a < 4; a++) { const angle = a * Math.PI / 2; g.roundRect(x + 32 + Math.cos(angle) * 21, y + 32 + Math.sin(angle) * 21, 8, 8, 2).fill(def.accent); } }
          else if (def.id === 'mine') { g.circle(x + 36, y + 36, 15).fill(0x9c55ed); g.moveTo(x + 36, y + 17).lineTo(x + 36, y + 55).stroke({ color: 0xffe36d, width: 3 }); g.moveTo(x + 17, y + 36).lineTo(x + 55, y + 36).stroke({ color: 0xffe36d, width: 3 }); }
          else if (def.id === 'tesla') { g.circle(x + 36, y + 36, 16).stroke({ color: 0xb867ff, width: 5 }); g.circle(x + 36, y + 36, 8).fill(0xffdf65); g.moveTo(x + 20, y + 20).lineTo(x + 29, y + 28).lineTo(x + 22, y + 36).stroke({ color: 0xe5b7ff, width: 3 }); }
        }
        if (def.placement === 'wall') for (const face of this.openFaces(trap.origin.x + p.x, trap.origin.y + p.y)) {
          const cx = x + CELL / 2, cy = y + CELL / 2;
          g.moveTo(cx + face.x * 22 - face.y * 5, cy + face.y * 22 + face.x * 5).lineTo(cx + face.x * 29, cy + face.y * 29).lineTo(cx + face.x * 22 + face.y * 5, cy + face.y * 22 - face.x * 5).stroke({ color: def.accent, width: 3, alpha: .9 });
        }
        if (ready) g.circle(x + CELL / 2, y + CELL / 2, def.placement === 'wall' ? 20 : 24).stroke({ color: def.accent, width: 2, alpha: .45 + Math.sin(this.elapsed * 6) * .14 });
        if (trap.level > 1) for (let i = 0; i < trap.level; i++) g.circle(x + 23 + i * 9, y + 54, 3).fill(0xffd471);
      });
      this.drawTrapOutline(g, trap, selected ? 0xffd471 : def.placement === 'wall' ? 0x8f7887 : 0x100d15, selected ? 6 : def.placement === 'wall' ? 3 : 4);
    }
    for (const [key, sprite] of this.trapSprites) if (!visibleSprites.has(key)) { sprite.destroy(); this.trapSprites.delete(key); }
  }

  private drawPlacementHints(g: Graphics) {
    const moving = this.movingTrap ? this.traps.find(t => t.id === this.movingTrap) : null;
    const offer = this.offers.find(o => o.id === (this.dragOfferId ?? this.selectedOffer));
    if (offer || moving) {
      const trapId = offer?.trapId ?? moving!.trapId, shape = offer?.shape ?? moving!.shape, ignore = moving?.id;
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        if (!this.canPlaceTrap(trapId, shape, x, y, ignore)) continue;
        const px = BOARD_X + x * CELL, py = BOARD_Y + y * CELL;
        g.circle(px + 10, py + 10, 4).fill({ color: 0x75efb7, alpha: .65 });
      }
      if (this.dragPreview) {
        const color = this.dragPreview.valid ? 0x66edaa : 0xff5f6d;
        for (const p of shape) {
          const x = this.dragPreview.origin.x + p.x, y = this.dragPreview.origin.y + p.y;
          if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
          const px = BOARD_X + x * CELL, py = BOARD_Y + y * CELL;
          g.roundRect(px + 4, py + 4, CELL - 8, CELL - 8, 10).fill({ color, alpha: .28 }).stroke({ color, width: 4, alpha: .95 });
        }
      }
    }
    if (!this.terrainMode) return;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (!this.terrainCellValid(x, y)) continue;
      const px = BOARD_X + x * CELL, py = BOARD_Y + y * CELL;
      g.roundRect(px + 7, py + 7, CELL - 14, CELL - 14, 11).fill({ color: this.terrainMode === 'dig' ? 0x54d9d2 : 0xe4b75f, alpha: .14 }).stroke({ color: this.terrainMode === 'dig' ? 0x64eee6 : 0xf6ce78, width: 3, alpha: .7 });
    }
  }

  private drawTrapOutline(g: Graphics, trap: PlacedTrap, color: number, width: number) {
    const cells = new Set(trap.shape.map(p => `${p.x},${p.y}`));
    for (const p of trap.shape) {
      const x = BOARD_X + (trap.origin.x + p.x) * CELL, y = BOARD_Y + (trap.origin.y + p.y) * CELL;
      if (!cells.has(`${p.x},${p.y - 1}`)) g.moveTo(x + 3, y + 3).lineTo(x + CELL - 3, y + 3).stroke({ color, width });
      if (!cells.has(`${p.x + 1},${p.y}`)) g.moveTo(x + CELL - 3, y + 3).lineTo(x + CELL - 3, y + CELL - 3).stroke({ color, width });
      if (!cells.has(`${p.x},${p.y + 1}`)) g.moveTo(x + CELL - 3, y + CELL - 3).lineTo(x + 3, y + CELL - 3).stroke({ color, width });
      if (!cells.has(`${p.x - 1},${p.y}`)) g.moveTo(x + 3, y + CELL - 3).lineTo(x + 3, y + 3).stroke({ color, width });
    }
  }

  private drawEnemies() {
    const g = this.enemyLayer, overlay = this.enemyOverlayLayer; g.clear(); overlay.clear();
    const visible = new Set<number>();
    for (const e of this.enemies) {
      if (e.dead || e.spawnDelay > 0) continue;
      visible.add(e.id);
      if (e.flying) g.ellipse(e.x + 5, e.y + 12, 22, 10).fill({ color: 0x08070c, alpha: .38 });
      else g.ellipse(e.x, e.y + e.radius * .55, e.radius * .95, Math.max(3, e.radius * .42)).fill({ color: 0x08070c, alpha: .46 });
      const auraColor = e.aura ? ELEMENT_COLORS[e.aura] : 0;
      const frames = this.enemyFrames[e.kind];
      if (!frames) continue;
      const moving = e.impulseTime <= 0 && Math.hypot(e.vx, e.vy) >= 3;
      const frameIndex = moving ? Math.floor((this.elapsed * 7 + e.id * .37) % 4) : 0;
      let sprite = this.enemySprites.get(e.id);
      if (!sprite) {
        sprite = new Sprite(frames[0]); sprite.anchor.set(.5); this.enemySpriteLayer.addChild(sprite); this.enemySprites.set(e.id, sprite);
      }
      sprite.texture = frames[frameIndex];
      const displayWidth: Record<EnemyKind, number> = { runner: 26, delver: 30, shield: 38, wing: 48, brute: 52 };
      sprite.width = displayWidth[e.kind]; sprite.scale.y = Math.abs(sprite.scale.x);
      sprite.x = e.x; sprite.y = e.y - (e.flying ? 8 : 1); sprite.rotation = e.angle;
      sprite.alpha = e.frozen > 0 ? .76 : 1; sprite.tint = e.aura ? this.mixTint(auraColor, .27) : 0xffffff;
      let auraSprite = this.enemyAuraSprites.get(e.id);
      if (e.aura) {
        if (!auraSprite) { auraSprite = new Sprite(frames[frameIndex]); auraSprite.anchor.set(.5); this.enemyAuraLayer.addChild(auraSprite); this.enemyAuraSprites.set(e.id, auraSprite); }
        auraSprite.texture = frames[frameIndex]; auraSprite.width = displayWidth[e.kind] + 5; auraSprite.scale.y = Math.abs(auraSprite.scale.x);
        auraSprite.x = sprite.x; auraSprite.y = sprite.y; auraSprite.rotation = sprite.rotation; auraSprite.tint = auraColor; auraSprite.alpha = .9;
      } else if (auraSprite) { auraSprite.destroy(); this.enemyAuraSprites.delete(e.id); }
      if (e.frozen > 0) overlay.circle(e.x, e.y, e.radius + 5).fill({ color: 0xcaf6ff, alpha: .28 }).stroke({ color: 0xf4ffff, width: 2 });
      if ((e.kind === 'brute' || e.kind === 'shield') && e.hit) {
        overlay.roundRect(e.x - 18, e.y - e.radius - 15, 36, 5, 2).fill(0x271d26);
        overlay.roundRect(e.x - 18, e.y - e.radius - 15, 36 * Math.max(0, e.hp / e.maxHp), 5, 2).fill(0xe54e59);
      }
    }
    for (const [id, sprite] of this.enemySprites) if (!visible.has(id)) { sprite.destroy(); this.enemySprites.delete(id); }
    for (const [id, sprite] of this.enemyAuraSprites) if (!visible.has(id)) { sprite.destroy(); this.enemyAuraSprites.delete(id); }
  }

  private mixTint(color: number, amount: number) {
    const r = color >> 16 & 255, g = color >> 8 & 255, b = color & 255;
    const mix = (value: number) => Math.round(255 + (value - 255) * amount);
    return mix(r) << 16 | mix(g) << 8 | mix(b);
  }

  private drawVfx() {
    const g = this.vfxLayer; g.clear();
    for (const beam of this.beams) {
      const alpha = 1 - beam.age / beam.life;
      if (beam.kind === 'tesla' || beam.kind === 'conduct') {
        const pieces = 5; g.moveTo(beam.x, beam.y);
        for (let i = 1; i < pieces; i++) {
          const t = i / pieces, bx = beam.x + (beam.x2 - beam.x) * t, by = beam.y + (beam.y2 - beam.y) * t;
          const len = Math.hypot(beam.x2 - beam.x, beam.y2 - beam.y) || 1, nx = -(beam.y2 - beam.y) / len, ny = (beam.x2 - beam.x) / len, jitter = Math.sin((i * 7 + beam.x) * 1.7) * 7;
          g.lineTo(bx + nx * jitter, by + ny * jitter);
        }
        g.lineTo(beam.x2, beam.y2).stroke({ color: beam.color, width: beam.width, alpha });
        g.circle(beam.x2, beam.y2, 4).fill({ color: 0xffed78, alpha });
      } else if (beam.kind === 'flame') {
        const dx = beam.x2 - beam.x, dy = beam.y2 - beam.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
        g.poly([beam.x, beam.y, beam.x2 + nx * 20, beam.y2 + ny * 20, beam.x2 - nx * 20, beam.y2 - ny * 20]).fill({ color: beam.color, alpha: alpha * .3 });
      } else if (beam.kind === 'jet') {
        g.moveTo(beam.x, beam.y).lineTo(beam.x2, beam.y2).stroke({ color: 0xbdfcff, width: beam.width + 5, alpha: alpha * .25 });
        g.moveTo(beam.x, beam.y).lineTo(beam.x2, beam.y2).stroke({ color: beam.color, width: beam.width, alpha: alpha * .8 });
      } else if (beam.kind === 'piston') {
        g.moveTo(beam.x, beam.y).lineTo(beam.x2, beam.y2).stroke({ color: beam.color, width: beam.width + 7, alpha });
      } else if (beam.kind === 'arrow') {
        const t = Math.min(1, beam.age / beam.life * 1.18);
        const x = beam.x + (beam.x2 - beam.x) * t, y = beam.y + (beam.y2 - beam.y) * t;
        const distance = Math.hypot(beam.x2 - beam.x, beam.y2 - beam.y) || 1;
        const ux = (beam.x2 - beam.x) / distance, uy = (beam.y2 - beam.y) / distance;
        g.circle(x, y, 3.5).fill({ color: 0xfff2c3, alpha });
        g.circle(x - ux * 7, y - uy * 7, 2.3).fill({ color: beam.color, alpha: alpha * .7 });
        g.circle(x - ux * 13, y - uy * 13, 1.4).fill({ color: beam.color, alpha: alpha * .35 });
      } else {
        g.moveTo(beam.x, beam.y).lineTo(beam.x2, beam.y2).stroke({ color: beam.color, width: beam.width, alpha });
        const t = Math.min(1, beam.age / beam.life * 1.6);
        g.circle(beam.x + (beam.x2 - beam.x) * t, beam.y + (beam.y2 - beam.y) * t, beam.kind === 'arrow' ? 3 : 5).fill({ color: beam.color, alpha });
      }
    }
    for (const b of this.bursts) {
      const t = b.age / b.life, alpha = 1 - t, r = Math.max(2, b.size * t);
      if (b.kind === 'ПАР') g.circle(b.x, b.y, r).stroke({ color: b.color, width: Math.max(1, 4 * alpha), alpha: alpha * .42 });
      else if (['ПРОВОДИМОСТЬ', 'mine', 'tesla'].includes(b.kind)) { for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; g.moveTo(b.x, b.y).lineTo(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r).stroke({ color: i % 2 ? 0xffed78 : b.color, width: 2, alpha }); } }
      else if (b.kind === 'ТЕРМОУДАР') { g.circle(b.x, b.y, Math.max(2, 16 * alpha)).fill({ color: 0xffffff, alpha }); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; g.moveTo(b.x + Math.cos(a) * r * .2, b.y + Math.sin(a) * r * .2).lineTo(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r).stroke({ color: i % 2 ? 0xff7947 : 0xcaf6ff, width: 4, alpha }); } }
      else if (b.kind === 'ПЕРЕГРУЗКА') { g.circle(b.x, b.y, r).stroke({ color: 0xb95cff, width: 7 * alpha, alpha }); for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; g.moveTo(b.x + Math.cos(a) * r * .5, b.y + Math.sin(a) * r * .5).lineTo(b.x + Math.cos(a) * r * 1.2, b.y + Math.sin(a) * r * 1.2).stroke({ color: 0xffed78, width: 2, alpha }); } }
      else { g.circle(b.x, b.y, r).stroke({ color: b.color, width: Math.max(1, 5 * alpha), alpha }); g.circle(b.x, b.y, Math.max(1, 5 * alpha)).fill({ color: b.color, alpha }); }
    }
    this.labelLayer.removeChildren().forEach(c => c.destroy());
    for (const f of this.floatTexts) {
      const text = new Text({ text: f.text, style: new TextStyle({ fontFamily: 'system-ui', fontSize: 15, fontWeight: '800', fill: f.color, stroke: { color: 0x17121d, width: 4 } }) });
      text.anchor.set(.5); text.x = f.x; text.y = f.y - f.age * 25; text.alpha = 1 - f.age; this.labelLayer.addChild(text);
    }
  }
}
