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
    return neighborGround === ground ? result | direction.bit : result;
  }, 0);
}

function getOppositeNeighborBit(bit: number): number {
  if (bit === NEIGHBOR_MASK.N) return NEIGHBOR_MASK.S;
  if (bit === NEIGHBOR_MASK.E) return NEIGHBOR_MASK.W;
  if (bit === NEIGHBOR_MASK.S) return NEIGHBOR_MASK.N;
  return NEIGHBOR_MASK.E;
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

  const sourceGround = map.cells[cellIndex(map, column, row)].ground;
  const sourcePriority = GROUND_PRIORITY[sourceGround];
  if (sourceGround === "water") return [];

  const corrections: Array<TransitionCorrection | null> = CARDINAL_DIRECTIONS
    .map((direction) => {
      const targetColumn = column + direction.column;
      const targetRow = row + direction.row;
      if (!isInside(map, targetColumn, targetRow)) return null;
      const targetGround = map.cells[cellIndex(map, targetColumn, targetRow)].ground;
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
  return corrections.filter((correction): correction is TransitionCorrection => correction !== null);
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
  if (map.cells[cellIndex(map, column, row)].ground === "water") return 0;
  return getCardinalNeighborMask(map, column, row, "water");
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

  const currentGround = map.cells[cellIndex(map, column, row)].ground;
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
