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

/** Returns the water edge mask for a non-water cell so its raised bank can be rendered. */
export function getWaterBankMask(
  map: MapDocument,
  column: number,
  row: number,
): number {
  if (!isInside(map, column, row)) return 0;
  if (map.cells[cellIndex(map, column, row)].ground === "water") return 0;
  return getNeighborMask(map, column, row, "water");
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

/**
 * Classifies the primary bridge direction while preserving the full mask
 * for rendering diagonal fills and junctions.
 */
export function getBridgeConnectionShape(mask: number): BridgeConnectionShape {
  const normalized = normalizeBlobMask(mask);
  if (normalized === 0) return "isolated";
  if (normalized === 255) return "full";

  const cardinalMask = normalized & (
    NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.S | NEIGHBOR_MASK.W
  );
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
    .filter((ground) => GROUND_PRIORITY[ground] > currentPriority)
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
