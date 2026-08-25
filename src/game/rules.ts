import { COLS, GUARANTEED_OFFER_MAX_PRICE, ROWS, SHAPES, TRAPS, shapePrice } from './config';
import type { CellKind, EnemyKind, Point, StageSpec, TrapOffer } from './types';

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const STAGES = [
  { name: 'Излом Багрового Зуба', archetype: 'Зелёная волна', tagline: 'Плотная орда. Площадь решает.' },
  { name: 'Колодец Скользких Клятв', archetype: 'Скользкий обрыв', tagline: 'Повороты и пропасти. Толкай их.' },
  { name: 'Казематы Железной Поступи', archetype: 'Железное шествие', tagline: 'Броня идёт. Реакции ломают.' },
  { name: 'Грот Пепельных Крыльев', archetype: 'Воздушная пещера', tagline: 'Небо тоже принадлежит Хранителю.' },
  { name: 'Четыре Пасти Бездны', archetype: 'Осада со всех сторон', tagline: 'Каждая тропа ведёт к сердцу.' },
];

export function generateStage(seed: number): StageSpec {
  const rand = mulberry32(seed);
  const archetypeIndex = Math.floor(rand() * STAGES.length);
  const meta = STAGES[archetypeIndex];
  const grid: CellKind[][] = Array.from({ length: ROWS }, () => Array<CellKind>(COLS).fill('rock'));
  const heart = { x: 1 + Math.floor(rand() * 5), y: rand() < .22 ? 8 : 9 };
  const topA = 1 + Math.floor(rand() * 2);
  const topB = 5 + Math.floor(rand() * 2);
  // The first lateral spawn is always across the cave from the heart. This
  // avoids throwaway three-cell approaches when the heart happens to hug an edge.
  const sideFromLeft = heart.x >= 4;
  const entrances: Point[] = [
    { x: topA, y: 0 },
    { x: topB, y: 0 },
    { x: sideFromLeft ? 0 : COLS - 1, y: 2 + Math.floor(rand() * 2) },
  ];
  if (archetypeIndex === 4) entrances.push({ x: sideFromLeft ? COLS - 1 : 0, y: 1 + Math.floor(rand() * 2) });

  const carved: Point[] = [];
  const carve = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
    if (grid[y][x] !== 'heart') grid[y][x] = 'floor';
    if (!carved.some(p => p.x === x && p.y === y)) carved.push({ x, y });
  };
  const carveSegment = (from: Point, to: Point, horizontalFirst = rand() < .5) => {
    let x = from.x, y = from.y;
    carve(x, y);
    const walkX = () => { while (x !== to.x) { x += Math.sign(to.x - x); carve(x, y); } };
    const walkY = () => { while (y !== to.y) { y += Math.sign(to.y - y); carve(x, y); } };
    if (horizontalFirst) { walkX(); walkY(); } else { walkY(); walkX(); }
  };
  const oppositeSideX = (x: number) => x <= 3 ? 4 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 3);

  // Build the stage as a graph first: three alternating horizontal shelves make
  // a guaranteed winding backbone. Random orthogonal L-carving could collapse
  // into a straight vertical shortcut, which is exactly the empty-map failure
  // this prototype is meant to avoid.
  const bendA = { x: oppositeSideX(entrances[0].x), y: 1 };
  const nearSide = bendA.x > 3 ? [1, 2, 3] : [4, 5, 6];
  const bendBChoices = nearSide.filter(x => x !== entrances[0].x);
  const bendB = { x: bendBChoices[Math.floor(rand() * bendBChoices.length)], y: 4 };
  const bendC = { x: oppositeSideX(bendB.x), y: 7 };
  const approach = { x: Math.max(1, Math.min(6, heart.x + (rand() < .5 ? 0 : 1))), y: heart.y - 1 };
  const backbone = [entrances[0], { x: entrances[0].x, y: 1 }, bendA, { x: bendA.x, y: bendB.y }, bendB, { x: bendB.x, y: bendC.y }, bendC, { x: approach.x, y: bendC.y }, approach];
  for (let i = 0; i < backbone.length - 1; i++) carveSegment(backbone[i], backbone[i + 1], true);

  // Other approaches join different shelves. Their intersections create useful
  // splits for liquid crowds without excavating one giant common room.
  const secondDrop = { x: entrances[1].x, y: bendB.y };
  carveSegment(entrances[1], secondDrop, true); carveSegment(secondDrop, bendB, true);
  const sideInside = { x: entrances[2].x === 0 ? 1 : COLS - 2, y: entrances[2].y };
  carveSegment(entrances[2], sideInside, true);
  carveSegment(sideInside, { x: sideInside.x, y: bendA.y }, true);
  carveSegment({ x: sideInside.x, y: bendA.y }, bendA, true);
  if (entrances[3]) {
    const inside = { x: entrances[3].x === 0 ? 1 : COLS - 2, y: entrances[3].y };
    const dropX = entrances[3].x === 0 ? COLS - 2 : 3;
    carveSegment(entrances[3], inside, true);
    carveSegment(inside, { x: dropX, y: inside.y }, true);
    carveSegment({ x: dropX, y: inside.y }, { x: dropX, y: bendC.y }, true);
    carveSegment({ x: dropX, y: bendC.y }, bendC, true);
  }

  // One compact fitting bay is guaranteed. Green Tide receives a second broad
  // section, but no archetype is allowed to become a mostly empty chamber.
  const widen = (anchor: Point, flip: boolean) => {
    const x = Math.max(0, Math.min(COLS - 2, anchor.x + (flip ? -1 : 0)));
    const y = Math.max(1, Math.min(ROWS - 3, anchor.y));
    carve(x, y); carve(x + 1, y); carve(x, y + 1); carve(x + 1, y + 1);
  };
  widen(rand() < .5 ? bendA : bendB, rand() < .5);
  if (archetypeIndex === 0) widen(approach, heart.x > 3);

  for (let y = heart.y; y < heart.y + 2; y++) for (let x = heart.x; x < heart.x + 2; x++) grid[y][x] = 'heart';
  carveSegment(approach, { x: heart.x + (approach.x > heart.x ? 1 : 0), y: heart.y });
  for (let y = heart.y; y < heart.y + 2; y++) for (let x = heart.x; x < heart.x + 2; x++) grid[y][x] = 'heart';
  for (const e of entrances) grid[e.y][e.x] = 'floor';

  const shuffled = <T>(items: T[]) => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  };
  const pitCandidates: Point[] = [];
  for (let y = 1; y < ROWS - 1; y++) for (let x = 0; x < COLS; x++) {
    if (grid[y][x] !== 'rock') continue;
    const faces = openFacesFor(grid, x, y);
    if (faces.length >= 1 && faces.length <= 2) pitCandidates.push({ x, y });
  }
  const pitCount = archetypeIndex === 1 ? 5 : archetypeIndex === 3 ? 1 : archetypeIndex === 4 ? 3 : 2;
  for (const p of shuffled(pitCandidates).slice(0, pitCount)) grid[p.y][p.x] = 'pit';

  // Bedrock grows as one short contiguous motif, never as random confetti.
  const eternalTarget = archetypeIndex === 2 ? 5 : archetypeIndex === 4 ? 4 : 3;
  const rockSeeds: Point[] = [];
  for (let y = 1; y < ROWS - 1; y++) for (let x = 1; x < COLS - 1; x++) if (grid[y][x] === 'rock') rockSeeds.push({ x, y });
  const components: Point[][] = [];
  const unseen = new Set(rockSeeds.map(p => `${p.x},${p.y}`));
  for (const seedCell of shuffled(rockSeeds)) {
    if (!unseen.delete(`${seedCell.x},${seedCell.y}`)) continue;
    const component = [seedCell];
    for (let i = 0; i < component.length; i++) for (const n of [{ x: component[i].x + 1, y: component[i].y }, { x: component[i].x - 1, y: component[i].y }, { x: component[i].x, y: component[i].y + 1 }, { x: component[i].x, y: component[i].y - 1 }]) {
      if (unseen.delete(`${n.x},${n.y}`)) component.push(n);
    }
    components.push(component);
  }
  const bedrockSource = shuffled(components.filter(c => c.length >= eternalTarget))[0] ?? components.sort((a, b) => b.length - a.length)[0] ?? [];
  if (bedrockSource.length) {
    const allowed = new Set(bedrockSource.map(p => `${p.x},${p.y}`));
    const queue = [bedrockSource[Math.floor(rand() * bedrockSource.length)]];
    const used = new Set<string>();
    while (queue.length && used.size < eternalTarget) {
      const p = queue.shift()!, key = `${p.x},${p.y}`;
      if (used.has(key) || !allowed.has(key)) continue;
      used.add(key); grid[p.y][p.x] = 'eternal';
      queue.push(...shuffled([{ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 }]));
    }
  }

  return { seed, ...meta, grid, entrances, heart };
}

export function isPassable(cell: CellKind, flying = false) {
  return cell === 'floor' || cell === 'heart' || (flying && cell === 'pit');
}

export function openFacesFor(grid: CellKind[][], x: number, y: number) {
  return [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].filter(face => {
    const nx = x + face.x, ny = y + face.y;
    return nx >= 0 && ny >= 0 && ny < grid.length && nx < grid[ny].length && ['floor', 'heart'].includes(grid[ny][nx]);
  });
}

export function buildFlowField(grid: CellKind[][], heart: Point, flying = false) {
  const dist = Array.from({ length: ROWS }, () => Array(COLS).fill(Infinity));
  const queue: Point[] = [];
  for (let y = heart.y; y < heart.y + 2; y++) for (let x = heart.x; x < heart.x + 2; x++) {
    dist[y][x] = 0; queue.push({ x, y });
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const n of [{ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 }]) {
      if (n.x < 0 || n.y < 0 || n.x >= COLS || n.y >= ROWS || !isPassable(grid[n.y][n.x], flying)) continue;
      if (dist[n.y][n.x] > dist[p.y][p.x] + 1) { dist[n.y][n.x] = dist[p.y][p.x] + 1; queue.push(n); }
    }
  }
  return dist;
}

export function allEntrancesConnected(grid: CellKind[][], stage: StageSpec) {
  const field = buildFlowField(grid, stage.heart);
  return stage.entrances.every(e => Number.isFinite(field[e.y][e.x]));
}

export function wavePreview(wave: number, archetype: string): Record<EnemyKind, number> {
  const count = 10 + wave * 12;
  const special = Math.floor(count * Math.min(.1 + wave * .018, .25));
  const result: Record<EnemyKind, number> = { delver: count, runner: 0, brute: 0, shield: 0, wing: 0 };
  if (archetype === 'Воздушная пещера') result.wing = special;
  else if (archetype === 'Железное шествие') { result.brute = Math.ceil(special * .45); result.shield = special - result.brute; }
  else if (archetype === 'Скользкий обрыв') result.runner = special;
  else if (archetype === 'Зелёная волна') result.runner = Math.ceil(special * .35);
  else { result.runner = Math.ceil(special * .6); result.shield = special - result.runner; }
  result.delver -= result.runner + result.brute + result.shield + result.wing;
  return result;
}

export function enemyHpScale(wave: number) {
  const waveIndex = Math.max(0, wave - 1);
  return 1 + waveIndex * .13 + waveIndex * waveIndex * .012;
}

export function waveClearReward(wave: number) {
  return GUARANTEED_OFFER_MAX_PRICE + Math.floor(wave / 2);
}

export function activeEntranceCount(wave: number, totalEntrances: number) {
  const unlocked = 1 + Number(wave >= 3) + Number(wave >= 5) + Number(wave >= 7);
  return Math.min(totalEntrances, unlocked);
}

export function offerFor(rand: () => number, deck: string[], index: number, maxPrice = Infinity): TrapOffer {
  const trapId = deck[Math.floor(rand() * deck.length)];
  const def = TRAPS[trapId];
  const eligible = SHAPES.filter(s => s.length <= def.maxSize && shapePrice(def.basePrice, s.length) <= maxPrice && (def.placement === 'floor' || s.every(p => p.y === 0 || p.x === 0)));
  const shape = eligible[Math.floor(rand() * eligible.length)];
  return { id: `offer-${index}-${Math.floor(rand() * 1e8)}`, trapId, shape, price: shapePrice(def.basePrice, shape.length), frozen: false };
}

export function reactionName(a: string, b: string) {
  const key = [a, b].sort().join('+');
  return ({
    'fire+water': 'ПАР',
    'fire+frost': 'ТЕРМОУДАР',
    'fire+storm': 'ПЕРЕГРУЗКА',
    'frost+water': 'ЗАМОРОЗКА',
    'storm+water': 'ПРОВОДИМОСТЬ',
    'frost+storm': 'ЛЕДЯНОЙ РАСКОЛ',
  } as Record<string, string>)[key] ?? '';
}
