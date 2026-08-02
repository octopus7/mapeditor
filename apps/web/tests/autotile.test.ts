import { describe, expect, it } from "vitest";
import {
  GROUND_PRIORITY,
  BRIDGE_CARDINAL_MASK,
  NEIGHBOR_MASK,
  getBridgeConnectionDirections,
  getBridgeEndpointMask,
  getBridgeConnectionShape,
  getBridgeTextureRotation,
  getPropNeighborMask,
  getTransitionCorrections,
  getNeighborMask,
  getTransitionLayers,
  getWaterBankMask,
  getWaterBankCornerMask,
  getWaterDepths,
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
    cells: rows.flatMap((row) => row.map((ground) => ({ ground, elevation: 0 as const, brightnessCorrection: 0 as const, prop: null }))),
    images: [],
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
      {
        ground: "stone",
        mask: NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE,
        priority: GROUND_PRIORITY.stone,
      },
    ]);
  });

  it("places a correction strip on the higher-priority neighboring tile", () => {
    const map = createMap([
      ["grass", "stone", "grass"],
      ["grass", "dirt", "grass"],
      ["grass", "grass", "grass"],
    ]);

    expect(getTransitionCorrections(map, 1, 1)).toEqual([
      {
        ground: "dirt",
        targetColumn: 1,
        targetRow: 0,
        mask: NEIGHBOR_MASK.S,
        priority: GROUND_PRIORITY.stone,
      },
    ]);
  });

  it("adds a diagonal corner correction when both touching edges continue", () => {
    const map = createMap([
      ["stone", "stone", "grass"],
      ["stone", "grass", "grass"],
      ["grass", "grass", "grass"],
    ]);

    expect(getTransitionCorrections(map, 1, 1)).toContainEqual({
      ground: "grass",
      targetColumn: 0,
      targetRow: 0,
      mask: NEIGHBOR_MASK.SE,
      priority: GROUND_PRIORITY.stone,
    });
  });

  it("keeps water out of ground overlays so land keeps its own ground", () => {
    const map = createMap([
      ["dirt", "water", "dirt"],
      ["dirt", "dirt", "dirt"],
      ["dirt", "dirt", "dirt"],
    ]);

    expect(getTransitionLayers(map, 1, 1)).toEqual([]);
    expect(getWaterBankMask(map, 1, 1)).toBe(NEIGHBOR_MASK.N);
    expect(map.cells[4].ground).toBe("dirt");
  });

  it("does not draw lower-priority ground over the current ground", () => {
    const map = createMap([
      ["grass", "dirt", "stone"],
      ["grass", "water", "grass"],
      ["grass", "grass", "grass"],
    ]);

    expect(getTransitionLayers(map, 1, 1)).toEqual([]);
  });

  it("returns water edges only for land cells that need a raised bank", () => {
    const map = createMap([
      ["grass", "water", "grass"],
      ["water", "grass", "water"],
      ["grass", "water", "grass"],
    ]);

    expect(getWaterBankMask(map, 1, 1)).toBe(
      NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.S | NEIGHBOR_MASK.W,
    );
    expect(getWaterBankMask(map, 1, 0)).toBe(0);
  });

  it("increases water depth away from the land boundary", () => {
    const map = createMap([
      ["grass", "grass", "grass", "grass", "grass"],
      ["grass", "water", "water", "water", "grass"],
      ["grass", "water", "water", "water", "grass"],
      ["grass", "water", "water", "water", "grass"],
      ["grass", "grass", "grass", "grass", "grass"],
    ]);

    const depths = getWaterDepths(map);
    expect(depths[6]).toBe(0);
    expect(depths[12]).toBe(1);
    expect(depths[8]).toBe(0);
  });

  it("does not create a water bank from a diagonal-only neighbor", () => {
    const map = createMap([
      ["water", "dirt", "dirt"],
      ["dirt", "dirt", "dirt"],
      ["dirt", "dirt", "water"],
    ]);

    expect(getWaterBankMask(map, 1, 1)).toBe(0);
  });

  it("returns a water corner when the two touching water edges continue", () => {
    const map = createMap([
      ["grass", "water", "water"],
      ["grass", "grass", "water"],
      ["grass", "grass", "grass"],
    ]);

    expect(getWaterBankCornerMask(map, 1, 1)).toBe(NEIGHBOR_MASK.NE);
  });

  it("classifies bridge connections as horizontal, vertical, corners, and full", () => {
    expect(getBridgeConnectionShape(NEIGHBOR_MASK.E | NEIGHBOR_MASK.W)).toBe("horizontal");
    expect(getBridgeConnectionShape(NEIGHBOR_MASK.N | NEIGHBOR_MASK.S)).toBe("vertical");
    expect(getBridgeConnectionShape(NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE)).toBe("corner-ne");
    expect(getBridgeConnectionShape(255)).toBe("full");
    expect(getBridgeTextureRotation("horizontal")).toBe(90);
    expect(getBridgeTextureRotation("vertical")).toBe(0);
  });

  it("returns bridge arms and exposed endpoints independently of diagonal bits", () => {
    const cornerMask = NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.NE;

    expect(getBridgeConnectionDirections(cornerMask)).toEqual(["N", "E"]);
    expect(getBridgeEndpointMask(cornerMask)).toBe(NEIGHBOR_MASK.S | NEIGHBOR_MASK.W);
    expect(getBridgeEndpointMask(NEIGHBOR_MASK.E | NEIGHBOR_MASK.W)).toBe(0);
    expect(getBridgeEndpointMask(NEIGHBOR_MASK.E)).toBe(NEIGHBOR_MASK.W);
    expect(getBridgeEndpointMask(NEIGHBOR_MASK.N)).toBe(NEIGHBOR_MASK.S);
    expect(getBridgeConnectionDirections(255)).toEqual(["N", "E", "S", "W"]);
    expect(getBridgeEndpointMask(255)).toBe(0);
    expect(BRIDGE_CARDINAL_MASK).toBe(
      NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.S | NEIGHBOR_MASK.W,
    );
  });

  it("connects bridge props through cardinal and supported diagonal neighbors", () => {
    const map = createMap([
      ["grass", "grass", "grass"],
      ["grass", "grass", "grass"],
      ["grass", "grass", "grass"],
    ]);
    map.cells[4].prop = "footbridge";
    map.cells[3].prop = "footbridge";
    map.cells[5].prop = "footbridge";
    map.cells[1].prop = "footbridge";
    map.cells[2].prop = "footbridge";

    expect(getPropNeighborMask(map, 1, 1, "footbridge")).toBe(
      NEIGHBOR_MASK.N | NEIGHBOR_MASK.E | NEIGHBOR_MASK.W | NEIGHBOR_MASK.NE,
    );
  });
});
