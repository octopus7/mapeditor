export const GRID_COLUMNS = 28;
export const GRID_ROWS = 18;

export const groundTypes = ["grass", "dirt", "stone", "water"] as const;
export type GroundType = (typeof groundTypes)[number];

export const tileElevations = [0, 1, 2] as const;
export type TileElevation = (typeof tileElevations)[number];
export const brightnessCorrections = [0, 1, 2, 3] as const;
export type BrightnessCorrection = (typeof brightnessCorrections)[number];

export const propTypes = [
  "broadleaf-tree",
  "pine-tree",
  "shrub",
  "boulder",
  "fallen-log",
  "footbridge",
] as const;
export type PropType = (typeof propTypes)[number];

export interface MapCell {
  ground: GroundType;
  elevation: TileElevation;
  brightnessCorrection: BrightnessCorrection;
  prop: PropType | null;
}

export const IMAGE_MIN_SCALE = 0.25;
export const IMAGE_MAX_SCALE = 6;

export interface MapImagePlacement {
  imageId: string;
  column: number;
  row: number;
  rotation: number;
  scale: number;
}

export interface MapDocument {
  version: 1;
  name: string;
  columns: number;
  rows: number;
  cells: MapCell[];
  images: MapImagePlacement[];
  updatedAt: string;
}

export function cellIndex(map: MapDocument, column: number, row: number): number {
  return row * map.columns + column;
}

export function isInside(map: MapDocument, column: number, row: number): boolean {
  return column >= 0 && row >= 0 && column < map.columns && row < map.rows;
}

export function cloneMap(map: MapDocument): MapDocument {
  return {
    ...map,
    cells: map.cells.map((cell) => ({ ...cell })),
    images: map.images.map((image) => ({ ...image })),
  };
}

export function paintGround(
  map: MapDocument,
  column: number,
  row: number,
  ground: GroundType,
  brightnessCorrection: BrightnessCorrection = 0,
): boolean {
  if (!isInside(map, column, row)) return false;
  if (!brightnessCorrections.includes(brightnessCorrection)) return false;
  const cell = map.cells[cellIndex(map, column, row)];
  if (
    cell.ground === ground &&
    cell.brightnessCorrection === brightnessCorrection &&
    (ground !== "water" || cell.elevation === 0)
  ) return false;
  cell.ground = ground;
  cell.brightnessCorrection = brightnessCorrection;
  if (ground === "water") cell.elevation = 0;
  map.updatedAt = new Date().toISOString();
  return true;
}

export function setTileElevation(
  map: MapDocument,
  column: number,
  row: number,
  elevation: TileElevation,
): boolean {
  if (!isInside(map, column, row)) return false;
  if (!tileElevations.includes(elevation)) return false;
  const cell = map.cells[cellIndex(map, column, row)];
  if (cell.ground === "water" || cell.elevation === elevation) return false;
  cell.elevation = elevation;
  map.updatedAt = new Date().toISOString();
  return true;
}

export function placeProp(
  map: MapDocument,
  column: number,
  row: number,
  prop: PropType | null,
): boolean {
  if (!isInside(map, column, row)) return false;
  const cell = map.cells[cellIndex(map, column, row)];
  if (cell.prop === prop) return false;
  cell.prop = prop;
  map.updatedAt = new Date().toISOString();
  return true;
}

export function placeImage(
  map: MapDocument,
  imageId: string,
  column: number,
  row: number,
  rotation = 0,
  scale = 1,
): boolean {
  if (!isInside(map, column, row) || !imageId.trim()) return false;
  map.images.push({
    imageId,
    column,
    row,
    rotation: normalizeRotation(rotation),
    scale: normalizeImageScale(scale),
  });
  map.updatedAt = new Date().toISOString();
  return true;
}

export function moveImage(
  map: MapDocument,
  imageIndex: number,
  column: number,
  row: number,
): boolean {
  if (!Number.isInteger(imageIndex) || !isInside(map, column, row)) return false;
  const image = map.images[imageIndex];
  if (!image || (image.column === column && image.row === row)) return false;
  image.column = column;
  image.row = row;
  map.updatedAt = new Date().toISOString();
  return true;
}

export function removeImage(map: MapDocument, imageIndex: number): boolean {
  if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= map.images.length) return false;
  map.images.splice(imageIndex, 1);
  map.updatedAt = new Date().toISOString();
  return true;
}

export function updateImageTransform(
  map: MapDocument,
  imageIndex: number,
  rotation: number,
  scale: number,
): boolean {
  if (!Number.isInteger(imageIndex)) return false;
  const image = map.images[imageIndex];
  if (!image) return false;
  const nextRotation = normalizeRotation(rotation);
  const nextScale = normalizeImageScale(scale);
  if (image.rotation === nextRotation && image.scale === nextScale) return false;
  image.rotation = nextRotation;
  image.scale = nextScale;
  map.updatedAt = new Date().toISOString();
  return true;
}

export function moveProp(
  map: MapDocument,
  fromColumn: number,
  fromRow: number,
  toColumn: number,
  toRow: number,
): boolean {
  if (!isInside(map, fromColumn, fromRow) || !isInside(map, toColumn, toRow)) return false;
  if (fromColumn === toColumn && fromRow === toRow) return false;

  const source = map.cells[cellIndex(map, fromColumn, fromRow)];
  if (!source.prop) return false;

  const target = map.cells[cellIndex(map, toColumn, toRow)];
  target.prop = source.prop;
  source.prop = null;
  map.updatedAt = new Date().toISOString();
  return true;
}

export function clearGround(map: MapDocument): MapDocument {
  return {
    ...map,
    cells: map.cells.map(() => ({ ground: "grass", elevation: 0, brightnessCorrection: 0, prop: null })),
    updatedAt: new Date().toISOString(),
  };
}

export function createInitialMap(): MapDocument {
  const map: MapDocument = {
    version: 1,
    name: "개울이 흐르는 숲",
    columns: GRID_COLUMNS,
    rows: GRID_ROWS,
    cells: Array.from({ length: GRID_COLUMNS * GRID_ROWS }, () => ({
      ground: "grass" as GroundType,
      elevation: 0 as TileElevation,
      brightnessCorrection: 0 as BrightnessCorrection,
      prop: null,
    })),
    images: [],
    updatedAt: new Date().toISOString(),
  };

  for (let row = 0; row < map.rows; row += 1) {
    const creekCenter = 3 + Math.floor(row * 1.05);
    for (let column = 0; column < map.columns; column += 1) {
      const distance = Math.abs(column - creekCenter);
      if (distance <= 1 || (row % 5 === 0 && distance === 2)) {
        map.cells[cellIndex(map, column, row)].ground = "water";
      } else if (distance === 2 && (column + row) % 2 === 0) {
        map.cells[cellIndex(map, column, row)].ground = "stone";
      }
    }
  }

  for (let row = 0; row < map.rows; row += 1) {
    const pathCenter = 23 - Math.floor(row * 0.42);
    for (let offset = -1; offset <= 1; offset += 1) {
      const column = pathCenter + offset;
      if (isInside(map, column, row)) {
        const cell = map.cells[cellIndex(map, column, row)];
        if (cell.ground !== "water") cell.ground = "dirt";
      }
    }
  }

  const props: Array<[number, number, PropType]> = [
    [1, 1, "broadleaf-tree"],
    [5, 2, "pine-tree"],
    [12, 1, "broadleaf-tree"],
    [18, 2, "pine-tree"],
    [25, 1, "broadleaf-tree"],
    [2, 7, "shrub"],
    [8, 6, "boulder"],
    [18, 6, "shrub"],
    [25, 7, "boulder"],
    [10, 9, "footbridge"],
    [3, 13, "fallen-log"],
    [8, 14, "pine-tree"],
    [17, 13, "boulder"],
    [24, 14, "broadleaf-tree"],
    [1, 16, "pine-tree"],
    [14, 16, "shrub"],
    [26, 16, "pine-tree"],
  ];

  for (const [column, row, prop] of props) {
    map.cells[cellIndex(map, column, row)].prop = prop;
  }

  return map;
}

export function serializeMap(map: MapDocument): string {
  return JSON.stringify(map, null, 2);
}

export function deserializeMap(value: string): MapDocument | null {
  try {
    const parsed = JSON.parse(value) as Partial<MapDocument>;
    if (
      parsed.version !== 1 ||
      typeof parsed.name !== "string" ||
      typeof parsed.columns !== "number" ||
      typeof parsed.rows !== "number" ||
      !Array.isArray(parsed.cells) ||
      parsed.cells.length !== parsed.columns * parsed.rows
    ) {
      return null;
    }

    const rawImages = parsed.images === undefined ? [] : parsed.images;
    if (!Array.isArray(rawImages)) return null;

    const cells: MapCell[] = [];
    for (const rawCell of parsed.cells) {
      const cell = rawCell as Partial<MapCell>;
      if (!groundTypes.includes(cell.ground as GroundType)) return null;
      if (cell.prop !== null && !propTypes.includes(cell.prop as PropType)) return null;
      const elevation = cell.elevation === undefined ? 0 : cell.elevation;
      if (!tileElevations.includes(elevation as TileElevation) || !Number.isInteger(elevation)) return null;
      const brightnessCorrection = cell.brightnessCorrection === undefined ? 0 : cell.brightnessCorrection;
      if (!brightnessCorrections.includes(brightnessCorrection as BrightnessCorrection) || !Number.isInteger(brightnessCorrection)) return null;
      cells.push({
        ground: cell.ground as GroundType,
        elevation: cell.ground === "water" ? 0 : elevation as TileElevation,
        brightnessCorrection: brightnessCorrection as BrightnessCorrection,
        prop: cell.prop as PropType | null,
      });
    }

    const images: MapImagePlacement[] = [];
    for (const rawImage of rawImages) {
      const image = parseImagePlacement(rawImage, parsed.columns, parsed.rows);
      if (!image) return null;
      images.push(image);
    }

    return {
      version: 1,
      name: parsed.name,
      columns: parsed.columns,
      rows: parsed.rows,
      cells,
      images,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

function normalizeImageScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(IMAGE_MIN_SCALE, Math.min(IMAGE_MAX_SCALE, value));
}

function parseImagePlacement(value: unknown, columns: number, rows: number): MapImagePlacement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<MapImagePlacement>;
  const { column, row } = record;
  if (
    typeof record.imageId !== "string" ||
    !record.imageId.trim() ||
    record.imageId.length > 128 ||
    typeof column !== "number" ||
    !Number.isInteger(column) ||
    typeof row !== "number" ||
    !Number.isInteger(row) ||
    column < 0 ||
    row < 0 ||
    column >= columns ||
    row >= rows ||
    typeof record.rotation !== "number" ||
    !Number.isFinite(record.rotation) ||
    typeof record.scale !== "number" ||
    !Number.isFinite(record.scale)
  ) return null;

  return {
    imageId: record.imageId.trim(),
    column,
    row,
    rotation: normalizeRotation(record.rotation),
    scale: normalizeImageScale(record.scale),
  };
}
