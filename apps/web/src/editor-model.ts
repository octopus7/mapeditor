export const GRID_COLUMNS = 28;
export const GRID_ROWS = 18;

export const groundTypes = ["grass", "dirt", "stone", "water"] as const;
export type GroundType = (typeof groundTypes)[number];

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
  prop: PropType | null;
}
export interface MapDocument {
  version: 1;
  name: string;
  columns: number;
  rows: number;
  cells: MapCell[];
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
  };
}

export function paintGround(
  map: MapDocument,
  column: number,
  row: number,
  ground: GroundType,
): boolean {
  if (!isInside(map, column, row)) return false;
  const cell = map.cells[cellIndex(map, column, row)];
  if (cell.ground === ground) return false;
  cell.ground = ground;
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

export function clearGround(map: MapDocument): MapDocument {
  return {
    ...map,
    cells: map.cells.map(() => ({ ground: "grass", prop: null })),
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
      prop: null,
    })),
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

    const cells: MapCell[] = [];
    for (const rawCell of parsed.cells) {
      const cell = rawCell as Partial<MapCell>;
      if (!groundTypes.includes(cell.ground as GroundType)) return null;
      if (cell.prop !== null && !propTypes.includes(cell.prop as PropType)) return null;
      cells.push({ ground: cell.ground as GroundType, prop: cell.prop as PropType | null });
    }

    return {
      version: 1,
      name: parsed.name,
      columns: parsed.columns,
      rows: parsed.rows,
      cells,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
