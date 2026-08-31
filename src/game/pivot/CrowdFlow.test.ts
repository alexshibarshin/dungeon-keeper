import { describe, expect, it } from 'vitest';
import { BOARD_X, BOARD_Y, CELL, ENEMIES } from './config';
import { CrowdFlow } from './CrowdFlow';
import type { EnemyKind, EnemyState } from './types';

function enemyAtCell(x: number, y: number, id: number, kind: EnemyKind = 'grunt'): EnemyState {
  return {
    id, kind, x: BOARD_X + (x + .5) * CELL, y: BOARD_Y + (y + .5) * CELL, vx: 0, vy: 0,
    hp: 100, maxHp: 100, spawnDelay: 0, emerging: false, entrance: 0, gateIndex: 0, laneBias: 0,
    burnDps: 0, burnTime: 0, burnSourceId: null, slow: 0, slowTime: 0, frostSourceId: null,
    vulnerable: 0, vulnerableTime: 0, hardControlLevel: 0, hardControlWindow: 0, hardControlImmune: 0,
    noProgressTime: 0, bestFlowDistance: Infinity, impulseTime: 0, airborneTime: 0, airborneDuration: 0,
    impactDamage: 0, impactRadius: 0, impactSourceId: null, impulseSourceId: null, launched: false, collisionSpent: false, dead: false,
  };
}

const world = { obstacles: [], isTerrainClear: () => true, resolveTerrain: () => undefined };
const descendingField = () => Array.from({ length: 12 }, (_, y) => Array.from({ length: 8 }, (_, x) => y === 5 ? 7 - x : Infinity));

describe('Crowd Flow', () => {
  it('never chooses the previous higher-potential cell after crossing a cell boundary', () => {
    const flow = new CrowdFlow(), field = descendingField();
    const enemy = enemyAtCell(3, 5, 1);
    // Start just inside the new cell, matching the visible regression where
    // the old algorithm immediately reopened current+1 exploration.
    enemy.x = BOARD_X + 3 * CELL + .2;
    const startX = enemy.x;
    for (let tick = 0; tick < 30; tick++) {
      flow.prepare([enemy]);
      flow.move(enemy, .04, field, world);
    }
    expect(enemy.x).toBeGreaterThan(startX + 35);
    expect(enemy.vx).toBeGreaterThan(0);
  });

  it('transfers longitudinal pressure forward instead of pushing the rear drop backwards', () => {
    const flow = new CrowdFlow(), field = descendingField();
    const rear = enemyAtCell(2, 5, 1), front = enemyAtCell(2, 5, 2);
    rear.x -= 4; front.x += 4;
    flow.prepare([rear, front]);
    flow.move(rear, 0, field, world);
    flow.move(front, 0, field, world);
    const rearX = rear.x, frontX = front.x;
    flow.resolvePressure([rear, front], .04, world);
    expect(front.x - frontX).toBeGreaterThan(rearX - rear.x);
    expect(rearX - rear.x).toBeLessThan(.5);
  });

  it('uses mass to make a brute less compliant during lateral pressure', () => {
    const flow = new CrowdFlow(), field = descendingField();
    const grunt = enemyAtCell(3, 5, 1), brute = enemyAtCell(3, 5, 2, 'brute');
    grunt.y -= 3; brute.y += 3;
    flow.prepare([grunt, brute]);
    flow.move(grunt, 0, field, world);
    flow.move(brute, 0, field, world);
    const gruntY = grunt.y, bruteY = brute.y;
    flow.resolvePressure([grunt, brute], .04, world);
    expect(Math.abs(grunt.y - gruntY)).toBeGreaterThan(Math.abs(brute.y - bruteY));
    expect(ENEMIES.brute.mass).toBeGreaterThan(ENEMIES.grunt.mass);
  });
});

