import { ARCHETYPES, COLS, REVEAL_CHUNK_SIZES, ROWS } from './config';
import { AUTHORED_LAYOUTS } from './layouts';
import type { BoardCell, DungeonStage, FlowPlan, Point } from './types';

export function mulberry32(seed: number) {
  return function rand() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const key = (point: Point) => `${point.x},${point.y}`;
const parse = (value: string): Point => { const [x, y] = value.split(',').map(Number); return { x, y }; };
const dirs: Point[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const inside = (point: Point) => point.x >= 0 && point.y >= 0 && point.x < COLS && point.y < ROWS;
const neighbors = (point: Point) => dirs.map(dir => ({ x: point.x + dir.x, y: point.y + dir.y })).filter(inside);
const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const heartCells = (origin: Point) => [origin, { x: origin.x + 1, y: origin.y }, { x: origin.x, y: origin.y + 1 }, { x: origin.x + 1, y: origin.y + 1 }];

export type TrafficSimulation = { traffic: Map<string, number>; links: Map<string, { from: Point; to: Point; amount: number }> };

export function trafficDestination(stage: DungeonStage, _expandCount: number, _cell: Point) { return heartCells(stage.heartOrigin); }

/** Deterministic potential flow shared by prep arrows and combat. */
export function simulateTraffic(stage: DungeonStage, expandCount: number): TrafficSimulation {
  const floor = revealedFloor(stage, expandCount), plan = activeFlowPlan(stage, expandCount), heartField = buildFlowField(stage, expandCount);
  const traffic = new Map<string, number>(), links = new Map<string, { from: Point; to: Point; amount: number }>(), local = new Map<string, number>();
  const entranceShare = 1 / Math.max(1, plan.entrances.length);
  for (const entrance of plan.entrances) local.set(key(entrance), entranceShare);
  const cells = [...floor].map(parse).filter(point => Number.isFinite(heartField[point.y][point.x])).sort((a, b) => heartField[b.y][b.x] - heartField[a.y][a.x]);
  for (const cell of cells) {
    const value = key(cell), amount = local.get(value) ?? 0;
    if (amount <= .000001) continue;
    traffic.set(value, (traffic.get(value) ?? 0) + amount);
    const next = neighbors(cell).filter(point => heartField[point.y]?.[point.x] === heartField[cell.y][cell.x] - 1);
    if (!next.length) continue;
    const weights = next.map(point => 1 / (1 + (traffic.get(key(point)) ?? 0) * 3.2)), total = weights.reduce((sum, weight) => sum + weight, 0);
    next.forEach((point, index) => {
      const flow = amount * weights[index] / total, target = key(point), linkKey = `${value}>${target}`;
      local.set(target, (local.get(target) ?? 0) + flow);
      links.set(linkKey, { from: cell, to: point, amount: (links.get(linkKey)?.amount ?? 0) + flow });
    });
  }
  for (const value of floor) if (!traffic.has(value)) {
    const cell = parse(value), next = neighbors(cell).filter(point => (floor.has(key(point)) || stage.fullGrid[point.y][point.x] === 'heart') && heartField[point.y][point.x] < heartField[cell.y][cell.x])
      .sort((a, b) => heartField[a.y][a.x] - heartField[b.y][b.x])[0];
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
    if (open.length >= 3) junctionCells++; if (open.length <= 1) deadEnds++;
    if (open.length === 2 && open[0].x + open[1].x === 0 && open[0].y + open[1].y === 0) straightCorridorCells++;
    if (floor.has(`${x + 1},${y}`) && floor.has(`${x},${y + 1}`) && floor.has(`${x + 1},${y + 1}`)) twoByTwoBlocks++;
    let horizontal = 0; while (floor.has(`${x + horizontal},${y}`)) horizontal++; maxHorizontalRun = Math.max(maxHorizontalRun, horizontal);
    let vertical = 0; while (floor.has(`${x},${y + vertical}`)) vertical++; maxVerticalRun = Math.max(maxVerticalRun, vertical);
  }
  return { twoByTwoBlocks, straightCorridorCells, junctionCells, maxHorizontalRun, maxVerticalRun, deadEnds };
}

/** Selects and materializes one of the configured authored layouts. */
export function generateDungeon(seed: number): DungeonStage {
  const unsignedSeed = seed >>> 0, layout = AUTHORED_LAYOUTS[unsignedSeed % AUTHORED_LAYOUTS.length];
  const archetype = ARCHETYPES[Math.floor(unsignedSeed / AUTHORED_LAYOUTS.length) % ARCHETYPES.length];
  if (layout.zones.length !== ROWS || layout.zones.some(row => row.length !== COLS)) throw new Error(`Authored layout ${layout.id} must be ${COLS}×${ROWS}`);
  if (layout.portals.length !== REVEAL_CHUNK_SIZES.length + 1) throw new Error(`Authored layout ${layout.id} needs one portal plan per reveal state`);
  const fullGrid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'wall' as BoardCell));
  const zones = Array.from({ length: REVEAL_CHUNK_SIZES.length + 1 }, () => [] as Point[]), hearts: Point[] = [];
  layout.zones.forEach((row, y) => [...row].forEach((cell, x) => {
    if (/^[1-5]$/.test(cell)) { fullGrid[y][x] = 'floor'; zones[Number(cell) - 1].push({ x, y }); }
    else if (cell === 'H') { fullGrid[y][x] = 'heart'; hearts.push({ x, y }); }
    else if (cell !== '#') throw new Error(`Unknown cell '${cell}' in authored layout ${layout.id}`);
  }));
  if (hearts.length !== 4) throw new Error(`Authored layout ${layout.id} must contain a 2×2 Heart`);
  const heartOrigin = { x: Math.min(...hearts.map(point => point.x)), y: Math.min(...hearts.map(point => point.y)) };
  if (!heartCells(heartOrigin).every(point => fullGrid[point.y]?.[point.x] === 'heart')) throw new Error(`Heart in authored layout ${layout.id} must be contiguous`);
  const initialFloor = zones[0], revealPlan = zones.slice(1).map(cells => ({ cells })), floors = [new Set(initialFloor.map(key))];
  for (const reveal of revealPlan) floors.push(new Set([...floors.at(-1)!, ...reveal.cells.map(key)]));
  const flowPlans: FlowPlan[] = floors.map((floor, index) => {
    const portals = layout.portals[index];
    for (const { spawn, entrance } of portals) {
      if (!floor.has(key(entrance))) throw new Error(`Portal entrance ${key(entrance)} is not revealed in ${layout.id} state ${index}`);
      if (manhattan(spawn, entrance) !== 1) throw new Error(`Portal spawn ${key(spawn)} must border entrance ${key(entrance)} in ${layout.id}`);
    }
    return { entrances: portals.map(portal => ({ ...portal.entrance })), spawnPoints: portals.map(portal => ({ ...portal.spawn })), gates: [] };
  });
  return { seed, layoutId: layout.id, name: archetype.name, archetype: archetype.archetype, tagline: archetype.tagline, fullGrid, heartOrigin, revealPlan, initialFloor, finalEntrances: flowPlans.at(-1)!.entrances, flowPlans };
}

export function revealedFloor(stage: DungeonStage, expandCount: number) {
  const result = new Set(stage.initialFloor.map(key));
  for (let index = 0; index < Math.min(expandCount, stage.revealPlan.length); index++) for (const point of stage.revealPlan[index].cells) result.add(key(point));
  return result;
}

export function revealedMask(stage: DungeonStage, expandCount: number) {
  if (expandCount >= stage.revealPlan.length) return new Set(Array.from({ length: ROWS * COLS }, (_, index) => `${index % COLS},${Math.floor(index / COLS)}`));
  const floor = revealedFloor(stage, expandCount), visible = new Set(floor);
  // The silhouette of a future room is secret. Only bordering rock may be
  // exposed around the current floor; an unrevealed floor cell never enters
  // the mask merely because it touches the playable area.
  const revealRock = (point: Point) => { if (stage.fullGrid[point.y][point.x] === 'wall') visible.add(key(point)); };
  for (const value of floor) for (const next of neighbors(parse(value))) revealRock(next);
  for (const point of heartCells(stage.heartOrigin)) { visible.add(key(point)); for (const next of neighbors(point)) revealRock(next); }
  // A portal warning floats over the unknown. Its cell stays fogged even when
  // that coordinate happens to be bordering rock rather than future floor.
  for (const spawn of activeFlowPlan(stage, expandCount).spawnPoints) if (inside(spawn)) visible.delete(key(spawn));
  return visible;
}

export function activeFlowPlan(stage: DungeonStage, expandCount: number) { return stage.flowPlans[Math.min(expandCount, stage.flowPlans.length - 1)]; }
export function activeEntrances(stage: DungeonStage, expandCount: number) { return activeFlowPlan(stage, expandCount).entrances; }
export function activeSpawnPoints(stage: DungeonStage, expandCount: number) { return activeFlowPlan(stage, expandCount).spawnPoints; }
export function activeFlowGates(stage: DungeonStage, expandCount: number) { return activeFlowPlan(stage, expandCount).gates; }

export function buildFlowField(stage: DungeonStage, expandCount: number, _flying = false, targets?: Point[]) {
  const floor = revealedFloor(stage, expandCount), distance = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => Infinity));
  const selected = targets?.filter(point => floor.has(key(point))), queue = selected?.length ? [...selected] : heartCells(stage.heartOrigin);
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
