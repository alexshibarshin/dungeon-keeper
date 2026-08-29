import { describe, expect, it } from 'vitest';
import { FINAL_FLOOR_TARGET, INITIAL_FLOOR_TARGET, PERKS, REVEAL_CHUNK_SIZES, TRAPS, buildWavePreview, trapActivationOffsets } from './config';
import { activeEntrances, activeFlowGates, buildFlowField, generateDungeon, measurePackingSpace, revealedFloor, simulateTraffic, trafficDestination } from './generator';

const placements = (floor: Set<string>, shape: { x: number; y: number }[]) => {
  let result = 0;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++) if (shape.every(p => floor.has(`${x + p.x},${y + p.y}`))) result++;
  return result;
};
const pointKey = (point: { x: number; y: number }) => `${point.x},${point.y}`;
const pointDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const contiguous = (points: { x: number; y: number }[]) => {
  const all = new Set(points.map(pointKey)), seen = new Set([pointKey(points[0])]), queue = [points[0]];
  for (let index = 0; index < queue.length; index++) {
    const point = queue[index];
    for (const next of [{ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 }]) {
      if (all.has(pointKey(next)) && !seen.has(pointKey(next))) { seen.add(pointKey(next)); queue.push(next); }
    }
  }
  return seen.size === points.length;
};

describe('floor-only backpack dungeon', () => {
  it('generates a broad 1,000-seed corpus without escaping the validated contract', () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      const stage = generateDungeon(seed * 2654435761);
      expect(stage.initialFloor).toHaveLength(INITIAL_FLOOR_TARGET);
      expect(revealedFloor(stage, REVEAL_CHUNK_SIZES.length).size).toBe(FINAL_FLOOR_TARGET);
      expect(stage.flowPlans).toHaveLength(REVEAL_CHUNK_SIZES.length + 1);
    }
  });

  it('generates deterministic, connected four-step reveals with 1–3 portals', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const stage = generateDungeon(seed * 7919);
      expect(stage).toEqual(generateDungeon(seed * 7919));
      expect(stage.initialFloor).toHaveLength(INITIAL_FLOOR_TARGET);
      expect(stage.revealPlan.map(s => s.cells.length).sort()).toEqual([...REVEAL_CHUNK_SIZES].sort());
      expect(revealedFloor(stage, REVEAL_CHUNK_SIZES.length).size).toBe(FINAL_FLOOR_TARGET);
      expect(activeEntrances(stage, 0).length).toBeGreaterThanOrEqual(1);
      expect(activeEntrances(stage, 0).length).toBeLessThanOrEqual(3);
      expect(activeFlowGates(stage, 0).length).toBeGreaterThanOrEqual(1);
      expect(activeFlowGates(stage, 0).length).toBeLessThanOrEqual(2);
      expect(activeFlowGates(stage, 0)[0].length).toBeGreaterThan(0);
      for (const gate of activeFlowGates(stage, 0)[0]) expect(revealedFloor(stage, 0).has(`${gate.x},${gate.y}`)).toBe(true);
      const field = buildFlowField(stage, REVEAL_CHUNK_SIZES.length);
      for (const entrance of activeEntrances(stage, REVEAL_CHUNK_SIZES.length)) expect(Number.isFinite(field[entrance.y][entrance.x])).toBe(true);
      for (let expand = 0; expand <= REVEAL_CHUNK_SIZES.length; expand++) {
        for (const gate of activeFlowGates(stage, expand)) {
          const gateField = buildFlowField(stage, expand, false, gate);
          for (const entrance of activeEntrances(stage, expand)) expect(Number.isFinite(gateField[entrance.y][entrance.x]), `${seed}:${expand}`).toBe(true);
        }
      }
    }
  });

  it('guarantees every offered footprint fits on the opening floor', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const floor = revealedFloor(generateDungeon(seed * 65537), 0);
      for (const trap of Object.values(TRAPS)) expect(placements(floor, trap.shape), trap.name).toBeGreaterThan(0);
    }
  });

  it('pre-generates stable stream extensions and contiguous ordered room gates', () => {
    for (let seed = 1; seed <= 240; seed++) {
      const stage = generateDungeon(seed * 8191);
      expect(stage.flowPlans).toHaveLength(REVEAL_CHUNK_SIZES.length + 1);
      let previousFloor = new Set<string>(), previousEntrances: { x: number; y: number }[] = [];
      for (let expand = 0; expand <= REVEAL_CHUNK_SIZES.length; expand++) {
        const floor = revealedFloor(stage, expand), entrances = activeEntrances(stage, expand), gates = activeFlowGates(stage, expand);
        for (const cell of previousFloor) expect(floor.has(cell), `${seed}:${expand}:${cell}`).toBe(true);
        if (expand > 0) {
          expect(entrances.length).toBeGreaterThanOrEqual(previousEntrances.length);
          expect(entrances.length - previousEntrances.length).toBeLessThanOrEqual(1);
        }
        previousEntrances.forEach((portal, index) => expect(pointDistance(portal, entrances[index]), `${seed}:${expand}:stream-${index}`).toBeLessThanOrEqual(4));
        expect(gates.length).toBeGreaterThanOrEqual(1);
        let sources = entrances;
        for (const gate of gates) {
          expect(gate.length).toBeGreaterThanOrEqual(2);
          expect(gate.length).toBeLessThanOrEqual(3);
          expect(contiguous(gate)).toBe(true);
          const field = buildFlowField(stage, expand, false, gate);
          for (const source of sources) expect(Number.isFinite(field[source.y][source.x]), `${seed}:${expand}:${pointKey(source)}`).toBe(true);
          sources = gate;
        }
        const heartField = buildFlowField(stage, expand);
        for (const source of sources) expect(Number.isFinite(heartField[source.y][source.x])).toBe(true);
        const packing = measurePackingSpace(floor);
        expect(packing.twoByTwoBlocks).toBeGreaterThanOrEqual(3);
        expect(packing.deadEnds).toBeLessThanOrEqual(Math.max(3, Math.floor(floor.size * .12)));
        previousFloor = floor; previousEntrances = entrances;
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
