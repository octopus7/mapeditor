import { describe, expect, it } from "vitest";
import {
  GRID_COLUMNS,
  GRID_ROWS,
  cloneMap,
  createInitialMap,
  deserializeMap,
  moveImage,
  moveProp,
  paintGround,
  placeImage,
  placeProp,
  removeImage,
  setTileElevation,
  serializeMap,
  updateImageTransform,
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

  it("raises non-water tiles by one level and keeps water at the base level", () => {
    const map = createInitialMap();
    expect(setTileElevation(map, 0, 0, 1)).toBe(true);
    expect(map.cells[0].elevation).toBe(1);
    expect(setTileElevation(map, 0, 0, 1)).toBe(false);

    expect(paintGround(map, 0, 0, "water")).toBe(true);
    expect(map.cells[0].elevation).toBe(0);
    expect(setTileElevation(map, 0, 0, 1)).toBe(false);
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

  it("stores image hashes with movable and transformable placements", () => {
    const map = createInitialMap();
    expect(placeImage(map, "7c14a8e57ce7dcbdc1907e20f216d8c5c61390a08020ab66b52f0a9f832ee589", 2, 3, 450, 7)).toBe(true);
    expect(map.images[0]).toMatchObject({
      imageId: "7c14a8e57ce7dcbdc1907e20f216d8c5c61390a08020ab66b52f0a9f832ee589",
      column: 2,
      row: 3,
      rotation: 90,
      scale: 6,
    });
    expect(moveImage(map, 0, 4, 5)).toBe(true);
    expect(updateImageTransform(map, 0, -90, 0.5)).toBe(true);
    expect(map.images[0]).toMatchObject({ column: 4, row: 5, rotation: 270, scale: 0.5 });
    expect(removeImage(map, 0)).toBe(true);
    expect(map.images).toHaveLength(0);
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
