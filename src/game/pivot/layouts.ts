import type { Point } from './types';

export interface AuthoredPortal {
  /** Where the warning arrow lives and the enemy first appears. May be outside the 8×12 board. */
  spawn: Point;
  /** The adjacent revealed floor cell through which enemies enter the dungeon. */
  entrance: Point;
}

export interface AuthoredLayout {
  id: string;
  /**
   * 8×12 authoring grid. Digits are floor reveal zones (1 is the opening,
   * 2–5 are the four Expands), # is rock, and H is the 2×2 Heart.
   */
  zones: readonly string[];
  /** Portal set for the opening and for each of the four Expand states. */
  portals: readonly (readonly AuthoredPortal[])[];
}

const portal = (spawn: [number, number], entrance: [number, number]): AuthoredPortal => ({
  spawn: { x: spawn[0], y: spawn[1] },
  entrance: { x: entrance[0], y: entrance[1] },
});

export const AUTHORED_LAYOUTS: readonly AuthoredLayout[] = [
  {
    id: 'split-crown',
    zones: [
      '##555###',
      '#55#5#33',
      '444#433#',
      '##4443##',
      '#244#33#',
      '22###222',
      '222###22',
      '#111#11#',
      '##11111#',
      '##111#1#',
      '###HH11#',
      '###HH###',
    ],
    portals: [
      [portal([1, 6], [1, 7]), portal([6, 6], [6, 7])],
      [portal([1, 3], [1, 4]), portal([7, 4], [7, 5])],
      [portal([1, 3], [1, 4]), portal([8, 1], [7, 1])],
      [portal([-1, 2], [0, 2]), portal([4, 1], [4, 2])],
      [portal([-1, 2], [0, 2]), portal([2, -1], [2, 0]), portal([8, 1], [7, 1])],
    ],
  },
  {
    id: 'four-horns',
    zones: [
      '##5##55#',
      '5#5#4444',
      '554#333#',
      '##443#3#',
      '#444333#',
      '#13##2##',
      '11#1222#',
      '11#11#22',
      '111#1#22',
      '1#111122',
      '1HH111##',
      '#HH1####',
    ],
    portals: [
      [portal([1, 4], [1, 5]), portal([3, 5], [3, 6])],
      [portal([1, 4], [1, 5]), portal([5, 4], [5, 5])],
      [portal([1, 4], [1, 5]), portal([4, 1], [4, 2])],
      [portal([2, 1], [2, 2]), portal([5, 0], [5, 1])],
      [portal([-1, 1], [0, 1]), portal([2, -1], [2, 0]), portal([5, -1], [5, 0]), portal([8, 1], [7, 1])],
    ],
  },
] as const;
