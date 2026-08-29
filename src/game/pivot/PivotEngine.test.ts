import { describe, expect, it } from 'vitest';
import { BOARD_X, BOARD_Y, CELL, ENEMIES, EXPAND_PRICES, STARTING_COINS, TRAPS } from './config';
import { activeFlowGates, buildFlowField, simulateTraffic } from './generator';
import { PivotEngine } from './PivotEngine';
import type { EnemyKind, EnemyState, Point, TrapId, TrapItem } from './types';

function enemyAt(x: number, y: number, kind: EnemyKind = 'grunt', id = 999): EnemyState {
  return {
    id, kind, x, y, vx: 0, vy: 0, hp: 1_000, maxHp: 1_000, spawnDelay: 0, emerging: false, entrance: 0, gateIndex: 0, laneBias: 0,
    burnDps: 0, burnTime: 0, burnSourceId: null, slow: 0, slowTime: 0, frostSourceId: null,
    vulnerable: 0, vulnerableTime: 0, hardControlLevel: 0, hardControlWindow: 0, hardControlImmune: 0,
    noProgressTime: 0, bestFlowDistance: Infinity, impulseTime: 0, airborneTime: 0, airborneDuration: 0,
    impactDamage: 0, impactRadius: 0, impactSourceId: null, impulseSourceId: null, launched: false, collisionSpent: false, dead: false,
  };
}

function fittingOrigin(engine: PivotEngine, trapId: TrapId): Point {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++)
    if (TRAPS[trapId].shape.every(offset => engine.revealedFloorSet.has(`${x + offset.x},${y + offset.y}`))) return { x, y };
  throw new Error(`No origin for ${trapId}`);
}

function boardTrap(engine: PivotEngine, trapId: TrapId): TrapItem {
  return { id: `${trapId}-test`, trapId, tier: 1, location: 'board', origin: fittingOrigin(engine, trapId), cooldowns: TRAPS[trapId].shape.map(() => 0) };
}

function busiestOrigin(engine: PivotEngine, trapId: TrapId): Point {
  const def = TRAPS[trapId];
  let best: { origin: Point; traffic: number } | null = null;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) {
    if (!def.shape.every(offset => engine.revealedFloorSet.has(`${x + offset.x},${y + offset.y}`))) continue;
    const traffic = def.shape.reduce((sum, offset) => sum + (engine.routeSimulation.traffic.get(`${x + offset.x},${y + offset.y}`) ?? 0), 0);
    if (!best || traffic > best.traffic) best = { origin: { x, y }, traffic };
  }
  if (!best) throw new Error(`No origin for ${trapId}`);
  return best.origin;
}

function cellCenter(origin: Point, offset: Point = { x: 0, y: 0 }) {
  return { x: BOARD_X + (origin.x + offset.x + .5) * CELL, y: BOARD_Y + (origin.y + offset.y + .5) * CELL };
}

describe('pivot preparation loop', () => {
  it('detects drag synergies in both zone directions', () => {
    const engine = new PivotEngine(987654, () => undefined);
    const saw = boardTrap(engine, 'saw');
    const mine = boardTrap(engine, 'mine');
    const cannon = boardTrap(engine, 'cannon');
    const tesla = boardTrap(engine, 'tesla');
    const spikes = boardTrap(engine, 'spikes');

    expect(engine.hasZoneSynergy(saw, mine)).toBe(true);
    expect(engine.hasZoneSynergy(cannon, tesla)).toBe(true);
    expect(engine.hasZoneSynergy(tesla, cannon)).toBe(true);
    expect(engine.hasZoneSynergy(cannon, spikes)).toBe(false);
  });

  it('turns discarded shop batches into stackable free rerolls without inflating paid price', () => {
    const engine = new PivotEngine(314159, () => undefined);
    expect(engine.shop).toHaveLength(3);
    expect(engine.coins).toBe(STARTING_COINS);

    engine.reroll();
    expect(engine.coins).toBe(0);
    expect(engine.rerollIndex).toBe(1);
    expect(engine.freeRerolls).toBe(1);
    expect(engine.recyclerPoints).toBe(1);
    expect(engine.shop).toHaveLength(3);

    engine.reroll();
    expect(engine.coins).toBe(0);
    expect(engine.rerollIndex).toBe(1);
    expect(engine.freeRerolls).toBe(1);
    expect(engine.recyclerPoints).toBe(0);
    expect(engine.recyclerTarget).toBe(6);
  });

  it('preserves Hold through Battle while recycling every remaining shop trap', () => {
    const engine = new PivotEngine(271828, () => undefined);
    const saved = engine.shop[0];
    saved.location = 'hold';

    engine.battle();

    expect(engine.phase).toBe('combat');
    expect(engine.hold?.id).toBe(saved.id);
    expect(engine.shop).toHaveLength(0);
    expect(engine.stats.recycled).toBe(2);
    expect(engine.freeRerolls).toBe(1);
  });

  it('does not let prep actions mutate an active combat', () => {
    const engine = new PivotEngine(271828, () => undefined);
    engine.battle();
    const enemyIds = engine.enemies.map(enemy => enemy.id), itemCount = engine.items.length, coins = engine.coins;
    engine.battle(); engine.reroll(); engine.expand();
    expect(engine.phase).toBe('combat');
    expect(engine.enemies.map(enemy => enemy.id)).toEqual(enemyIds);
    expect(engine.items).toHaveLength(itemCount);
    expect(engine.coins).toBe(coins);
  });

  it('spends coins only when an Expand is affordable and keeps the reveal deterministic', () => {
    const engine = new PivotEngine(161803, () => undefined);
    const initialStage = engine.stage;

    engine.expand();
    expect(engine.expandCount).toBe(0);

    engine.coins = EXPAND_PRICES[0];
    engine.expand();
    expect(engine.expandCount).toBe(1);
    expect(engine.coins).toBe(0);

    engine.retry();
    expect(engine.stage).toBe(initialStage);
    expect(engine.expandCount).toBe(0);
    expect(engine.coins).toBe(STARTING_COINS);
    expect(engine.shop).toHaveLength(3);
  });

  it('funds all four large Expands by Wave 7 without requiring paid rerolls', () => {
    const engine = new PivotEngine(161803, () => undefined);
    const expectedExpands = [1, 2, 2, 3, 3, 3, 4];
    for (const expected of expectedExpands) {
      engine.phase = 'combat';
      (engine as unknown as { finishWave: () => void }).finishWave();
      engine.choosePerk(engine.perkChoices[0].id);
      while (engine.expandCost != null && engine.coins >= engine.expandCost) engine.expand();
      expect(engine.expandCount).toBe(expected);
    }
    expect(engine.coins).toBe(17);
    expect(engine.rerollIndex).toBe(0);
  });

  it('splits the fixed wave budget across every active portal as evenly as possible', () => {
    const engine = new PivotEngine(424242, () => undefined);
    for (let step = 0; step <= 4; step++) {
      engine.expandCount = step;
      const groups = (engine as unknown as { distributedRoster: () => unknown[][] }).distributedRoster();
      const total = Object.values(engine.preview).reduce((sum, value) => sum + value, 0);
      expect(groups.flat()).toHaveLength(total);
      const sizes = groups.map(group => group.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it('moves a ground enemy through the generated macro-gate sequence before Heart routing', () => {
    const engine = new PivotEngine(987654, () => undefined);
    engine.battle();
    const enemy = engine.enemies.find(value => value.spawnDelay === 0)!;
    for (let tick = 0; tick < 1_200 && enemy.gateIndex < engine.gates.length; tick++) (engine as unknown as { steerEnemy: (target: typeof enemy, dt: number) => void }).steerEnemy(enemy, .05);
    expect(enemy.gateIndex).toBe(engine.gates.length);
  });

  it('keeps flyers on the same visible macro-flow while floor plates remain unable to target them', () => {
    const engine = new PivotEngine(987654, () => undefined);
    engine.battle();
    const enemy = engine.enemies.find(value => value.spawnDelay === 0)!;
    enemy.kind = 'flyer';
    for (let tick = 0; tick < 1_200 && enemy.gateIndex < engine.gates.length; tick++)
      (engine as unknown as { steerEnemy: (target: typeof enemy, dt: number) => void }).steerEnemy(enemy, .05);
    expect(enemy.gateIndex).toBe(engine.gates.length);

    const floorOnly = ['spikes', 'ember', 'frost', 'geyser', 'mine'] as const;
    const allTarget = ['saw', 'flame', 'icicle', 'cannon', 'tesla'] as const;
    for (const id of floorOnly) expect(TRAPS[id].canTargetFlying, id).toBeFalsy();
    for (const id of allTarget) expect(TRAPS[id].canTargetFlying, id).toBe(true);
  });

  it('activates only the Plate segment actually occupied by an enemy', () => {
    const engine = new PivotEngine(987654, () => undefined), item = boardTrap(engine, 'ember');
    const center = cellCenter(item.origin!);
    engine.items = [item]; engine.enemies = [enemyAt(center.x, center.y)];
    (engine as unknown as { activateTraps: () => void }).activateTraps();
    expect(engine.enemies[0].hp).toBe(1_000 - TRAPS.ember.damage);
    expect(item.cooldowns.filter(value => value > 0)).toHaveLength(1);
  });

  it('activates coherent Spikes once across their entire silhouette', () => {
    const engine = new PivotEngine(987654, () => undefined), item = boardTrap(engine, 'spikes');
    const center = cellCenter(item.origin!);
    engine.items = [item]; engine.enemies = [enemyAt(center.x, center.y)];
    (engine as unknown as { activateTraps: () => void }).activateTraps();
    expect(engine.enemies[0].hp).toBe(1_000 - TRAPS.spikes.damage);
    expect(item.cooldowns.filter(value => value > 0)).toHaveLength(1);
  });

  it('never lets a ground Physical shockwave damage a flyer', () => {
    const engine = new PivotEngine(987654, () => undefined), item = boardTrap(engine, 'spikes');
    const center = cellCenter(item.origin!);
    engine.items = [item];
    engine.enemies = [enemyAt(center.x, center.y, 'grunt', 1), enemyAt(center.x + 32, center.y, 'flyer', 2)];
    engine.selectedPerks = ['seismic-edge'];
    (engine as unknown as { activateTraps: () => void }).activateTraps();
    expect(engine.enemies[1].hp).toBe(1_000);
  });

  it('enforces ground-only and flying-capable targeting in runtime, not only config', () => {
    const groundEngine = new PivotEngine(987654, () => undefined), mine = boardTrap(groundEngine, 'mine');
    const mineCenter = cellCenter(mine.origin!);
    groundEngine.items = [mine]; groundEngine.enemies = [enemyAt(mineCenter.x, mineCenter.y, 'flyer')];
    (groundEngine as unknown as { activateTraps: () => void }).activateTraps();
    expect(groundEngine.enemies[0].hp).toBe(1_000);

    const turretEngine = new PivotEngine(987654, () => undefined), tesla = boardTrap(turretEngine, 'tesla');
    const teslaCenter = cellCenter(tesla.origin!);
    turretEngine.items = [tesla]; turretEngine.enemies = [enemyAt(teslaCenter.x, teslaCenter.y, 'flyer')];
    (turretEngine as unknown as { activateTraps: () => void }).activateTraps();
    expect(turretEngine.enemies[0].hp).toBeLessThan(1_000);
  });

  it('returns every overlapped trap to the tray when a new footprint displaces it', () => {
    const engine = new PivotEngine(987654, () => undefined), tesla = boardTrap(engine, 'tesla'), mine = boardTrap(engine, 'mine');
    mine.location = 'shop'; mine.origin = undefined;
    engine.items = [tesla, mine];
    (engine as unknown as { dropBoard: (item: TrapItem, origin: Point) => void }).dropBoard(mine, { ...tesla.origin! });
    expect(mine.location).toBe('board');
    expect(tesla.location).toBe('shop');
    expect(tesla.origin).toBeUndefined();
    expect(engine.message).toContain('returned to the tray');
  });

  it('keeps an Ember-sourced death explosion from damaging flyers', () => {
    const engine = new PivotEngine(987654, () => undefined), item = boardTrap(engine, 'ember');
    const center = cellCenter(item.origin!);
    const ground = enemyAt(center.x, center.y, 'grunt', 1), flyer = enemyAt(center.x + 32, center.y, 'flyer', 2);
    engine.items = [item]; engine.enemies = [ground, flyer]; engine.selectedPerks = ['chain-combustion'];
    (engine as unknown as { activateTraps: () => void }).activateTraps();
    ground.hp = 1;
    (engine as unknown as { damageEnemy: (target: EnemyState, damage: number, source: TrapItem) => void }).damageEnemy(ground, 2, item);
    expect(flyer.hp).toBe(1_000);
  });

  it('preserves the trap source through impulse collisions so ground effects cannot damage flyers', () => {
    const groundEngine = new PivotEngine(987654, () => undefined), geyser = boardTrap(groundEngine, 'geyser');
    const ground = enemyAt(200, 200, 'grunt', 1), flyer = enemyAt(215, 200, 'flyer', 2);
    ground.impulseSourceId = geyser.id; ground.launched = true;
    groundEngine.items = [geyser]; groundEngine.enemies = [ground, flyer];
    (groundEngine as unknown as { collisionDamage: (source: EnemyState, target: EnemyState) => void }).collisionDamage(ground, flyer);
    expect(flyer.hp).toBe(1_000);

    const airEngine = new PivotEngine(987654, () => undefined), cannon = boardTrap(airEngine, 'cannon');
    const pushed = enemyAt(200, 200, 'grunt', 3), airborneTarget = enemyAt(215, 200, 'flyer', 4);
    pushed.impulseSourceId = cannon.id; pushed.launched = true;
    airEngine.items = [cannon]; airEngine.enemies = [pushed, airborneTarget];
    (airEngine as unknown as { collisionDamage: (source: EnemyState, target: EnemyState) => void }).collisionDamage(pushed, airborneTarget);
    expect(airborneTarget.hp).toBeLessThan(1_000);
  });

  it('never leaks an enemy that burn damage already killed inside the Heart radius', () => {
    const engine = new PivotEngine(987654, () => undefined), ember = boardTrap(engine, 'ember');
    const heart = engine.stage.heartOrigin;
    const enemy = enemyAt(BOARD_X + (heart.x + 1) * CELL, BOARD_Y + (heart.y + 1) * CELL);
    enemy.hp = 1; enemy.burnDps = 100; enemy.burnTime = 1; enemy.burnSourceId = ember.id;
    engine.phase = 'combat'; engine.items = [ember]; engine.enemies = [enemy];
    const initialHp = engine.hp;
    (engine as unknown as { updateCombat: (dt: number) => void }).updateCombat(.05);
    expect(enemy.dead).toBe(true);
    expect(engine.stats.leaked).toBe(0);
    expect(engine.hp).toBe(initialHp);
  });

  it('clamps a lethal Heart leak to zero and ends combat immediately', () => {
    const engine = new PivotEngine(987654, () => undefined), heart = engine.stage.heartOrigin;
    const enemy = enemyAt(BOARD_X + (heart.x + 1) * CELL, BOARD_Y + (heart.y + 1) * CELL);
    engine.phase = 'combat'; engine.hp = 1; engine.enemies = [enemy];
    (engine as unknown as { checkLeak: (target: EnemyState) => void }).checkLeak(enemy);
    expect(engine.hp).toBe(0);
    expect(engine.phase).toBe('result');
    expect(engine.victory).toBe(false);
  });

  it('always rolls three valid unique elemental perks through the ninth reward', () => {
    const engine = new PivotEngine(424242, () => undefined);
    for (let reward = 0; reward < 9; reward++) {
      engine.phase = 'combat';
      (engine as unknown as { finishWave: () => void }).finishWave();
      expect(engine.perkChoices).toHaveLength(3);
      expect(new Set(engine.perkChoices.map(perk => perk.id)).size).toBe(3);
      expect(engine.perkChoices.every(perk => !!perk.scope.element)).toBe(true);
      engine.choosePerk(engine.perkChoices[0].id);
    }
  });

  it('moves a live untrapped horde through each authored reveal without stalling', () => {
    for (const seed of [104729, 209458, 314187, 418916]) for (let expand = 0; expand <= 4; expand++) {
      const engine = new PivotEngine(seed, () => undefined);
      engine.expandCount = expand;
      engine.flow = buildFlowField(engine.stage, expand);
      engine.flyFlow = buildFlowField(engine.stage, expand, true);
      engine.gateFlows = activeFlowGates(engine.stage, expand).map(gate => buildFlowField(engine.stage, expand, false, gate));
      engine.routeSimulation = simulateTraffic(engine.stage, expand);
      engine.battle();
      for (let tick = 0; tick < 2_400 && engine.phase === 'combat'; tick++)
        (engine as unknown as { updateCombat: (dt: number) => void }).updateCombat(.04);
      const visited = [...engine.trafficCoverage.keys()].filter(cell => engine.revealedFloorSet.has(cell)).length;
      expect(visited / engine.revealedFloorSet.size, `${seed}:${expand}:${visited}/${engine.revealedFloorSet.size}`).toBeGreaterThanOrEqual(.75);
      expect(engine.phase, `${seed}:${expand}`).toBe('perk');
    }
  });

  it('commits enemies to one side of a turret obstacle and carries them past it', () => {
    const engine = new PivotEngine(987654, () => undefined), turret = boardTrap(engine, 'icicle');
    engine.items = [turret];
    const obstacle = TRAPS.icicle.obstacle!;
    const center = {
      x: BOARD_X + (turret.origin!.x + obstacle.offset.x) * CELL,
      y: BOARD_Y + (turret.origin!.y + obstacle.offset.y) * CELL,
    };
    const enemies = Array.from({ length: 12 }, (_, index) => enemyAt(center.x - 64 - index * 2, center.y + (index % 3 - 1) * 3, 'grunt', index + 1));
    engine.enemies = enemies;
    const collision = engine as unknown as {
      steerAroundTrapObstacles: (enemy: EnemyState, x: number, y: number) => Point;
      resolveTrapObstacleCollision: (enemy: EnemyState) => void;
    };
    let closest = Infinity;
    for (let tick = 0; tick < 220; tick++) for (const enemy of enemies) {
      const direction = collision.steerAroundTrapObstacles(enemy, 1, 0);
      enemy.vx += (direction.x * 65 - enemy.vx) * .3; enemy.vy += (direction.y * 65 - enemy.vy) * .3;
      enemy.x += enemy.vx * .04; enemy.y += enemy.vy * .04;
      collision.resolveTrapObstacleCollision(enemy);
      closest = Math.min(closest, Math.hypot(enemy.x - center.x, enemy.y - center.y));
    }
    expect(Math.min(...enemies.map(enemy => enemy.x))).toBeGreaterThan(center.x + 45);
    expect(closest).toBeGreaterThanOrEqual(obstacle.radius + 10 - .01);
    expect(engine.obstacleAvoidance.size).toBe(0);
  });

  it.each(['flame', 'icicle', 'cannon'] as const)('aims %s before firing a visible projectile from its muzzle', trapId => {
    const engine = new PivotEngine(987654, () => undefined), item = boardTrap(engine, trapId), turret = TRAPS[trapId].turret!;
    const pivot = { x: BOARD_X + (item.origin!.x + turret.pivotOffset.x) * CELL, y: BOARD_Y + (item.origin!.y + turret.pivotOffset.y) * CELL };
    const target = enemyAt(pivot.x, pivot.y - 90);
    engine.items = [item]; engine.enemies = [target];
    const combat = engine as unknown as { updateTurretAim: (dt: number) => void; activateTraps: () => void };
    for (let tick = 0; tick < 20; tick++) combat.updateTurretAim(.05);
    combat.activateTraps();
    expect(engine.turretAngles.get(item.id)).toBeCloseTo(-Math.PI / 2, 1);
    expect(engine.projectiles).toHaveLength(1);
    expect(engine.projectiles[0].kind).toBe(trapId);
    expect(target.hp).toBeLessThan(1_000);
  });

  it.each(['flame', 'icicle', 'cannon', 'tesla'] as const)('routes a full live horde around a non-firing %s obstacle', trapId => {
    const engine = new PivotEngine(987654, () => undefined), item = boardTrap(engine, trapId);
    item.origin = busiestOrigin(engine, trapId); item.cooldowns = item.cooldowns.map(() => 999);
    engine.items = [item]; engine.battle();
    for (let tick = 0; tick < 3_000 && engine.phase === 'combat'; tick++)
      (engine as unknown as { updateCombat: (dt: number) => void }).updateCombat(.04);
    expect(engine.phase).toBe('perk');
    expect(engine.stats.leaked).toBeGreaterThan(0);
  });

  it('keeps a horde out of the center wall while rounding the wall-adjacent upper turret', () => {
    // four-horns, reveal 1: this is the exact concave passage shown in the
    // regression screenshot. The wall at 3,8 borders the turret route at 4,6.
    const engine = new PivotEngine(987655, () => undefined);
    engine.expandCount = 1;
    engine.flow = buildFlowField(engine.stage, engine.expandCount);
    engine.flyFlow = buildFlowField(engine.stage, engine.expandCount, true);
    engine.gateFlows = activeFlowGates(engine.stage, engine.expandCount).map(gate => buildFlowField(engine.stage, engine.expandCount, false, gate));
    engine.routeSimulation = simulateTraffic(engine.stage, engine.expandCount);
    const turret: TrapItem = { id: 'wall-adjacent-icicle', trapId: 'icicle', tier: 1, location: 'board', origin: { x: 4, y: 6 }, cooldowns: [999] };
    engine.items = [turret]; engine.battle();
    const terrain = engine as unknown as { updateCombat: (dt: number) => void; isTerrainClear: (x: number, y: number, radius: number) => boolean };
    let breachedWall = false;
    for (let tick = 0; tick < 3_000 && engine.phase === 'combat'; tick++) {
      terrain.updateCombat(.04);
      for (const enemy of engine.enemies) if (!enemy.dead && enemy.spawnDelay <= 0 && !enemy.emerging && enemy.kind !== 'flyer')
        breachedWall ||= !terrain.isTerrainClear(enemy.x, enemy.y, ENEMIES[enemy.kind].radius);
    }
    expect(breachedWall).toBe(false);
    expect(engine.phase).toBe('perk');
  });
});
