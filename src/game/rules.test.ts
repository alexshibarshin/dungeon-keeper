import { describe, expect, it } from 'vitest';
import { BOUNTY_COIN_FACTOR, DEFAULT_DECK, ENEMIES, GUARANTEED_OFFER_MAX_PRICE, HEART_SHOT_COOLDOWN, HEART_SHOT_DAMAGE, PERKS, shapePrice, STARTING_COINS, terrainEditPrice, TRAPS, TRAP_TARGET_CAPS, trapUpgradePrice } from './config';
import { activeEntranceCount, allEntrancesConnected, buildFlowField, enemyHpScale, generateStage, mulberry32, offerFor, openFacesFor, reactionName, waveClearReward, wavePreview } from './rules';

describe('prototype rules', () => {
  it('generates deterministic valid stages', () => {
    const a = generateStage(428713);
    const b = generateStage(428713);
    expect(a.grid).toEqual(b.grid);
    expect(allEntrancesConnected(a.grid, a)).toBe(true);
  });

  it('keeps every potential entrance connected across many seeds', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const stage = generateStage(seed * 7919);
      expect(allEntrancesConnected(stage.grid, stage), `seed ${stage.seed}`).toBe(true);
    }
  });

  it('produces five distinct archetypes with required placement space', () => {
    const archetypes = new Map<string, Set<string>>();
    for (let seed = 1; seed <= 400; seed++) {
      const stage = generateStage(seed * 3571);
      const signature = stage.grid.map(row => row.join(',')).join('|');
      const signatures = archetypes.get(stage.archetype) ?? new Set<string>(); signatures.add(signature); archetypes.set(stage.archetype, signatures);
      const floor = (x: number, y: number) => stage.grid[y]?.[x] === 'floor';
      let square = false, elbow = false;
      for (let y = 0; y < stage.grid.length - 1; y++) for (let x = 0; x < stage.grid[y].length - 1; x++) {
        square ||= floor(x, y) && floor(x + 1, y) && floor(x, y + 1) && floor(x + 1, y + 1);
        elbow ||= floor(x, y) && floor(x + 1, y) && floor(x, y + 1);
      }
      expect(square, `2x2 seed ${stage.seed}`).toBe(true);
      expect(elbow, `L seed ${stage.seed}`).toBe(true);
      if (stage.archetype === 'Осада со всех сторон') expect(stage.entrances.length).toBe(4);
    }
    expect(archetypes.size).toBe(5);
    for (const variants of archetypes.values()) expect(variants.size).toBeGreaterThan(1);
  });

  it('prices large figures with bulk discount', () => {
    expect(shapePrice(10, 1)).toBe(10);
    expect(shapePrice(10, 4)).toBe(25);
    expect(shapePrice(10, 4) / 4).toBeLessThan(shapePrice(10, 1));
  });

  it('offers only deck traps and respects max footprint', () => {
    const rand = mulberry32(77);
    for (let i = 0; i < 100; i++) {
      const offer = offerFor(rand, DEFAULT_DECK, i);
      expect(DEFAULT_DECK).toContain(offer.trapId);
      expect(offer.shape.length).toBeLessThanOrEqual(TRAPS[offer.trapId].maxSize);
    }
  });

  it('defines all six symmetric elemental reactions', () => {
    const elements = ['fire', 'water', 'frost', 'storm'];
    const names = new Set<string>();
    for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
      const a = reactionName(elements[i], elements[j]);
      expect(a).toBe(reactionName(elements[j], elements[i]));
      names.add(a);
    }
    expect(names.size).toBe(6);
    expect(names).not.toContain('');
  });

  it('lets wall traps act only through open orthogonal faces', () => {
    const grid = [
      ['rock', 'floor', 'rock'],
      ['floor', 'eternal', 'heart'],
      ['rock', 'built', 'rock'],
    ] as const;
    expect(openFacesFor(grid.map(row => [...row]), 1, 1)).toEqual([
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 },
    ]);
  });

  it('defines four complete prerequisite perk chains', () => {
    const branches = new Map<string, typeof PERKS>();
    for (const perk of PERKS) branches.set(perk.branch, [...(branches.get(perk.branch) ?? []), perk]);
    expect(branches.size).toBe(4);
    for (const perks of branches.values()) {
      expect(perks.map(p => p.tier).sort()).toEqual([1, 2, 3, 4]);
      for (const perk of perks.filter(p => (p.tier ?? 0) > 1)) expect(perks.some(p => p.id === perk.prerequisite && p.tier === (perk.tier ?? 0) - 1)).toBe(true);
    }
  });

  it('defines ten tunable traps split evenly between floor and wall', () => {
    const traps = Object.values(TRAPS);
    expect(traps).toHaveLength(10);
    expect(traps.filter(t => t.placement === 'floor')).toHaveLength(5);
    expect(traps.filter(t => t.placement === 'wall')).toHaveLength(5);
    for (const trap of traps) {
      expect(trap.damage).toBeGreaterThan(0);
      expect(trap.cooldown).toBeGreaterThan(0);
      expect(trap.maxSize).toBeGreaterThanOrEqual(1);
      expect(trap.maxSize).toBeLessThanOrEqual(trap.placement === 'floor' ? 4 : 2);
    }
  });

  it('keeps the ten-wave threat curve monotonic with a trash majority', () => {
    const archetypes = ['Зелёная волна', 'Скользкий обрыв', 'Железное шествие', 'Воздушная пещера', 'Осада со всех сторон'];
    for (const archetype of archetypes) {
      let previous = 0;
      for (let wave = 1; wave <= 10; wave++) {
        const preview = wavePreview(wave, archetype);
        const total = Object.values(preview).reduce((sum, count) => sum + count, 0);
        expect(total).toBeGreaterThan(previous);
        expect(preview.delver / total).toBeGreaterThanOrEqual(.75);
        previous = total;
      }
    }
    expect(Object.values(wavePreview(1, archetypes[0])).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20);
    expect(Object.values(wavePreview(10, archetypes[0])).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(100);
  });

  it('ramps enemy durability late without spiking the opening', () => {
    expect(enemyHpScale(1)).toBe(1);
    expect(enemyHpScale(5)).toBeLessThan(1.75);
    expect(enemyHpScale(10)).toBeGreaterThan(3);
    for (let wave = 2; wave <= 10; wave++) expect(enemyHpScale(wave)).toBeGreaterThan(enemyHpScale(wave - 1));
  });

  it('does not create unreachable passable floor pockets', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const stage = generateStage(seed * 104729), field = buildFlowField(stage.grid, stage.heart);
      for (let y = 0; y < stage.grid.length; y++) for (let x = 0; x < stage.grid[y].length; x++) {
        if (stage.grid[y][x] === 'floor' || stage.grid[y][x] === 'heart') expect(Number.isFinite(field[y][x]), `seed ${stage.seed} cell ${x},${y}`).toBe(true);
      }
    }
  });

  it('keeps caves spatially tight instead of generating empty rooms', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const stage = generateStage(seed * 65537);
      const floorCount = stage.grid.flat().filter(cell => cell === 'floor' || cell === 'heart').length;
      expect(floorCount / (stage.grid.length * stage.grid[0].length), `floor ratio seed ${stage.seed}`).toBeLessThanOrEqual(.48);
      let openFourByFour = false;
      for (let y = 0; y <= stage.grid.length - 4; y++) for (let x = 0; x <= stage.grid[0].length - 4; x++) {
        openFourByFour ||= Array.from({ length: 4 }, (_, oy) => Array.from({ length: 4 }, (__, ox) => stage.grid[y + oy][x + ox])).flat().every(cell => cell === 'floor');
      }
      expect(openFourByFour, `empty 4x4 room seed ${stage.seed}`).toBe(false);
    }
  });

  it('gives every entrance a meaningfully long route before it reaches the heart', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const stage = generateStage(seed * 8191), field = buildFlowField(stage.grid, stage.heart);
      for (const entrance of stage.entrances) {
        expect(field[entrance.y][entrance.x], `short route seed ${stage.seed} at ${entrance.x},${entrance.y}`).toBeGreaterThanOrEqual(7);
      }
      let point = stage.entrances[0], previousDirection = '', turns = 0;
      while (field[point.y][point.x] > 0) {
        const next = [{ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 }]
          .filter(p => field[p.y]?.[p.x] === field[point.y][point.x] - 1)[0];
        expect(next, `broken trace seed ${stage.seed}`).toBeTruthy();
        const direction = `${next.x - point.x},${next.y - point.y}`;
        if (previousDirection && direction !== previousDirection) turns++;
        previousDirection = direction; point = next;
      }
      expect(turns, `straight primary route seed ${stage.seed}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses archetype-specific but restrained terrain hazards', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const stage = generateStage(seed * 131071);
      const pits = stage.grid.flat().filter(cell => cell === 'pit').length;
      const eternal = stage.grid.flat().filter(cell => cell === 'eternal').length;
      expect(pits).toBeGreaterThanOrEqual(stage.archetype === 'Скользкий обрыв' ? 4 : 1);
      expect(pits).toBeLessThanOrEqual(stage.archetype === 'Скользкий обрыв' ? 5 : 3);
      expect(eternal).toBeGreaterThanOrEqual(stage.archetype === 'Железное шествие' ? 4 : 2);
      expect(eternal).toBeLessThanOrEqual(5);
    }
  });

  it('introduces new entrances gradually and never rotates old defenses away', () => {
    for (const total of [3, 4]) {
      const sequence = Array.from({ length: 10 }, (_, wave) => activeEntranceCount(wave + 1, total));
      expect(sequence[0]).toBe(1);
      expect(sequence[6]).toBe(total);
      for (let i = 1; i < sequence.length; i++) {
        expect(sequence[i]).toBeGreaterThanOrEqual(sequence[i - 1]);
        expect(sequence[i] - sequence[i - 1]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('makes expansion more efficient than upgrading when space is available', () => {
    for (const price of [10, 18, 25, 40]) {
      const newTrapEfficiency = 1 / price;
      const levelTwoEfficiency = .5 / trapUpgradePrice(price, 1);
      const levelThreeEfficiency = .5 / trapUpgradePrice(price, 2);
      expect(levelTwoEfficiency).toBeLessThan(newTrapEfficiency);
      expect(levelThreeEfficiency).toBeLessThan(levelTwoEfficiency);
    }
    expect(terrainEditPrice('dig', 0)).toBe(2);
    expect(terrainEditPrice('dig', 0) + terrainEditPrice('dig', 1)).toBeLessThan(Math.min(...Object.values(TRAPS).map(trap => trap.basePrice)));
    expect([0, 1, 2, 3].map(i => terrainEditPrice('dig', i))).toEqual([2, 2, 3, 3]);
  });

  it('keeps the full-stage currency budget scarce enough for build choices', () => {
    const clearIncome = Array.from({ length: 9 }, (_, wave) => waveClearReward(wave + 1)).reduce((a, b) => a + b, 0);
    for (const archetype of ['Зелёная волна', 'Скользкий обрыв', 'Железное шествие', 'Воздушная пещера', 'Осада со всех сторон']) {
      let bounty = 0;
      for (let wave = 1; wave <= 10; wave++) for (const [kind, count] of Object.entries(wavePreview(wave, archetype))) bounty += ENEMIES[kind as keyof typeof ENEMIES].reward * count * BOUNTY_COIN_FACTOR;
      const projected = STARTING_COINS + clearIncome + Math.floor(bounty);
      expect(projected).toBeGreaterThanOrEqual(285);
      expect(projected).toBeLessThanOrEqual(330);
    }
  });

  it('guarantees one purchasable shop action after every cleared wave', () => {
    const rand = mulberry32(9031);
    for (let wave = 1; wave < 10; wave++) expect(waveClearReward(wave)).toBeGreaterThanOrEqual(GUARANTEED_OFFER_MAX_PRICE);
    for (let i = 0; i < 200; i++) expect(offerFor(rand, DEFAULT_DECK, i, GUARANTEED_OFFER_MAX_PRICE).price).toBeLessThanOrEqual(GUARANTEED_OFFER_MAX_PRICE);
    expect(waveClearReward(1)).toBe(20);
    expect(waveClearReward(9)).toBe(24);
  });

  it('keeps the unupgraded heart supportive and limits crowd hits per cell', () => {
    const baseTtk = ENEMIES.delver.hp / (HEART_SHOT_DAMAGE / HEART_SHOT_COOLDOWN);
    expect(baseTtk).toBeGreaterThan(7);
    expect(TRAP_TARGET_CAPS.spikes).toBe(3);
    expect(TRAP_TARGET_CAPS.icicle).toBe(2);
    expect(Math.max(...Object.values(TRAP_TARGET_CAPS))).toBeLessThanOrEqual(6);
  });
});
