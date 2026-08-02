import { describe, expect, it } from "vitest";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  cloneMap,
  createInitialMap,
  deserializeMap,
  moveProp,
  paintGround,
  placeProp,
  serializeMap,
} from "../src/editor-model";

describe("editor model", () => {
  it("creates a complete forest layout", () => {
    const map = createInitialMap();
    expect(map.columns).toBe(GRID_COLUMNS);
    expect(map.rows).toBe(GRID_ROWS);
    expect(map.cells).toHaveLength(GRID_COLUMNS * GRID_ROWS);
    expect(map.cells.some((cell) => cell.ground === "water")).toBe(true);
    expect(map.cells.some((cell) => cell.prop === "footbridge")).toBe(true);
  });

  it("paints ground and places props only inside the map", () => {
    const map = createInitialMap();
    expect(paintGround(map, 0, 0, "dirt")).toBe(true);
    expect(placeProp(map, 0, 0, "shrub")).toBe(true);
    expect(paintGround(map, -1, 0, "water")).toBe(false);
    expect(placeProp(map, map.columns, 0, "boulder")).toBe(false);
  });

  it("moves a prop to another cell and overwrites the destination prop", () => {
    const map = createInitialMap();
    expect(placeProp(map, 0, 0, "boulder")).toBe(true);
    expect(moveProp(map, 0, 0, 1, 1)).toBe(true);
    expect(map.cells[0].prop).toBeNull();
    expect(map.cells[1 + map.columns].prop).toBe("boulder");
    expect(moveProp(map, 0, 0, 2, 2)).toBe(false);
    expect(moveProp(map, 1, 1, map.columns, 0)).toBe(false);
  });

  it("clones and round-trips documents without shared cells", () => {
    const map = createInitialMap();
    const copy = cloneMap(map);
    copy.cells[0].ground = "stone";
    expect(map.cells[0].ground).not.toBe(copy.cells[0].ground);

    const restored = deserializeMap(serializeMap(map));
    expect(restored).toEqual(map);
  });

  it("rejects invalid documents", () => {
    expect(deserializeMap("not-json")).toBeNull();
    expect(deserializeMap('{"version":1,"cells":[]}')).toBeNull();
  });
});
