import { BOARD_X, BOARD_Y, CELL, COLS, CONTROL_TUNING, ENEMIES, ROWS } from './config';
import type { EnemyState, Point } from './types';

export interface CrowdObstacle {
  itemId: string;
  x: number;
  y: number;
  radius: number;
}

export interface CrowdFlowWorld {
  obstacles: readonly CrowdObstacle[];
  isTerrainClear: (x: number, y: number, radius: number) => boolean;
  resolveTerrain: (enemy: EnemyState) => void;
}

const dirs: Point[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const normalize = (x: number, y: number, fallback: Point = { x: 1, y: 0 }) => {
  const length = Math.hypot(x, y);
  return length > .0001 ? { x: x / length, y: y / length } : fallback;
};

/**
 * One movement kernel for global progress, local pressure and obstacle flow.
 * Callers own combat state; this module owns every ordinary movement decision.
 */
export class CrowdFlow {
  readonly obstacleAvoidance = new Map<number, { itemId: string; side: -1 | 1 }>();
  private readonly buckets = new Map<string, EnemyState[]>();
  private readonly directions = new Map<number, Point>();

  reset() {
    this.obstacleAvoidance.clear();
    this.buckets.clear();
    this.directions.clear();
  }

  forget(enemyId: number) {
    this.obstacleAvoidance.delete(enemyId);
    this.directions.delete(enemyId);
  }

  prepare(enemies: readonly EnemyState[]) {
    this.buckets.clear();
    for (const enemy of enemies) if (!enemy.dead && enemy.spawnDelay <= 0 && !ENEMIES[enemy.kind].flying) {
      const key = this.bucketKey(enemy.x, enemy.y);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(enemy); else this.buckets.set(key, [enemy]);
    }
  }

  move(enemy: EnemyState, dt: number, field: number[][], world: CrowdFlowWorld) {
    const def = ENEMIES[enemy.kind];
    const recovery = enemy.noProgressTime > CONTROL_TUNING.noProgressTimeout;
    const base = this.preferredDirection(enemy, field);
    const lane = def.flying ? { x: 0, y: 0 } : this.laneDirection(enemy, base, world);
    const pressure = def.flying ? { x: 0, y: 0 } : this.localPressure(enemy, base);
    let desired = normalize(base.x + lane.x + pressure.x, base.y + lane.y + pressure.y, base);

    // Local pressure may spread sideways, but ordinary crowd motion may never
    // reverse the global flow. This is the core progress invariant.
    const forward = desired.x * base.x + desired.y * base.y;
    if (forward < .22) desired = normalize(desired.x + base.x * (.22 - forward), desired.y + base.y * (.22 - forward), base);
    if (!def.flying && !recovery) desired = this.avoidObstacles(enemy, desired, base, field, world);
    else if (recovery) this.obstacleAvoidance.delete(enemy.id);
    this.directions.set(enemy.id, base);

    const slow = enemy.slowTime > 0 ? 1 - enemy.slow : 1;
    const traction = recovery ? 9 : 6;
    const speed = def.speed * slow;
    enemy.vx += (desired.x * speed - enemy.vx) * Math.min(1, dt * traction);
    enemy.vy += (desired.y * speed - enemy.vy) * Math.min(1, dt * traction);
    enemy.x += enemy.vx * dt;
    enemy.y += enemy.vy * dt;
    if (!def.flying) this.resolveObstacleCollision(enemy, world);
    world.resolveTerrain(enemy);
  }

  resolvePressure(enemies: readonly EnemyState[], dt: number, world: CrowdFlowWorld) {
    this.prepare(enemies);
    for (const a of enemies) if (!a.dead && a.spawnDelay <= 0 && !a.emerging && !ENEMIES[a.kind].flying) {
      const bx = Math.floor(a.x / CELL), by = Math.floor(a.y / CELL);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) for (const b of this.buckets.get(`${bx + ox},${by + oy}`) ?? []) {
        if (b.id <= a.id || b.emerging || ENEMIES[b.kind].flying) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const contact = (ENEMIES[a.kind].radius + ENEMIES[b.kind].radius) * .8;
        const distance2 = dx * dx + dy * dy;
        if (distance2 >= contact * contact) continue;
        const distance = Math.sqrt(distance2) || .1;
        const nx = dx / distance, ny = dy / distance;
        const correction = (contact - distance) * Math.min(.42, dt * 8);
        const flow = normalize(
          (this.directions.get(a.id)?.x ?? a.vx) + (this.directions.get(b.id)?.x ?? b.vx),
          (this.directions.get(a.id)?.y ?? a.vy) + (this.directions.get(b.id)?.y ?? b.vy),
        );
        const longitudinal = nx * flow.x + ny * flow.y;
        if (Math.abs(longitudinal) > .55) {
          // A rear drop transfers pressure into the front drop. Only a small
          // compliance correction reaches backwards, preventing traffic jams.
          const front = longitudinal > 0 ? b : a;
          const rear = longitudinal > 0 ? a : b;
          this.crowdMove(front, flow.x * correction * .86, flow.y * correction * .86, world);
          this.crowdMove(rear, -flow.x * correction * .06, -flow.y * correction * .06, world);
        } else {
          const inverseA = 1 / ENEMIES[a.kind].mass, inverseB = 1 / ENEMIES[b.kind].mass;
          const total = inverseA + inverseB;
          this.crowdMove(a, -nx * correction * inverseA / total, -ny * correction * inverseA / total, world);
          this.crowdMove(b, nx * correction * inverseB / total, ny * correction * inverseB / total, world);
        }
      }
    }
  }

  resolveObstacleCollision(enemy: EnemyState, world: CrowdFlowWorld) {
    if (ENEMIES[enemy.kind].flying || (enemy.noProgressTime > CONTROL_TUNING.noProgressTimeout && !enemy.launched)) return;
    for (let pass = 0; pass < 2; pass++) for (const obstacle of world.obstacles) {
      let dx = enemy.x - obstacle.x, dy = enemy.y - obstacle.y, distance = Math.hypot(dx, dy);
      const clearance = obstacle.radius + ENEMIES[enemy.kind].radius;
      if (distance >= clearance) continue;
      if (distance < .001) {
        const velocity = normalize(enemy.vx, enemy.vy);
        const side = this.obstacleAvoidance.get(enemy.id)?.side ?? (enemy.id & 1 ? -1 : 1);
        dx = -velocity.y * side; dy = velocity.x * side; distance = 1;
      }
      const nx = dx / distance, ny = dy / distance, push = clearance - distance + .15;
      enemy.x += nx * push; enemy.y += ny * push;
      const normalSpeed = enemy.vx * nx + enemy.vy * ny;
      if (normalSpeed < 0) { enemy.vx -= normalSpeed * nx; enemy.vy -= normalSpeed * ny; }
    }
  }

  private preferredDirection(enemy: EnemyState, field: number[][]) {
    const cx = clamp(Math.floor((enemy.x - BOARD_X) / CELL), 0, COLS - 1);
    const cy = clamp(Math.floor((enemy.y - BOARD_Y) / CELL), 0, ROWS - 1);
    const current = field[cy]?.[cx] ?? Infinity;
    const options = dirs.map(dir => ({ x: cx + dir.x, y: cy + dir.y, dir }))
      .filter(option => Number.isFinite(field[option.y]?.[option.x]) && field[option.y][option.x] < current);
    if (!options.length) return this.directions.get(enemy.id) ?? normalize(enemy.vx, enemy.vy, { x: 0, y: -1 });

    const chosen = options.map(option => {
      const tx = BOARD_X + (option.x + .5) * CELL, ty = BOARD_Y + (option.y + .5) * CELL;
      const density = this.nearbyCount(tx, ty, enemy.id);
      const lateral = (option.dir.x - option.dir.y) * enemy.laneBias * .18;
      return { option, score: density * .3 - lateral + ((enemy.id + option.x * 7 + option.y * 13) & 7) * .002 };
    }).sort((a, b) => a.score - b.score)[0].option;
    return normalize(
      BOARD_X + (chosen.x + .5) * CELL - enemy.x,
      BOARD_Y + (chosen.y + .5) * CELL - enemy.y,
    );
  }

  private laneDirection(enemy: EnemyState, flow: Point, world: CrowdFlowWorld) {
    if (enemy.noProgressTime > CONTROL_TUNING.noProgressTimeout * .65 || Math.abs(enemy.laneBias) < .05) return { x: 0, y: 0 };
    const radius = ENEMIES[enemy.kind].radius;
    const sideX = -flow.y * Math.sign(enemy.laneBias), sideY = flow.x * Math.sign(enemy.laneBias);
    const desired = Math.abs(enemy.laneBias) * Math.min(20, CELL / 2 - radius - 2);
    for (const factor of [1, .6, .3]) {
      const offset = desired * factor;
      const x = enemy.x + flow.x * CELL * .45 + sideX * offset;
      const y = enemy.y + flow.y * CELL * .45 + sideY * offset;
      if (this.clearOfWorld(x, y, radius, world)) return { x: sideX * factor * .24, y: sideY * factor * .24 };
    }
    return { x: 0, y: 0 };
  }

  private localPressure(enemy: EnemyState, flow: Point) {
    let lateral = 0, forward = 0;
    const sideX = -flow.y, sideY = flow.x;
    const radius = ENEMIES[enemy.kind].radius;
    for (const other of this.neighbors(enemy.x, enemy.y)) {
      if (other.id === enemy.id || ENEMIES[other.kind].flying) continue;
      const dx = enemy.x - other.x, dy = enemy.y - other.y, distance = Math.hypot(dx, dy) || .1;
      const influence = Math.max(54, (radius + ENEMIES[other.kind].radius) * 2.2);
      if (distance >= influence) continue;
      const strength = (influence - distance) / influence;
      const along = (other.x - enemy.x) * flow.x + (other.y - enemy.y) * flow.y;
      lateral += (dx / distance * sideX + dy / distance * sideY) * strength;
      if (along < 0) forward += strength * .14;
    }
    return { x: sideX * clamp(lateral * .34, -.55, .55) + flow.x * Math.min(.28, forward), y: sideY * clamp(lateral * .34, -.55, .55) + flow.y * Math.min(.28, forward) };
  }

  private avoidObstacles(enemy: EnemyState, desired: Point, flow: Point, field: number[][], world: CrowdFlowWorld) {
    let commitment = this.obstacleAvoidance.get(enemy.id);
    let obstacle = commitment ? world.obstacles.find(value => value.itemId === commitment!.itemId) : undefined;
    if (obstacle) {
      const toX = obstacle.x - enemy.x, toY = obstacle.y - enemy.y;
      const clearance = obstacle.radius + ENEMIES[enemy.kind].radius;
      if (toX * flow.x + toY * flow.y < -clearance && Math.hypot(toX, toY) > clearance + 8) {
        this.obstacleAvoidance.delete(enemy.id); commitment = undefined; obstacle = undefined;
      }
    }
    if (!obstacle) {
      obstacle = world.obstacles.map(value => {
        const toX = value.x - enemy.x, toY = value.y - enemy.y;
        const along = desired.x * toX + desired.y * toY;
        const perpendicular = Math.abs(desired.x * toY - desired.y * toX);
        const clearance = value.radius + ENEMIES[enemy.kind].radius;
        return { ...value, along, perpendicular, clearance };
      }).filter(value => value.along > -3 && value.along < value.clearance + 52 && value.perpendicular < value.clearance + 14)
        .sort((a, b) => a.along - b.along)[0];
      if (obstacle) {
        const fallback = ((enemy.id + Math.round((enemy.laneBias + 1) * 7)) & 1) ? -1 : 1;
        commitment = { itemId: obstacle.itemId, side: this.openSide(enemy, obstacle, fallback, field, world) };
        this.obstacleAvoidance.set(enemy.id, commitment);
      }
    }
    if (!obstacle || !commitment) return desired;

    const radial = normalize(enemy.x - obstacle.x, enemy.y - obstacle.y);
    const tangent = { x: -radial.y * commitment.side, y: radial.x * commitment.side };
    const distance = Math.hypot(enemy.x - obstacle.x, enemy.y - obstacle.y);
    const clearance = obstacle.radius + ENEMIES[enemy.kind].radius;
    const weight = clamp((clearance + 48 - distance) / 48, .18, 1);
    return normalize(
      desired.x * (1 - weight * .7) + tangent.x * weight * 1.12 + radial.x * weight * .24,
      desired.y * (1 - weight * .7) + tangent.y * weight * 1.12 + radial.y * weight * .24,
      desired,
    );
  }

  private openSide(enemy: EnemyState, obstacle: CrowdObstacle, fallback: -1 | 1, field: number[][], world: CrowdFlowWorld): -1 | 1 {
    const angle = Math.atan2(enemy.y - obstacle.y, enemy.x - obstacle.x);
    const orbit = obstacle.radius + ENEMIES[enemy.kind].radius + 2;
    const score = (side: -1 | 1) => [.3, .6, .9, 1.2, 1.5].reduce((total, step) => {
      const sampleAngle = angle + side * step;
      const x = obstacle.x + Math.cos(sampleAngle) * orbit, y = obstacle.y + Math.sin(sampleAngle) * orbit;
      if (!this.clearOfWorld(x, y, ENEMIES[enemy.kind].radius, world, obstacle.itemId)) return total - 4;
      const cx = clamp(Math.floor((x - BOARD_X) / CELL), 0, COLS - 1), cy = clamp(Math.floor((y - BOARD_Y) / CELL), 0, ROWS - 1);
      return total + 1 - (field[cy]?.[cx] ?? 1_000) * .015;
    }, 0);
    const opposite = -fallback as -1 | 1;
    return score(opposite) > score(fallback) ? opposite : fallback;
  }

  private clearOfWorld(x: number, y: number, radius: number, world: CrowdFlowWorld, ignoredObstacle?: string) {
    if (!world.isTerrainClear(x, y, radius)) return false;
    return world.obstacles.every(obstacle => obstacle.itemId === ignoredObstacle || Math.hypot(x - obstacle.x, y - obstacle.y) >= radius + obstacle.radius);
  }

  private crowdMove(enemy: EnemyState, dx: number, dy: number, world: CrowdFlowWorld) {
    enemy.x += dx; enemy.y += dy;
    this.resolveObstacleCollision(enemy, world);
    world.resolveTerrain(enemy);
  }

  private nearbyCount(x: number, y: number, ignoredId: number) {
    let count = 0;
    for (const other of this.neighbors(x, y)) if (other.id !== ignoredId && (other.x - x) ** 2 + (other.y - y) ** 2 < 64 ** 2) count++;
    return count;
  }

  private neighbors(x: number, y: number) {
    const result: EnemyState[] = [], bx = Math.floor(x / CELL), by = Math.floor(y / CELL);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) result.push(...(this.buckets.get(`${bx + ox},${by + oy}`) ?? []));
    return result;
  }

  private bucketKey(x: number, y: number) { return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`; }
}
