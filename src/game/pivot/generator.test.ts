import { describe, expect, it } from 'vitest';
import { PERKS, REVEAL_CHUNK_SIZES, TRAPS, buildWavePreview, trapActivationOffsets } from './config';
import { activeEntrances, activeSpawnPoints, buildFlowField, generateDungeon, measurePackingSpace, revealedFloor, revealedMask, simulateTraffic, trafficDestination } from './generator';
import { AUTHORED_LAYOUTS } from './layouts';

const placements = (floor: Set<string>, shape: { x: number; y: number }[]) => {
  let result = 0;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) if (shape.every(p => floor.has(`${x + p.x},${y + p.y}`))) result++;
  return result;
};
const pointKey = (point: { x: number; y: number }) => `${point.x},${point.y}`;
const pointDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

describe('authored floor-only backpack dungeons', () => {
  it('selects only configured layouts deterministically across a broad seed corpus', () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      const stage = generateDungeon(seed * 2654435761);
      const layout = AUTHORED_LAYOUTS.find(value => value.id === stage.layoutId)!;
      expect(stage).toEqual(generateDungeon(seed * 2654435761));
      expect(stage.initialFloor).toHaveLength(layout.zones.join('').split('').filter(cell => cell === '1').length);
      expect(revealedFloor(stage, REVEAL_CHUNK_SIZES.length).size).toBe(layout.zones.join('').split('').filter(cell => /^[1-5]$/.test(cell)).length);
      expect(stage.flowPlans).toHaveLength(REVEAL_CHUNK_SIZES.length + 1);
    }
    expect(new Set([generateDungeon(0).layoutId, generateDungeon(1).layoutId])).toEqual(new Set(AUTHORED_LAYOUTS.map(layout => layout.id)));
  });

  it('keeps four monotonic authored reveals and puts every spawn arrow outside its active floor', () => {
    for (let seed = 0; seed < AUTHORED_LAYOUTS.length; seed++) {
      const stage = generateDungeon(seed);
      let previous = new Set<string>();
      for (let expand = 0; expand <= REVEAL_CHUNK_SIZES.length; expand++) {
        const floor = revealedFloor(stage, expand), entrances = activeEntrances(stage, expand), spawns = activeSpawnPoints(stage, expand);
        expect([...previous].every(cell => floor.has(cell))).toBe(true);
        expect(entrances).toHaveLength(spawns.length);
        expect(spawns.length).toBeGreaterThanOrEqual(1);
        expect(spawns.length).toBeLessThanOrEqual(4);
        spawns.forEach((spawn, index) => {
          expect(floor.has(pointKey(spawn)), `${stage.layoutId}:${expand}:${pointKey(spawn)}`).toBe(false);
          expect(pointDistance(spawn, entrances[index])).toBe(1);
        });
        previous = floor;
      }
      expect(activeEntrances(stage, 0).length).toBeGreaterThanOrEqual(1);
      const field = buildFlowField(stage, REVEAL_CHUNK_SIZES.length);
      for (const entrance of activeEntrances(stage, REVEAL_CHUNK_SIZES.length)) expect(Number.isFinite(field[entrance.y][entrance.x])).toBe(true);
    }
  });

  it('never leaks future floor topology through the fog visibility mask', () => {
    for (let seed = 0; seed < AUTHORED_LAYOUTS.length; seed++) {
      const stage = generateDungeon(seed);
      for (let expand = 0; expand < REVEAL_CHUNK_SIZES.length; expand++) {
        const floor = revealedFloor(stage, expand), mask = revealedMask(stage, expand);
        for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) {
          const cell = `${x},${y}`;
          if (stage.fullGrid[y][x] === 'floor' && !floor.has(cell)) expect(mask.has(cell), `${stage.layoutId}:${expand}:${cell}`).toBe(false);
        }
        for (const spawn of activeSpawnPoints(stage, expand)) if (spawn.x >= 0 && spawn.y >= 0 && spawn.x < 8 && spawn.y < 12)
          expect(mask.has(pointKey(spawn)), `${stage.layoutId}:${expand}:spawn:${pointKey(spawn)}`).toBe(false);
      }
    }
  });

  it('guarantees every offered footprint fits on the opening floor', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const floor = revealedFloor(generateDungeon(seed * 65537), 0);
      for (const trap of Object.values(TRAPS)) expect(placements(floor, trap.shape), trap.name).toBeGreaterThan(0);
    }
  });

  it('connects every authored entrance to the Heart at every reveal state', () => {
    for (let seed = 0; seed < AUTHORED_LAYOUTS.length; seed++) {
      const stage = generateDungeon(seed);
      expect(stage.flowPlans).toHaveLength(REVEAL_CHUNK_SIZES.length + 1);
      for (let expand = 0; expand <= REVEAL_CHUNK_SIZES.length; expand++) {
        const floor = revealedFloor(stage, expand), entrances = activeEntrances(stage, expand);
        const heartField = buildFlowField(stage, expand);
        for (const source of entrances) expect(Number.isFinite(heartField[source.y][source.x])).toBe(true);
        const packing = measurePackingSpace(floor);
        expect(packing.twoByTwoBlocks).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps every revealed floor cell inside the deterministic traffic envelope', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const stage = generateDungeon(seed * 104729);
      for (let expand = 0; expand <= REVEAL_CHUNK_SIZES.length; expand++) {
        const floor = revealedFloor(stage, expand), { traffic } = simulateTraffic(stage, expand);
        for (const cell of floor) expect(traffic.get(cell) ?? 0, `${seed}:${expand}:${cell}`).toBeGreaterThanOrEqual(.0001);
      }
    }
  });

  it('aims low-volume room-coverage arrows at the next macro checkpoint', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const stage = generateDungeon(seed * 130363);
      for (let expand = 0; expand <= REVEAL_CHUNK_SIZES.length; expand++) {
        const { traffic, links } = simulateTraffic(stage, expand);
        for (const [cell, amount] of traffic) {
          if (amount !== .012) continue;
          const link = [...links.values()].find(value => pointKey(value.from) === cell && value.amount === .012);
          expect(link, `${seed}:${expand}:${cell}`).toBeDefined();
          const field = buildFlowField(stage, expand, false, trafficDestination(stage, expand, link!.from));
          expect(field[link!.to.y][link!.to.x], `${seed}:${expand}:${cell}`).toBeLessThan(field[link!.from.y][link!.from.x]);
        }
      }
    }
  });

  it('has exactly ten floor traps, clear elemental tags, and no wall placement', () => {
    expect(Object.values(TRAPS)).toHaveLength(10);
    expect(Object.values(TRAPS).every(trap => trap.placement === 'floor')).toBe(true);
    expect(new Set(Object.values(TRAPS).map(trap => trap.element))).toEqual(new Set(['Physical', 'Fire', 'Frost', 'Water', 'Lightning']));
    expect(TRAPS.tesla.shape).toHaveLength(4);
    expect(TRAPS.ember.shape).toHaveLength(4);
    expect(TRAPS.spikes.shape).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(TRAPS.saw.shape).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
    expect(['saw', 'flame', 'icicle', 'cannon', 'tesla'].every(id => TRAPS[id as keyof typeof TRAPS].canTargetFlying)).toBe(true);
    expect(['spikes', 'ember', 'frost', 'geyser', 'mine'].every(id => !TRAPS[id as keyof typeof TRAPS].canTargetFlying)).toBe(true);
    expect(PERKS).toHaveLength(15);
    expect(PERKS.every(perk => !!perk.scope.element && Object.keys(perk.scope).length === 1)).toBe(true);
    for (const element of ['Physical', 'Fire', 'Frost', 'Water', 'Lightning'])
      expect(PERKS.filter(perk => perk.scope.element === element), element).toHaveLength(3);
    expect(Object.values(TRAPS).every(trap => 1 + Number(Boolean(trap.family)) <= 2)).toBe(true);
    expect(Object.fromEntries(Object.entries(TRAPS).map(([id, trap]) => [id, trap.family ?? null]))).toEqual({
      spikes: null, saw: 'Blade', ember: 'Plate', flame: 'Turret', frost: 'Plate', icicle: 'Turret', geyser: null, cannon: 'Turret', mine: 'Plate', tesla: 'Turret',
    });
    expect({
      geyser: TRAPS.geyser.zone?.checks,
      tesla: TRAPS.tesla.zone?.checks,
      saw: TRAPS.saw.zone?.checks,
      frost: TRAPS.frost.zone?.checks,
      ember: TRAPS.ember.zone?.checks,
      flame: TRAPS.flame.zone?.checks,
      icicle: TRAPS.icicle.zone?.checks,
    }).toEqual({ geyser: 'Fire', tesla: 'Water', saw: 'Lightning', frost: 'Physical', ember: 'Frost', flame: 'Plate', icicle: 'Turret' });
    expect([TRAPS.spikes, TRAPS.mine, TRAPS.cannon].every(trap => !trap.zone)).toBe(true);
    expect(trapActivationOffsets(TRAPS.ember)).toHaveLength(4);
    expect(trapActivationOffsets(TRAPS.frost)).toHaveLength(3);
    expect(trapActivationOffsets(TRAPS.spikes)).toHaveLength(1);
    expect(trapActivationOffsets(TRAPS.tesla)).toHaveLength(1);
    expect(trapActivationOffsets(TRAPS.saw)).toHaveLength(1);
  });

  it('keeps every archetype on the fixed horde budget and introduces Iron March brutes after the opening', () => {
    for (const archetype of ['Green Tide', 'Slippery Ledge', 'Iron March', 'Winged Cavern', 'All-Sides Siege']) {
      for (let wave = 1; wave <= 10; wave++) {
        const preview = buildWavePreview(archetype, wave);
        expect(Object.values(preview).reduce((sum, count) => sum + count, 0)).toBe(24 + wave * 25);
      }
    }
    for (let wave = 1; wave < 6; wave++) expect(buildWavePreview('Iron March', wave).brute).toBe(0);
    expect(buildWavePreview('Iron March', 6).brute).toBeGreaterThan(0);
  });
});
