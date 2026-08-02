import { deserializeMap, serializeMap, type MapCell, type MapDocument, type MapImagePlacement } from "./editor-model";

export interface SavedMapSummary {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SavedMap extends SavedMapSummary {
  payload: string;
}

export type ResizeAnchorName =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

export interface ResizeAnchorPoint {
  horizontal?: "left" | "center" | "right";
  vertical?: "top" | "center" | "bottom";
  x?: "left" | "center" | "right";
  y?: "top" | "center" | "bottom";
}

export type ResizeAnchor = ResizeAnchorName | ResizeAnchorPoint;

export const MIN_MAP_SIZE = 8;
export const MAX_MAP_SIZE = 200;
const DEFAULT_LIST_LIMIT = 50;

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim();
  if (!baseUrl) throw new Error("Map API base URL is required");
  return baseUrl.replace(/\/+$/, "");
}

function getErrorMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
  }
  return `Map API request failed (${status})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSavedMap(value: unknown): SavedMap {
  const record = isRecord(value) && isRecord(value.map) ? value.map : value;
  if (!isRecord(record) || typeof record.id !== "string" || typeof record.name !== "string") {
    throw new Error("Map API returned an invalid map record");
  }

  const payload = typeof record.payload === "string"
    ? record.payload
    : isRecord(record.payload)
      ? JSON.stringify(record.payload)
      : undefined;
  if (!payload) throw new Error("Map API returned an invalid map payload");

  return {
    id: record.id,
    name: record.name,
    payload,
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
  };
}

function parseSummary(value: unknown): SavedMapSummary {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new Error("Map API returned an invalid map list item");
  }

  return {
    id: value.id,
    name: value.name,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function readListItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.items)) return value.items;
  if (isRecord(value) && Array.isArray(value.maps)) return value.maps;
  throw new Error("Map API returned an invalid map list");
}

function getAnchorParts(anchor: ResizeAnchor): { horizontal: "left" | "center" | "right"; vertical: "top" | "center" | "bottom" } {
  if (typeof anchor === "object") {
    return {
      horizontal: anchor.horizontal ?? anchor.x ?? "center",
      vertical: anchor.vertical ?? anchor.y ?? "center",
    };
  }

  switch (anchor) {
    case "top-left":
    case "topLeft":
      return { horizontal: "left", vertical: "top" };
    case "top":
      return { horizontal: "center", vertical: "top" };
    case "top-right":
    case "topRight":
      return { horizontal: "right", vertical: "top" };
    case "left":
      return { horizontal: "left", vertical: "center" };
    case "right":
      return { horizontal: "right", vertical: "center" };
    case "bottom-left":
    case "bottomLeft":
      return { horizontal: "left", vertical: "bottom" };
    case "bottom":
      return { horizontal: "center", vertical: "bottom" };
    case "bottom-right":
    case "bottomRight":
      return { horizontal: "right", vertical: "bottom" };
    case "center":
      return { horizontal: "center", vertical: "center" };
    default:
      return { horizontal: "center", vertical: "center" };
  }
}

function getOffset(nextSize: number, currentSize: number, anchor: "left" | "center" | "right" | "top" | "bottom"): number {
  const difference = nextSize - currentSize;
  if (anchor === "left" || anchor === "top") return 0;
  if (anchor === "right" || anchor === "bottom") return difference;
  return Math.floor(difference / 2);
}

export interface ResizeOffsets {
  column: number;
  row: number;
}

export function getResizeOffsets(
  currentColumns: number,
  currentRows: number,
  columns: number,
  rows: number,
  anchor: ResizeAnchor = "center",
): ResizeOffsets {
  const parts = getAnchorParts(anchor);
  return {
    column: getOffset(columns, currentColumns, parts.horizontal),
    row: getOffset(rows, currentRows, parts.vertical),
  };
}

function validateMapSize(value: number, label: string): void {
  if (!Number.isInteger(value) || value < MIN_MAP_SIZE || value > MAX_MAP_SIZE) {
    throw new RangeError(`${label} must be an integer between ${MIN_MAP_SIZE} and ${MAX_MAP_SIZE}`);
  }
}

export function resizeMap(
  map: MapDocument,
  columns: number,
  rows: number,
  anchor: ResizeAnchor = "center",
): MapDocument {
  validateMapSize(columns, "columns");
  validateMapSize(rows, "rows");

  if (!Number.isInteger(map.columns) || !Number.isInteger(map.rows) || map.columns < 1 || map.rows < 1) {
    throw new RangeError("The source map has invalid dimensions");
  }
  if (map.cells.length !== map.columns * map.rows) {
    throw new Error("The source map has an invalid cell count");
  }

  const offsets = getResizeOffsets(map.columns, map.rows, columns, rows, anchor);
  const cells: MapCell[] = Array.from({ length: columns * rows }, () => ({ ground: "grass", prop: null }));

  for (let row = 0; row < map.rows; row += 1) {
    for (let column = 0; column < map.columns; column += 1) {
      const nextColumn = column + offsets.column;
      const nextRow = row + offsets.row;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
      const source = map.cells[row * map.columns + column];
      cells[nextRow * columns + nextColumn] = { ...source };
    }
  }

  const images: MapImagePlacement[] = map.images.flatMap((image) => {
    const nextColumn = image.column + offsets.column;
    const nextRow = image.row + offsets.row;
    if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) return [];
    return [{ ...image, column: nextColumn, row: nextRow }];
  });

  return {
    ...map,
    columns,
    rows,
    cells,
    images,
    updatedAt: new Date().toISOString(),
  };
}

export class MapStorageClient {
  private readonly baseUrl: string;

  public constructor(apiBaseUrl: string) {
    this.baseUrl = normalizeBaseUrl(apiBaseUrl);
  }

  public async saveMap(token: string, map: MapDocument, name = map.name): Promise<SavedMap> {
    const response = await this.request("/maps", token, {
      method: "POST",
      body: JSON.stringify({ name, payload: serializeMap(map) }),
    });
    return parseSavedMap(response);
  }

  public async updateMap(token: string, id: string, map: MapDocument, name = map.name): Promise<SavedMap> {
    if (!id.trim()) throw new Error("Map id is required");
    const response = await this.request(`/maps/${encodeURIComponent(id)}`, token, {
      method: "PUT",
      body: JSON.stringify({ name, payload: serializeMap(map) }),
    });
    return parseSavedMap(response);
  }

  public async listMaps(token: string): Promise<SavedMapSummary[]> {
    const response = await this.request(`/maps?limit=${DEFAULT_LIST_LIMIT}`, token);
    return readListItems(response).map(parseSummary);
  }

  public async loadMap(token: string, id: string): Promise<MapDocument> {
    if (!id.trim()) throw new Error("Map id is required");
    const response = await this.request(`/maps/${encodeURIComponent(id)}`, token);
    const record = isRecord(response) && isRecord(response.map) ? response.map : response;
    const payload = isRecord(record) && "payload" in record
      ? typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload)
      : JSON.stringify(record);
    const map = deserializeMap(payload);
    if (!map) throw new Error("Map API returned an invalid map payload");
    return map;
  }

  private async request(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!response.ok) throw new Error(getErrorMessage(body, response.status));
    return body;
  }
}
