import {
  cellIndex,
  groundTypes,
  isInside,
  type GroundType,
  type MapDocument,
  type PropType,
} from "./editor-model";

export const NEIGHBOR_MASK = {
  N: 1,
  E: 2,
  S: 4,
  W: 8,
  NE: 16,
  SE: 32,
  SW: 64,
  NW: 128,
} as const;

const ALL_NEIGHBOR_BITS = Object.values(NEIGHBOR_MASK).reduce(
  (bits, bit) => bits | bit,
  0,
);

const DIAGONAL_RULES = [
  { bit: NEIGHBOR_MASK.NE, adjacent: NEIGHBOR_MASK.N | NEIGHBOR_MASK.E },
  { bit: NEIGHBOR_MASK.SE, adjacent: NEIGHBOR_MASK.S | NEIGHBOR_MASK.E },
  { bit: NEIGHBOR_MASK.SW, adjacent: NEIGHBOR_MASK.S | NEIGHBOR_MASK.W },
  { bit: NEIGHBOR_MASK.NW, adjacent: NEIGHBOR_MASK.N | NEIGHBOR_MASK.W },
] as const;

const CARDINAL_DIRECTIONS = [
  { column: 0, row: -1, bit: NEIGHBOR_MASK.N },
  { column: 1, row: 0, bit: NEIGHBOR_MASK.E },
  { column: 0, row: 1, bit: NEIGHBOR_MASK.S },
  { column: -1, row: 0, bit: NEIGHBOR_MASK.W },
] as const;

const DIAGONAL_DIRECTIONS = [
  { column: 1, row: -1, bit: NEIGHBOR_MASK.NE, adjacent: NEIGHBOR_MASK.N | NEIGHBOR_MASK.E },
  { column: 1, row: 1, bit: NEIGHBOR_MASK.SE, adjacent: NEIGHBOR_MASK.S | NEIGHBOR_MASK.E },
  { column: -1, row: 1, bit: NEIGHBOR_MASK.SW, adjacent: NEIGHBOR_MASK.S | NEIGHBOR_MASK.W },
  { column: -1, row: -1, bit: NEIGHBOR_MASK.NW, adjacent: NEIGHBOR_MASK.N | NEIGHBOR_MASK.W },
] as const;

export const GROUND_PRIORITY: Readonly<Record<GroundType, number>> = {
  grass: 0,
  dirt: 1,
  stone: 2,
  water: 3,
};

export interface TransitionLayer {
  ground: GroundType;
  mask: number;
  priority: number;
}

export interface TransitionCorrection {
  ground: GroundType;
  targetColumn: number;
  targetRow: number;
  mask: number;
  priority: number;
}

/**
 * Removes diagonal connections that do not have both touching orthogonal
 * connections. The remaining bitmasks are the 47 valid Blob tile shapes.
 */
export function normalizeBlobMask(mask: number): number {
  let normalized = mask & ALL_NEIGHBOR_BITS;

  for (const { bit, adjacent } of DIAGONAL_RULES) {
    if ((normalized & bit) !== 0 && (normalized & adjacent) !== adjacent) {
      normalized &= ~bit;
    }
  }

  return normalized;
}

function getNeighborGround(
  map: MapDocument,
  column: number,
  row: number,
  currentGround: GroundType,
): GroundType {
  if (!isInside(map, column, row)) return currentGround;
  return map.cells[cellIndex(map, column, row)].ground;
}

/**
 * Returns the valid 8-direction connection mask around a cell.
 * Out-of-bounds neighbors are treated as the current cell's ground.
 */
export function getNeighborMask(
  map: MapDocument,
  column: number,
  row: number,
  ground: GroundType,
): number {
  if (!isInside(map, column, row)) return 0;

  const currentGround = map.cells[cellIndex(map, column, row)].ground;
  const directions = [
    ...CARDINAL_DIRECTIONS,
    { column: 1, row: -1, bit: NEIGHBOR_MASK.NE },
    { column: 1, row: 1, bit: NEIGHBOR_MASK.SE },
    { column: -1, row: 1, bit: NEIGHBOR_MASK.SW },
    { column: -1, row: -1, bit: NEIGHBOR_MASK.NW },
  ];

  const mask = directions.reduce((result, direction) => {
    const neighborGround = getNeighborGround(
      map,
      column + direction.column,
      row + direction.row,
      currentGround,
    );
    return neighborGround === ground ? result | direction.bit : result;
  }, 0);

  return normalizeBlobMask(mask);
}

function getCardinalNeighborMask(
  map: MapDocument,
  column: number,
  row: number,
  ground: GroundType,
  excludedProp?: PropType,
): number {
  if (!isInside(map, column, row)) return 0;

  const currentGround = map.cells[cellIndex(map, column, row)].ground;
  return CARDINAL_DIRECTIONS.reduce((result, direction) => {
    const neighborGround = getNeighborGround(
      map,
      column + direction.column,
      row + direction.row,
      currentGround,
    );
    if (neighborGround !== ground || !isInside(map, column + direction.column, row + direction.row)) return result;
    const neighbor = map.cells[cellIndex(map, column + direction.column, row + direction.row)];
    return neighbor.prop === excludedProp ? result : result | direction.bit;
  }, 0);
}

function getOppositeNeighborBit(bit: number): number {
  if (bit === NEIGHBOR_MASK.N) return NEIGHBOR_MASK.S;
  if (bit === NEIGHBOR_MASK.E) return NEIGHBOR_MASK.W;
  if (bit === NEIGHBOR_MASK.S) return NEIGHBOR_MASK.N;
  if (bit === NEIGHBOR_MASK.W) return NEIGHBOR_MASK.E;
  if (bit === NEIGHBOR_MASK.NE) return NEIGHBOR_MASK.SW;
  if (bit === NEIGHBOR_MASK.SE) return NEIGHBOR_MASK.NW;
  if (bit === NEIGHBOR_MASK.SW) return NEIGHBOR_MASK.NE;
  return NEIGHBOR_MASK.SE;
}

/**
 * Returns correction strips for the higher-priority neighboring tile.
 * The source tile remains visually whole; its edge is painted onto the
 * neighboring tile instead of cutting into the source tile.
 */
export function getTransitionCorrections(
  map: MapDocument,
  column: number,
  row: number,
): TransitionCorrection[] {
  if (!isInside(map, column, row)) return [];

  const sourceCell = map.cells[cellIndex(map, column, row)];
  if (sourceCell.prop === "footbridge") return [];
  const sourceGround = sourceCell.ground;
  const sourcePriority = GROUND_PRIORITY[sourceGround];
  if (sourceGround === "water") return [];

  const corrections: Array<TransitionCorrection | null> = CARDINAL_DIRECTIONS
    .map((direction) => {
      const targetColumn = column + direction.column;
      const targetRow = row + direction.row;
      if (!isInside(map, targetColumn, targetRow)) return null;
      const targetCell = map.cells[cellIndex(map, targetColumn, targetRow)];
      if (targetCell.prop === "footbridge") return null;
      const targetGround = targetCell.ground;
      if (
        targetGround === "water" ||
        GROUND_PRIORITY[targetGround] <= sourcePriority ||
        (sourceGround === "grass" && targetGround === "dirt")
      ) return null;
      return {
        ground: sourceGround,
        targetColumn,
        targetRow,
        mask: getOppositeNeighborBit(direction.bit),
        priority: GROUND_PRIORITY[targetGround],
      };
    });
  const cornerCorrections: Array<TransitionCorrection | null> = DIAGONAL_DIRECTIONS
    .map((direction) => {
      const targetColumn = column + direction.column;
      const targetRow = row + direction.row;
      if (!isInside(map, targetColumn, targetRow)) return null;
      const targetCell = map.cells[cellIndex(map, targetColumn, targetRow)];
      if (targetCell.prop === "footbridge") return null;
      const targetGround = targetCell.ground;
      if (
        targetGround === "water" ||
        GROUND_PRIORITY[targetGround] <= sourcePriority ||
        (sourceGround === "grass" && targetGround === "dirt")
      ) return null;
      const adjacentGrounds = [
        map.cells[cellIndex(map, column + direction.column, row)].ground,
        map.cells[cellIndex(map, column, row + direction.row)].ground,
      ];
      if (adjacentGrounds.some((ground) => ground !== targetGround)) return null;
      return {
        ground: sourceGround,
        targetColumn,
        targetRow,
        mask: getOppositeNeighborBit(direction.bit),
        priority: GROUND_PRIORITY[targetGround],
      };
    });
  return [...corrections, ...cornerCorrections]
    .filter((correction): correction is TransitionCorrection => correction !== null);
}

/**
 * Returns the valid 8-direction connection mask around a prop cell.
 * Diagonal connections follow the same rule as ground blob tiles: both
 * touching cardinal neighbors must also be connected.
 */
export function getPropNeighborMask(
  map: MapDocument,
  column: number,
  row: number,
  prop: PropType,
): number {
  if (!isInside(map, column, row)) return 0;
  if (map.cells[cellIndex(map, column, row)].prop !== prop) return 0;

  const directions = [
    { column: 0, row: -1, bit: NEIGHBOR_MASK.N },
    { column: 1, row: 0, bit: NEIGHBOR_MASK.E },
    { column: 0, row: 1, bit: NEIGHBOR_MASK.S },
    { column: -1, row: 0, bit: NEIGHBOR_MASK.W },
    { column: 1, row: -1, bit: NEIGHBOR_MASK.NE },
    { column: 1, row: 1, bit: NEIGHBOR_MASK.SE },
    { column: -1, row: 1, bit: NEIGHBOR_MASK.SW },
    { column: -1, row: -1, bit: NEIGHBOR_MASK.NW },
  ];

  const mask = directions.reduce((result, direction) => {
    if (!isInside(map, column + direction.column, row + direction.row)) return result;
    return map.cells[cellIndex(map, column + direction.column, row + direction.row)].prop === prop
      ? result | direction.bit
      : result;
  }, 0);

  return normalizeBlobMask(mask);
}

/**
 * Returns only the cardinal water-facing edges for a non-water cell.
 *
 * Water is rendered as a directional correction piece, not as a normal
 * ground transition. Keeping this mask cardinal also prevents a diagonal
 * water tile from creating a side/correction piece on its own.
 */
export function getWaterBankMask(
  map: MapDocument,
  column: number,
  row: number,
): number {
  if (!isInside(map, column, row)) return 0;
  const currentCell = map.cells[cellIndex(map, column, row)];
  if (currentCell.ground === "water" || currentCell.prop === "footbridge") return 0;
  return getCardinalNeighborMask(map, column, row, "water", "footbridge");
}

/** Returns diagonal water corners only when both touching cardinal cells are water. */
export function getWaterBankCornerMask(
  map: MapDocument,
  column: number,
  row: number,
): number {
  if (!isInside(map, column, row)) return 0;
  const currentCell = map.cells[cellIndex(map, column, row)];
  if (currentCell.ground === "water" || currentCell.prop === "footbridge") return 0;
  return DIAGONAL_DIRECTIONS.reduce((result, direction) => {
    const targetColumn = column + direction.column;
    const targetRow = row + direction.row;
    if (!isInside(map, targetColumn, targetRow)) return result;
    const targetCell = map.cells[cellIndex(map, targetColumn, targetRow)];
    if (targetCell.ground !== "water" || targetCell.prop === "footbridge") return result;
    const adjacentCells = [
      map.cells[cellIndex(map, column + direction.column, row)],
      map.cells[cellIndex(map, column, row + direction.row)],
    ];
    return adjacentCells.every((cell) => cell.ground === "water" && cell.prop !== "footbridge")
      ? result | direction.bit
      : result;
  }, 0);
}

/** Returns each water cell's cardinal distance from a land or map boundary. */
export function getWaterDepths(map: MapDocument): number[] {
  const depths = new Array<number>(map.cells.length).fill(-1);
  const queue: number[] = [];
  for (let row = 0; row < map.rows; row += 1) for (let column = 0; column < map.columns; column += 1) {
    if (map.cells[cellIndex(map, column, row)].ground !== "water") continue;
    const isSurface = CARDINAL_DIRECTIONS.some((direction) => {
      const targetColumn = column + direction.column;
      const targetRow = row + direction.row;
      return !isInside(map, targetColumn, targetRow)
        || map.cells[cellIndex(map, targetColumn, targetRow)].ground !== "water";
    });
    if (!isSurface) continue;
    const index = cellIndex(map, column, row);
    depths[index] = 0;
    queue.push(index);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const column = index % map.columns;
    const row = Math.floor(index / map.columns);
    for (const direction of CARDINAL_DIRECTIONS) {
      const targetColumn = column + direction.column;
      const targetRow = row + direction.row;
      if (!isInside(map, targetColumn, targetRow)) continue;
      const targetIndex = cellIndex(map, targetColumn, targetRow);
      if (map.cells[targetIndex].ground !== "water" || depths[targetIndex] >= 0) continue;
      depths[targetIndex] = depths[index] + 1;
      queue.push(targetIndex);
    }
  }
  return depths;
}

export type BridgeConnectionShape =
  | "isolated"
  | "horizontal"
  | "vertical"
  | "corner-ne"
  | "corner-se"
  | "corner-sw"
  | "corner-nw"
  | "junction"
  | "full";

export type BridgeDirection = "N" | "E" | "S" | "W";

export const BRIDGE_CARDINAL_MASK =
  NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.S | NEIGHBOR_MASK.W;

const BRIDGE_DIRECTIONS: ReadonlyArray<readonly [BridgeDirection, number]> = [
  ["N", NEIGHBOR_MASK.N],
  ["E", NEIGHBOR_MASK.E],
  ["S", NEIGHBOR_MASK.S],
  ["W", NEIGHBOR_MASK.W],
];

/**
 * Classifies the primary bridge direction while preserving the full mask
 * for rendering diagonal fills and junctions.
 */
export function getBridgeConnectionShape(mask: number): BridgeConnectionShape {
  const normalized = normalizeBlobMask(mask);
  if (normalized === 0) return "isolated";
  if (normalized === 255) return "full";

  const cardinalMask = normalized & BRIDGE_CARDINAL_MASK;
  if (cardinalMask === (NEIGHBOR_MASK.E | NEIGHBOR_MASK.W)) return "horizontal";
  if (cardinalMask === (NEIGHBOR_MASK.N | NEIGHBOR_MASK.S)) return "vertical";
  if (cardinalMask === (NEIGHBOR_MASK.N | NEIGHBOR_MASK.E)) return "corner-ne";
  if (cardinalMask === (NEIGHBOR_MASK.E | NEIGHBOR_MASK.S)) return "corner-se";
  if (cardinalMask === (NEIGHBOR_MASK.S | NEIGHBOR_MASK.W)) return "corner-sw";
  if (cardinalMask === (NEIGHBOR_MASK.W | NEIGHBOR_MASK.N)) return "corner-nw";
  if (cardinalMask === NEIGHBOR_MASK.N || cardinalMask === NEIGHBOR_MASK.S) return "vertical";
  if (cardinalMask === NEIGHBOR_MASK.E || cardinalMask === NEIGHBOR_MASK.W) return "horizontal";
  return "junction";
}

/** Returns the cardinal bridge arms that should be rendered for a connection mask. */
export function getBridgeConnectionDirections(mask: number): BridgeDirection[] {
  const normalized = normalizeBlobMask(mask);
  return BRIDGE_DIRECTIONS
    .filter(([, bit]) => (normalized & bit) !== 0)
    .map(([direction]) => direction);
}

/** Returns the cardinal directions that need a procedural landing/end-cap. */
export function getBridgeEndpointMask(mask: number): number {
  const cardinalMask = normalizeBlobMask(mask) & BRIDGE_CARDINAL_MASK;
  if (cardinalMask === 0) return BRIDGE_CARDINAL_MASK;

  const horizontalMask = NEIGHBOR_MASK.E | NEIGHBOR_MASK.W;
  const verticalMask = NEIGHBOR_MASK.N | NEIGHBOR_MASK.S;
  if (cardinalMask === horizontalMask) return 0;
  if (cardinalMask === verticalMask) return 0;
  if (cardinalMask === NEIGHBOR_MASK.E || cardinalMask === NEIGHBOR_MASK.W) {
    return horizontalMask & ~cardinalMask;
  }
  if (cardinalMask === NEIGHBOR_MASK.N || cardinalMask === NEIGHBOR_MASK.S) {
    return verticalMask & ~cardinalMask;
  }
  return BRIDGE_CARDINAL_MASK & ~cardinalMask;
}

/** The source bridge image is naturally oriented along the vertical axis. */
export function getBridgeTextureRotation(shape: BridgeConnectionShape): 0 | 90 {
  return shape === "horizontal" ? 90 : 0;
}

/**
 * Calculates the higher-priority neighboring ground layers for a cell.
 * Layers are returned from lowest to highest priority so later layers can
 * deterministically cover earlier ones when rendered.
 */
export function getTransitionLayers(
  map: MapDocument,
  column: number,
  row: number,
): TransitionLayer[] {
  if (!isInside(map, column, row)) return [];

  const currentCell = map.cells[cellIndex(map, column, row)];
  if (currentCell.prop === "footbridge") return [];
  const currentGround = currentCell.ground;
  const currentPriority = GROUND_PRIORITY[currentGround];
  const layers = groundTypes
    // Water has its own directional bank/correction pass. Returning it here
    // would paint water over the current ground before the thinner bank face,
    // leaving a visible strip between the side piece and the land tile.
    .filter((ground) => (
      ground !== "water" &&
      !(currentGround === "grass" && ground === "dirt") &&
      GROUND_PRIORITY[ground] > currentPriority
    ))
    .map((ground) => ({
      ground,
      mask: getNeighborMask(map, column, row, ground),
      priority: GROUND_PRIORITY[ground],
    }))
    .filter((layer) => layer.mask !== 0);

  return layers.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return groundTypes.indexOf(left.ground) - groundTypes.indexOf(right.ground);
  });
}
