import { describe, expect, it } from "vitest";
import {
  GROUND_PRIORITY,
  NEIGHBOR_MASK,
  getNeighborMask,
  getTransitionLayers,
  normalizeBlobMask,
} from "../src/autotile";
import { type GroundType, type MapDocument } from "../src/editor-model";

function createMap(rows: GroundType[][]): MapDocument {
  const columns = rows[0].length;
  return {
    version: 1,
    name: "autotile test",
    columns,
    rows: rows.length,
    cells: rows.flatMap((row) => row.map((ground) => ({ ground, prop: null }))),
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

describe("autotile calculations", () => {
  it("keeps all eight connections for a fully matching neighborhood", () => {
    const map = createMap([
      ["grass", "grass", "grass"],
      ["grass", "grass", "grass"],
      ["grass", "grass", "grass"],
    ]);

    expect(getNeighborMask(map, 1, 1, "grass")).toBe(255);
  });

  it("normalizes every raw mask to one of the 47 valid Blob shapes", () => {
    const normalizedMasks = new Set(
      Array.from({ length: 256 }, (_, mask) => normalizeBlobMask(mask)),
    );

    expect(normalizedMasks.size).toBe(47);
    expect(normalizeBlobMask(NEIGHBOR_MASK.NE)).toBe(0);
    expect(
      normalizeBlobMask(
        NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE,
      ),
    ).toBe(NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE);
  });

  it("does not connect a diagonal-only neighbor", () => {
    const map = createMap([
      ["grass", "dirt", "dirt"],
      ["dirt", "dirt", "dirt"],
      ["dirt", "dirt", "dirt"],
    ]);

    expect(getNeighborMask(map, 1, 1, "grass")).toBe(0);
  });

  it("requires both orthogonal neighbors for a diagonal connection", () => {
    const map = createMap([
      ["dirt", "dirt", "grass"],
      ["dirt", "dirt", "dirt"],
      ["dirt", "dirt", "dirt"],
    ]);

    expect(getNeighborMask(map, 1, 1, "grass")).toBe(0);

    map.cells[1].ground = "grass";
    map.cells[5].ground = "grass";
    expect(getNeighborMask(map, 1, 1, "grass")).toBe(
      NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE,
    );
  });

  it("treats the map boundary as the current ground", () => {
    const map = createMap([["grass"]]);

    expect(getNeighborMask(map, 0, 0, "grass")).toBe(255);
    expect(getNeighborMask(map, 0, 0, "dirt")).toBe(0);
    expect(getNeighborMask(map, -1, 0, "grass")).toBe(0);
  });

  it("returns higher-priority transitions in deterministic draw order", () => {
    const map = createMap([
      ["grass", "stone", "stone"],
      ["dirt", "grass", "stone"],
      ["grass", "water", "grass"],
    ]);

    expect(getTransitionLayers(map, 1, 1)).toEqual([
      { ground: "dirt", mask: NEIGHBOR_MASK.W, priority: GROUND_PRIORITY.dirt },
      {
        ground: "stone",
        mask: NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE,
        priority: GROUND_PRIORITY.stone,
      },
      { ground: "water", mask: NEIGHBOR_MASK.S, priority: GROUND_PRIORITY.water },
    ]);
  });

  it("does not draw lower-priority ground over the current ground", () => {
    const map = createMap([
      ["grass", "dirt", "stone"],
      ["grass", "water", "grass"],
      ["grass", "grass", "grass"],
    ]);

    expect(getTransitionLayers(map, 1, 1)).toEqual([]);
  });
});
