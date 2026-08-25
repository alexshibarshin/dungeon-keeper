import type { EnemyDef, EnemyKind, PerkDef, Point, TrapDef } from './types';

export const WIDTH = 720;
export const HEIGHT = 1280;
export const CELL = 72;
export const COLS = 8;
export const ROWS = 12;
export const BOARD_X = 72;
export const BOARD_Y = 80;
export const BOARD_W = COLS * CELL;
export const BOARD_H = ROWS * CELL;

export const STARTING_COINS = 52;
export const HEART_SHOT_DAMAGE = 4.5;
export const HEART_SHOT_COOLDOWN = .64;
export const BOUNTY_COIN_FACTOR = .05;
export const GUARANTEED_OFFER_MAX_PRICE = 20;
export const TERRAIN_BASE_COST = { dig: 2, build: 3 } as const;

export function terrainEditPrice(kind: keyof typeof TERRAIN_BASE_COST, actionsThisWave: number) {
  return TERRAIN_BASE_COST[kind] + Math.floor(actionsThisWave / 2);
}

export function trapUpgradePrice(pricePaid: number, currentLevel: number) {
  return Math.round(pricePaid * (currentLevel === 1 ? .85 : 1.15));
}

export const ELEMENT_COLORS = {
  fire: 0xff6638,
  water: 0x20d7d2,
  frost: 0xcaf6ff,
  storm: 0x9b5cff,
} as const;

export const TRAPS: Record<string, TrapDef> = {
  ember: { id: 'ember', name: 'Тлеющие плиты', short: 'Жгут толпу', placement: 'floor', element: 'fire', color: 0x7d281f, accent: 0xff6a33, basePrice: 10, maxSize: 4, damage: 14, cooldown: .72, radius: 29, icon: '♨' },
  flame: { id: 'flame', name: 'Огненный вентиль', short: 'Конус пламени', placement: 'wall', element: 'fire', color: 0x51251f, accent: 0xff8a32, basePrice: 13, maxSize: 2, damage: 25, cooldown: 1.15, radius: 82, icon: '◖' },
  frost: { id: 'frost', name: 'Морозная печать', short: 'Урон и холод', placement: 'floor', element: 'frost', color: 0x24516a, accent: 0xc8f7ff, basePrice: 11, maxSize: 4, damage: 11, cooldown: .62, radius: 30, icon: '✦' },
  icicle: { id: 'icicle', name: 'Сосулькомёт', short: 'Ледяной выстрел', placement: 'wall', element: 'frost', color: 0x273e5d, accent: 0xbdf5ff, basePrice: 14, maxSize: 2, damage: 31, cooldown: 1.35, radius: 125, icon: '◆' },
  geyser: { id: 'geyser', name: 'Гейзерные плиты', short: 'Вода и импульс', placement: 'floor', element: 'water', color: 0x175568, accent: 0x29e1db, basePrice: 12, maxSize: 3, damage: 10, cooldown: 1.1, radius: 35, impulse: 72, icon: '≈' },
  jet: { id: 'jet', name: 'Водомёт', short: 'Мощный толчок', placement: 'wall', element: 'water', color: 0x16485c, accent: 0x22dfd5, basePrice: 15, maxSize: 2, damage: 19, cooldown: 1.25, radius: 96, impulse: 145, icon: '➤' },
  mine: { id: 'mine', name: 'Грозовая мина', short: 'Разряд по площади', placement: 'floor', element: 'storm', color: 0x3f275e, accent: 0xaa63ff, basePrice: 14, maxSize: 3, damage: 22, cooldown: 1.8, radius: 52, icon: 'ϟ' },
  tesla: { id: 'tesla', name: 'Катушка Теслы', short: 'Цепной разряд', placement: 'wall', element: 'storm', color: 0x38235d, accent: 0xb465ff, basePrice: 16, maxSize: 2, damage: 24, cooldown: 1.05, radius: 112, icon: 'ϟ' },
  spikes: { id: 'spikes', name: 'Шипы', short: 'Сильный удар', placement: 'floor', element: null, color: 0x493e43, accent: 0xe7d6bd, basePrice: 9, maxSize: 4, damage: 34, cooldown: 1.6, radius: 29, icon: '▲' },
  piston: { id: 'piston', name: 'Поршень', short: 'Удар и толчок', placement: 'wall', element: null, color: 0x4b3e39, accent: 0xe0b35e, basePrice: 13, maxSize: 2, damage: 22, cooldown: 1.35, radius: 78, impulse: 185, icon: '▰' },
};

export const DEFAULT_DECK = ['ember', 'frost', 'geyser', 'mine', 'piston'];

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  delver: { name: 'Искатель', hp: 50, speed: 40, radius: 10, mass: 1, baseDamage: 4, color: 0xe8d9b0, accent: 0xaec5dc, reward: 1 },
  runner: { name: 'Бегун', hp: 34, speed: 63, radius: 8, mass: .7, baseDamage: 3, color: 0xf5e6b6, accent: 0xe76d55, reward: 1 },
  brute: { name: 'Тяжеловес', hp: 310, speed: 28, radius: 18, mass: 4.5, baseDamage: 18, color: 0x938ba1, accent: 0xc6b06b, reward: 6 },
  shield: { name: 'Щитоносец', hp: 175, speed: 34, radius: 13, mass: 2.3, baseDamage: 12, color: 0xcabf9d, accent: 0x4e79a7, reward: 4 },
  wing: { name: 'Крылан', hp: 86, speed: 53, radius: 11, mass: .8, baseDamage: 8, color: 0xe7d7bf, accent: 0xb45b8f, reward: 3, flying: true },
};

export const TRAP_TARGET_CAPS: Record<string, number> = {
  ember: 3, frost: 3, geyser: 3, mine: 5, spikes: 3,
  flame: 6, icicle: 2, jet: 2, tesla: 4, piston: 1,
};

export const SHAPES: Point[][] = [
  [{ x: 0, y: 0 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
  [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }],
];

export const PERKS: PerkDef[] = [
  { id: 'arrows', name: 'Усиленные стрелы', branch: 'Гарнизон', text: '+35% урона каждого стрелка', color: '#e7b85b', tier: 1 },
  { id: 'pierce', name: 'Пробивающие стрелы', branch: 'Гарнизон', text: 'Стрелы задевают вторую цель', color: '#e7b85b', prerequisite: 'arrows', tier: 2 },
  { id: 'volley', name: 'Двойной залп', branch: 'Гарнизон', text: 'Каждый четвёртый залп — двойной', color: '#e7b85b', prerequisite: 'pierce', tier: 3 },
  { id: 'rain', name: 'Ливень стрел', branch: 'Гарнизон', text: 'Редкий залп накрывает всю группу', color: '#e7b85b', prerequisite: 'volley', tier: 4 },
  { id: 'hotter', name: 'Жарче топки', branch: 'Пироманты', text: '+40% урона огненных ловушек', color: '#ff7244', tier: 1 },
  { id: 'burn', name: 'Долгое горение', branch: 'Пироманты', text: 'Горение дольше и сильнее', color: '#ff7244', prerequisite: 'hotter', tier: 2 },
  { id: 'fireSpotters', name: 'Огненные наводчики', branch: 'Пироманты', text: 'Стрелки добивают горящие цели', color: '#ff7244', prerequisite: 'burn', tier: 3 },
  { id: 'blaze', name: 'Пылающий финал', branch: 'Пироманты', text: 'Горящие враги взрываются при смерти', color: '#ff7244', prerequisite: 'fireSpotters', tier: 4 },
  { id: 'floor', name: 'Усиленные механизмы', branch: 'Инженеры пола', text: '+35% урона напольных ловушек', color: '#45d6bb', tier: 1 },
  { id: 'reset', name: 'Быстрый сброс', branch: 'Инженеры пола', text: '-25% перезарядки плит', color: '#45d6bb', prerequisite: 'floor', tier: 2 },
  { id: 'positions', name: 'Ловушечные позиции', branch: 'Инженеры пола', text: 'Каждая плита усиливает стрелков', color: '#45d6bb', prerequisite: 'reset', tier: 3 },
  { id: 'marked', name: 'Огонь по разметке', branch: 'Инженеры пола', text: 'Стрелки сильнее бьют врагов на плитах', color: '#45d6bb', prerequisite: 'positions', tier: 4 },
  { id: 'pressure', name: 'Высокое давление', branch: 'Кинетики', text: '+55% импульса и урона толчков', color: '#66b9ff', tier: 1 },
  { id: 'impact', name: 'Удар о стену', branch: 'Кинетики', text: 'Сильные столкновения наносят урон', color: '#66b9ff', prerequisite: 'pressure', tier: 2 },
  { id: 'observers', name: 'Баллистические наблюдатели', branch: 'Кинетики', text: 'Стрелки сильнее бьют мокрых и летящих', color: '#66b9ff', prerequisite: 'impact', tier: 3 },
  { id: 'ram', name: 'Таранный залп', branch: 'Кинетики', text: 'Каждый шестой залп отбрасывает', color: '#66b9ff', prerequisite: 'observers', tier: 4 },
];

export function shapePrice(base: number, cells: number) {
  return Math.round(base * [0, 1, 1.5, 2, 2.5][cells]);
}
