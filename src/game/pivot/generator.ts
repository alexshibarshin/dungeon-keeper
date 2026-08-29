import { ARCHETYPES, COLS, FINAL_FLOOR_TARGET, INITIAL_FLOOR_TARGET, REVEAL_CHUNK_SIZES, ROWS, TRAPS } from './config';
import type { BoardCell, DungeonStage, FlowPlan, Point } from './types';

export function mulberry32(seed: number) {
  return function rand() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const key = (point: Point) => `${point.x},${point.y}`;
const parse = (value: string): Point => { const [x, y] = value.split(',').map(Number); return { x, y }; };
const dirs: Point[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const inside = (point: Point) => point.x >= 0 && point.y >= 0 && point.x < COLS && point.y < ROWS;
const neighbors = (point: Point) => dirs.map(dir => ({ x: point.x + dir.x, y: point.y + dir.y })).filter(inside);
const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function heartCells(origin: Point) {
  return [origin, { x: origin.x + 1, y: origin.y }, { x: origin.x, y: origin.y + 1 }, { x: origin.x + 1, y: origin.y + 1 }];
}

function distanceFromTargets(floor: Set<string>, targets: Point[]) {
  const distance = new Map<string, number>(), queue: Point[] = [];
  for (const target of targets) {
    if (floor.has(key(target)) && !distance.has(key(target))) { distance.set(key(target), 0); queue.push(target); }
    for (const next of neighbors(target)) if (floor.has(key(next)) && !distance.has(key(next))) {
      distance.set(key(next), 1); queue.push(next);
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const point = queue[index], nextDistance = distance.get(key(point))! + 1;
    for (const next of neighbors(point)) if (floor.has(key(next)) && !distance.has(key(next))) {
      distance.set(key(next), nextDistance); queue.push(next);
    }
  }
  return distance;
}

function connected(floor: Set<string>) {
  const first = [...floor][0];
  if (!first) return false;
  const seen = new Set([first]), queue = [parse(first)];
  for (let index = 0; index < queue.length; index++) for (const next of neighbors(queue[index])) {
    const value = key(next);
    if (floor.has(value) && !seen.has(value)) { seen.add(value); queue.push(next); }
  }
  return seen.size === floor.size;
}

function countShapePlacements(floor: Set<string>, shape: Point[]) {
  let count = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (shape.every(offset => floor.has(`${x + offset.x},${y + offset.y}`))) count++;
  }
  return count;
}

/** A compact but irregular first backpack, broad enough for every footprint. */
function buildInitialFloor(rand: () => number, origin: Point) {
  const mirror = rand() < .5, floor = new Set<string>();
  for (let y = 5; y <= 7; y++) for (let x = 1; x <= 6; x++) floor.add(`${mirror ? COLS - 1 - x : x},${y}`);
  for (let x = 2; x <= 5; x++) floor.add(`${mirror ? COLS - 1 - x : x},8`);
  const pillarOptions = mirror ? [{ x: 5, y: 6 }, { x: 2, y: 7 }] : [{ x: 2, y: 6 }, { x: 5, y: 7 }];
  const edgeOptions = mirror ? [{ x: 1, y: 5 }, { x: 6, y: 7 }] : [{ x: 6, y: 5 }, { x: 1, y: 7 }];
  floor.delete(key(pillarOptions[Math.floor(rand() * pillarOptions.length)]));
  floor.delete(key(edgeOptions[Math.floor(rand() * edgeOptions.length)]));
  for (const cell of heartCells(origin)) floor.delete(key(cell));
  return floor;
}

type GrowthMode = 'north' | 'west' | 'east' | 'split';

function growthScore(candidate: Point, mode: GrowthMode, floor: Set<string>, chunk: Set<string>, rand: () => number) {
  const adjacentFloor = neighbors(candidate).filter(next => floor.has(key(next))).length;
  const adjacentChunk = neighbors(candidate).filter(next => chunk.has(key(next))).length;
  const north = (9 - candidate.y) * 1.25;
  const direction = mode === 'north' ? north * 1.2 - Math.abs(candidate.x - 3.5) * .18
    : mode === 'west' ? (7 - candidate.x) * 1.25 + north * .45
      : mode === 'east' ? candidate.x * 1.25 + north * .45
        : north * .72 + Math.abs(candidate.x - 3.5) * .5;
  // Adjacency dominates after the first cell, forming rooms and bends instead
  // of the one-cell Manhattan tendrils used by the original pivot draft.
  return adjacentFloor * adjacentFloor * 2.15 + adjacentChunk * 4.5 + direction + rand() * 2.4;
}

function growRevealChunk(floor: Set<string>, size: number, mode: GrowthMode, heart: Set<string>, rand: () => number) {
  const chunk = new Set<string>();
  while (chunk.size < size) {
    const candidates = new Map<string, Point>();
    for (const value of [...floor, ...chunk]) for (const next of neighbors(parse(value))) {
      const nextKey = key(next);
      if (floor.has(nextKey) || chunk.has(nextKey) || heart.has(nextKey) || next.y > 8) continue;
      candidates.set(nextKey, next);
    }
    if (!candidates.size) return null;
    const ranked = [...candidates.values()].sort((a, b) => growthScore(b, mode, floor, chunk, rand) - growthScore(a, mode, floor, chunk, rand));
    const poolSize = chunk.size ? Math.min(3, ranked.length) : Math.min(5, ranked.length);
    chunk.add(key(ranked[Math.floor(rand() * poolSize)]));
  }
  for (const value of chunk) floor.add(value);
  return [...chunk].map(parse);
}

function shuffledModes(rand: () => number): GrowthMode[] {
  const modes: GrowthMode[] = ['north', 'west', 'east', 'split'];
  for (let index = modes.length - 1; index > 0; index--) {
    const swap = Math.floor(rand() * (index + 1));
    [modes[index], modes[swap]] = [modes[swap], modes[index]];
  }
  return modes;
}

export function revealChunkSizes(floorTarget: number, rand: () => number) {
  const hidden = floorTarget - INITIAL_FLOOR_TARGET;
  if (hidden < REVEAL_CHUNK_SIZES.length * 4) throw new Error('Every expansion must reveal a meaningful room fragment');
  const sizes = Array.from({ length: REVEAL_CHUNK_SIZES.length }, () => Math.floor(hidden / REVEAL_CHUNK_SIZES.length));
  const order = sizes.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(rand() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  for (let left = hidden - sizes.reduce((sum, value) => sum + value, 0), index = 0; left > 0; left--, index++) sizes[order[index % order.length]]++;
  return sizes;
}

function portalCandidates(floor: Set<string>, fullFloor: Set<string>, final: boolean, origin: Point) {
  const candidates = [...floor].map(parse).filter(point => final
    ? point.y === 0 || point.x === 0 || point.x === COLS - 1
    : neighbors(point).some(next => fullFloor.has(key(next)) && !floor.has(key(next))));
  if (candidates.length) return candidates;
  const distance = distanceFromTargets(floor, heartCells(origin));
  return [...floor].map(parse).sort((a, b) => (distance.get(key(b)) ?? 0) - (distance.get(key(a)) ?? 0)).slice(0, 8);
}

function selectSeparated(candidates: Point[], selected: Point[], distance: Map<string, number>) {
  return [...candidates].filter(candidate => !selected.some(point => key(point) === key(candidate))).sort((a, b) => {
    const spreadA = selected.length ? Math.min(...selected.map(point => manhattan(point, a))) : 99;
    const spreadB = selected.length ? Math.min(...selected.map(point => manhattan(point, b))) : 99;
    return spreadB - spreadA || (distance.get(key(b)) ?? 0) - (distance.get(key(a)) ?? 0);
  })[0];
}

function buildEntrancePlans(floors: Set<string>[], fullFloor: Set<string>, origin: Point, rand: () => number) {
  const finalCountRoll = rand(), finalCount = finalCountRoll < .28 ? 1 : finalCountRoll < .74 ? 2 : 3;
  const initialCount = 1 + Math.floor(rand() * finalCount), plans: Point[][] = [];
  for (let step = 0; step < floors.length; step++) {
    const floor = floors[step], distance = distanceFromTargets(floor, heartCells(origin));
    const desired = Math.min(finalCount, initialCount + Math.floor((finalCount - initialCount) * step / Math.max(1, floors.length - 1) + .5));
    const candidates = portalCandidates(floor, fullFloor, step === floors.length - 1, origin), selected: Point[] = [];
    for (const previous of plans.at(-1) ?? []) {
      const extension = [...candidates].filter(candidate => !selected.some(point => key(point) === key(candidate)))
        .sort((a, b) => manhattan(previous, a) - manhattan(previous, b) || (distance.get(key(b)) ?? 0) - (distance.get(key(a)) ?? 0))[0];
      // A stream keeps its identity: its portal either stays or walks only a
      // short distance into newly exposed floor. Other streams remain stable.
      selected.push(extension && manhattan(previous, extension) <= 4 ? extension : previous);
    }
    while (selected.length < desired) {
      const next = selectSeparated(candidates, selected, distance);
      if (!next) break;
      selected.push(next);
    }
    if (!selected.length) selected.push([...floor].map(parse).sort((a, b) => (distance.get(key(b)) ?? 0) - (distance.get(key(a)) ?? 0))[0]);
    plans.push(selected.slice(0, 3));
  }
  return plans;
}

function traceToDistance(start: Point, targetDistance: number, distance: Map<string, number>) {
  let cursor = start, guard = ROWS * COLS;
  while ((distance.get(key(cursor)) ?? 0) > targetDistance && guard-- > 0) {
    const current = distance.get(key(cursor)) ?? Infinity;
    const next = neighbors(cursor).filter(point => distance.get(key(point)) === current - 1)
      .sort((a, b) => Math.abs(a.x - 3.5) - Math.abs(b.x - 3.5))[0];
    if (!next) break;
    cursor = next;
  }
  return cursor;
}

function buildGates(floor: Set<string>, entrances: Point[], origin: Point, rand: () => number) {
  const distance = distanceFromTargets(floor, heartCells(origin));
  const lead = [...entrances].sort((a, b) => (distance.get(key(b)) ?? 0) - (distance.get(key(a)) ?? 0))[0];
  const maxDistance = distance.get(key(lead)) ?? 1;
  const targets = maxDistance >= 7 ? [Math.round(maxDistance * .64), Math.round(maxDistance * .34)] : [Math.max(2, Math.round(maxDistance * .46))];
  const gates: Point[][] = [];
  for (const target of [...new Set(targets)].sort((a, b) => b - a)) {
    const anchor = traceToDistance(lead, target, distance), gate = [anchor], used = new Set([key(anchor)]);
    const width = rand() < .62 ? 3 : 2;
    while (gate.length < width) {
      const candidates = gate.flatMap(neighbors).filter(point => floor.has(key(point)) && !used.has(key(point)) && Math.abs((distance.get(key(point)) ?? target) - target) <= 1);
      candidates.sort((a, b) => Math.abs((distance.get(key(a)) ?? target) - target) - Math.abs((distance.get(key(b)) ?? target) - target));
      const next = candidates[0];
      if (!next) break;
      used.add(key(next)); gate.push(next);
    }
    if (gate.length >= 2 && !gates.some(existing => existing.some(point => used.has(key(point))))) gates.push(gate);
  }
  return gates;
}

function buildFlowPlans(floors: Set<string>[], fullFloor: Set<string>, origin: Point, rand: () => number): FlowPlan[] {
  const entrances = buildEntrancePlans(floors, fullFloor, origin, rand);
  return floors.map((floor, index) => ({ entrances: entrances[index], gates: buildGates(floor, entrances[index], origin, rand) }));
}

export type TrafficSimulation = {
  traffic: Map<string, number>;
  links: Map<string, { from: Point; to: Point; amount: number }>;
};

function macroDestinationIndex(plan: FlowPlan, heartField: number[][], cell: Point) {
  const distance = heartField[cell.y]?.[cell.x] ?? Infinity;
  const gateIndex = plan.gates.findIndex(gate => {
    if (gate.some(point => point.x === cell.x && point.y === cell.y)) return false;
    const gateDistance = gate.reduce((sum, point) => sum + (heartField[point.y]?.[point.x] ?? distance), 0) / gate.length;
    return gateDistance < distance;
  });
  return gateIndex < 0 ? plan.gates.length : gateIndex;
}

/** The next broad checkpoint a side lane should visually and mechanically join. */
export function trafficDestination(stage: DungeonStage, expandCount: number, cell: Point) {
  const plan = activeFlowPlan(stage, expandCount), heartField = buildFlowField(stage, expandCount);
  return [...plan.gates, heartCells(stage.heartOrigin)][macroDestinationIndex(plan, heartField, cell)];
}

/**
 * A deterministic potential-flow solution shared by validation and the prep
 * arrows. Main mass follows all downhill lanes; low-volume side lanes receive
 * a vector toward their current broad checkpoint so the runtime's density
 * avoidance can occupy the complete room envelope without bypassing the
 * macro-route shown to the player.
 */
export function simulateTraffic(stage: DungeonStage, expandCount: number): TrafficSimulation {
  const floor = revealedFloor(stage, expandCount), plan = activeFlowPlan(stage, expandCount);
  const traffic = new Map<string, number>(), links = new Map<string, { from: Point; to: Point; amount: number }>();
  const destinations = [...plan.gates, heartCells(stage.heartOrigin)];
  const destinationFields = destinations.map(destination => buildFlowField(stage, expandCount, false, destination));
  let sources = new Map<string, number>();
  const entranceShare = 1 / Math.max(1, plan.entrances.length);
  for (const entrance of plan.entrances) sources.set(key(entrance), entranceShare);
  destinations.forEach((destination, destinationIndex) => {
    const field = destinationFields[destinationIndex], local = new Map(sources), arrived = new Map<string, number>();
    const cells = [...floor].map(parse).filter(point => Number.isFinite(field[point.y][point.x])).sort((a, b) => field[b.y][b.x] - field[a.y][a.x]);
    for (const cell of cells) {
      const value = key(cell), amount = local.get(value) ?? 0;
      if (amount <= .000001) continue;
      traffic.set(value, (traffic.get(value) ?? 0) + amount);
      if (destination.some(point => key(point) === value)) { arrived.set(value, (arrived.get(value) ?? 0) + amount); continue; }
      const next = neighbors(cell).filter(point => field[point.y]?.[point.x] === field[cell.y][cell.x] - 1);
      if (!next.length) continue;
      const weights = next.map(point => 1 / (1 + (traffic.get(key(point)) ?? 0) * 3.2));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      next.forEach((point, index) => {
        const flow = amount * weights[index] / total, target = key(point), linkKey = `${value}>${target}`;
        local.set(target, (local.get(target) ?? 0) + flow);
        links.set(linkKey, { from: cell, to: point, amount: (links.get(linkKey)?.amount ?? 0) + flow });
      });
    }
    sources = arrived;
  });
  const heartField = buildFlowField(stage, expandCount);
  for (const value of floor) if (!traffic.has(value)) {
    const cell = parse(value), field = destinationFields[macroDestinationIndex(plan, heartField, cell)];
    const next = neighbors(cell).filter(point => (floor.has(key(point)) || stage.fullGrid[point.y][point.x] === 'heart') && field[point.y][point.x] < field[cell.y][cell.x])
      .sort((a, b) => field[a.y][a.x] - field[b.y][b.x])[0];
    traffic.set(value, .012);
    if (next) links.set(`${value}>${key(next)}`, { from: cell, to: next, amount: .012 });
  }
  return { traffic, links };
}

export function measurePackingSpace(floor: Set<string>) {
  let twoByTwoBlocks = 0, straightCorridorCells = 0, junctionCells = 0, maxHorizontalRun = 0, maxVerticalRun = 0, deadEnds = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (!floor.has(`${x},${y}`)) continue;
    const open = dirs.filter(dir => floor.has(`${x + dir.x},${y + dir.y}`));
    if (open.length >= 3) junctionCells++;
    if (open.length <= 1) deadEnds++;
    if (open.length === 2 && open[0].x + open[1].x === 0 && open[0].y + open[1].y === 0) straightCorridorCells++;
    if (floor.has(`${x + 1},${y}`) && floor.has(`${x},${y + 1}`) && floor.has(`${x + 1},${y + 1}`)) twoByTwoBlocks++;
    let horizontal = 0; while (floor.has(`${x + horizontal},${y}`)) horizontal++; maxHorizontalRun = Math.max(maxHorizontalRun, horizontal);
    let vertical = 0; while (floor.has(`${x},${y + vertical}`)) vertical++; maxVerticalRun = Math.max(maxVerticalRun, vertical);
  }
  return { twoByTwoBlocks, straightCorridorCells, junctionCells, maxHorizontalRun, maxVerticalRun, deadEnds };
}

function gatesAreValid(floor: Set<string>, plan: FlowPlan) {
  if (plan.entrances.length < 1 || plan.entrances.length > 3 || plan.entrances.some(point => !floor.has(key(point)))) return false;
  for (const gate of plan.gates) {
    if (gate.length < 2 || gate.length > 3 || gate.some(point => !floor.has(key(point)))) return false;
    const gateSet = new Set(gate.map(key)), seen = new Set([key(gate[0])]), queue = [gate[0]];
    for (let index = 0; index < queue.length; index++) for (const next of neighbors(queue[index])) {
      if (gateSet.has(key(next)) && !seen.has(key(next))) { seen.add(key(next)); queue.push(next); }
    }
    if (seen.size !== gate.length) return false;
  }
  return true;
}

function validStage(stage: DungeonStage) {
  const start = revealedFloor(stage, 0);
  if (start.size !== INITIAL_FLOOR_TARGET || !connected(start)) return false;
  if (Object.values(TRAPS).some(trap => countShapePlacements(start, trap.shape) < 1)) return false;
  if (countShapePlacements(start, TRAPS.ember.shape) < 2 || countShapePlacements(start, TRAPS.tesla.shape) < 3) return false;
  const startPacking = measurePackingSpace(start);
  if (startPacking.twoByTwoBlocks < 3 || startPacking.junctionCells < 6 || startPacking.maxHorizontalRun < 4 || startPacking.maxVerticalRun < 3) return false;
  let previousFloor = new Set<string>(), previousEntranceCount = 0;
  for (let step = 0; step <= stage.revealPlan.length; step++) {
    const floor = revealedFloor(stage, step), plan = activeFlowPlan(stage, step);
    if (!connected(floor) || [...previousFloor].some(value => !floor.has(value))) return false;
    if ((step > 0 && (plan.entrances.length < previousEntranceCount || plan.entrances.length - previousEntranceCount > 1)) || !gatesAreValid(floor, plan)) return false;
    for (const entrance of plan.entrances) {
      for (const gate of plan.gates) if (!Number.isFinite(buildFlowField(stage, step, false, gate)[entrance.y][entrance.x])) return false;
      if (!Number.isFinite(buildFlowField(stage, step)[entrance.y][entrance.x])) return false;
    }
    const traffic = simulateTraffic(stage, step).traffic;
    const used = [...floor].filter(value => (traffic.get(value) ?? 0) > 0).length / floor.size;
    if (used < .82) return false;
    const packing = measurePackingSpace(floor);
    if (packing.twoByTwoBlocks < 3 || packing.deadEnds > Math.max(3, Math.floor(floor.size * .12))) return false;
    previousFloor = floor; previousEntranceCount = plan.entrances.length;
  }
  const finalPacking = measurePackingSpace(revealedFloor(stage, stage.revealPlan.length));
  return finalPacking.twoByTwoBlocks >= 8 && finalPacking.junctionCells >= 14;
}

export function generateDungeon(seed: number, floorTarget = FINAL_FLOOR_TARGET): DungeonStage {
  const archetype = ARCHETYPES[Math.abs(seed) % ARCHETYPES.length];
  for (let attempt = 0; attempt < 420; attempt++) {
    const layoutSeed = (seed + Math.imul(attempt, 0x9e3779b1)) >>> 0, rand = mulberry32(layoutSeed ^ 0xa11ce);
    const origin = { x: 3, y: 9 }, hearts = heartCells(origin), heartSet = new Set(hearts.map(key));
    const floor = buildInitialFloor(rand, origin);
    if (floor.size !== INITIAL_FLOOR_TARGET || !connected(floor)) continue;
    const initialFloor = [...floor].map(parse), revealPlan: { cells: Point[] }[] = [];
    const modes = shuffledModes(rand), sizes = revealChunkSizes(floorTarget, rand);
    let failed = false;
    for (let index = 0; index < sizes.length; index++) {
      const cells = growRevealChunk(floor, sizes[index], modes[index], heartSet, rand);
      if (!cells) { failed = true; break; }
      revealPlan.push({ cells });
    }
    if (failed || Number(floor.size) !== floorTarget || !connected(floor)) continue;
    const fullGrid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'wall' as BoardCell));
    for (const value of floor) { const point = parse(value); fullGrid[point.y][point.x] = 'floor'; }
    for (const point of hearts) fullGrid[point.y][point.x] = 'heart';
    const floors = [new Set(initialFloor.map(key))];
    for (const reveal of revealPlan) floors.push(new Set([...floors.at(-1)!, ...reveal.cells.map(key)]));
    const flowPlans = buildFlowPlans(floors, floor, origin, rand);
    const stage: DungeonStage = {
      seed, name: archetype.name, archetype: archetype.archetype, tagline: archetype.tagline,
      fullGrid, heartOrigin: origin, revealPlan, initialFloor,
      finalEntrances: flowPlans.at(-1)!.entrances, flowPlans,
    };
    if (validStage(stage)) return stage;
  }
  throw new Error(`Unable to generate validated dungeon for seed ${seed}`);
}

export function revealedFloor(stage: DungeonStage, expandCount: number) {
  const result = new Set(stage.initialFloor.map(key));
  for (let index = 0; index < Math.min(expandCount, stage.revealPlan.length); index++) for (const point of stage.revealPlan[index].cells) result.add(key(point));
  return result;
}

export function revealedMask(stage: DungeonStage, expandCount: number) {
  if (expandCount >= stage.revealPlan.length) return new Set(Array.from({ length: ROWS * COLS }, (_, index) => `${index % COLS},${Math.floor(index / COLS)}`));
  const floor = revealedFloor(stage, expandCount), visible = new Set(floor);
  for (const value of floor) for (const next of neighbors(parse(value))) visible.add(key(next));
  for (const point of heartCells(stage.heartOrigin)) {
    visible.add(key(point));
    for (const next of neighbors(point)) visible.add(key(next));
  }
  return visible;
}

export function activeFlowPlan(stage: DungeonStage, expandCount: number) {
  return stage.flowPlans[Math.min(expandCount, stage.flowPlans.length - 1)];
}

export function activeEntrances(stage: DungeonStage, expandCount: number) {
  return activeFlowPlan(stage, expandCount).entrances;
}

export function activeFlowGates(stage: DungeonStage, expandCount: number) {
  return activeFlowPlan(stage, expandCount).gates;
}

export function buildFlowField(stage: DungeonStage, expandCount: number, _flying = false, targets?: Point[]) {
  const floor = revealedFloor(stage, expandCount);
  const distance = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => Infinity));
  const selected = targets?.filter(point => floor.has(key(point)));
  const queue = selected?.length ? [...selected] : heartCells(stage.heartOrigin);
  for (const point of queue) distance[point.y][point.x] = 0;
  for (let index = 0; index < queue.length; index++) {
    const point = queue[index], nextDistance = distance[point.y][point.x] + 1;
    for (const next of neighbors(point)) {
      const passable = floor.has(key(next)) || stage.fullGrid[next.y][next.x] === 'heart';
      if (passable && nextDistance < distance[next.y][next.x]) { distance[next.y][next.x] = nextDistance; queue.push(next); }
    }
  }
  return distance;
}
