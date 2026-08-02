import { describe, expect, it, vi } from "vitest";
import { createInitialMap, type MapDocument } from "../src/editor-model";
import { getResizeOffsets, MapStorageClient, resizeMap } from "../src/map-library";

function createSmallMap(): MapDocument {
  const map = createInitialMap();
  map.columns = 8;
  map.rows = 8;
  map.cells = Array.from({ length: 64 }, () => ({ ground: "grass" as const, prop: null }));
  map.cells[0] = { ground: "water", prop: "boulder" };
  map.cells[7] = { ground: "stone", prop: "pine-tree" };
  map.cells[56] = { ground: "dirt", prop: "shrub" };
  map.cells[63] = { ground: "water", prop: "footbridge" };
  map.images = [
    { imageId: "asset-1", column: 2, row: 3, rotation: 90, scale: 2 },
    { imageId: "asset-2", column: 7, row: 7, rotation: 0, scale: 1 },
  ];
  return map;
}

describe("resizeMap", () => {
  it("preserves cells from the selected top-left anchor and fills new cells", () => {
    const original = createSmallMap();
    const resized = resizeMap(original, 10, 9, "top-left");

    expect(resized.columns).toBe(10);
    expect(resized.rows).toBe(9);
    expect(resized.cells[0]).toEqual({ ground: "water", prop: "boulder" });
    expect(resized.cells[7]).toEqual({ ground: "stone", prop: "pine-tree" });
    expect(resized.cells[8]).toEqual({ ground: "grass", prop: null });
    expect(resized.cells[7 * 10]).toEqual({ ground: "dirt", prop: "shrub" });
    expect(resized.cells[7 * 10 + 7]).toEqual({ ground: "water", prop: "footbridge" });
    expect(original.columns).toBe(8);
    expect(original.cells[0]).toEqual({ ground: "water", prop: "boulder" });
  });

  it("keeps the existing map centered when expanding", () => {
    const original = createSmallMap();
    const resized = resizeMap(original, 10, 10, "center");

    expect(resized.cells[1 * 10 + 1]).toEqual({ ground: "water", prop: "boulder" });
    expect(resized.cells[1 * 10 + 8]).toEqual({ ground: "stone", prop: "pine-tree" });
    expect(resized.cells[8 * 10 + 1]).toEqual({ ground: "dirt", prop: "shrub" });
    expect(resized.cells[8 * 10 + 8]).toEqual({ ground: "water", prop: "footbridge" });
    expect(resized.images).toEqual([
      { imageId: "asset-1", column: 3, row: 4, rotation: 90, scale: 2 },
      { imageId: "asset-2", column: 8, row: 8, rotation: 0, scale: 1 },
    ]);
  });

  it("validates the requested dimensions", () => {
    const map = createSmallMap();
    expect(() => resizeMap(map, 7, 8, "top-left")).toThrow(RangeError);
    expect(() => resizeMap(map, 8, 201, "top-left")).toThrow(RangeError);
    expect(() => resizeMap(map, 8.5, 8, "top-left")).toThrow(RangeError);
  });

  it("computes offsets for all nine anchor positions", () => {
    const anchors = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;
    expect(anchors.map((anchor) => getResizeOffsets(8, 8, 10, 10, anchor))).toEqual([
      { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 },
      { column: 0, row: 1 }, { column: 1, row: 1 }, { column: 2, row: 1 },
      { column: 0, row: 2 }, { column: 1, row: 2 }, { column: 2, row: 2 },
    ]);
  });
});

describe("MapStorageClient", () => {
  it("serializes, authenticates, and calls the map endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const map = createSmallMap();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "map-1", name: "Forest", payload: "{}" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "map-1", name: "Forest" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ payload: JSON.stringify(map) })));
    const client = new MapStorageClient("https://api.example.test/");

    const saved = await client.saveMap("login-token", map, "Forest");
    const listed = await client.listMaps("login-token");
    const loaded = await client.loadMap("login-token", "map-1");

    expect(saved.id).toBe("map-1");
    expect(listed).toEqual([{ id: "map-1", name: "Forest" }]);
    expect(loaded).toEqual(map);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.example.test/maps", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"name":"Forest"'),
    }));
    const firstRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(firstRequest.headers).get("Authorization")).toBe("Bearer login-token");
    expect(new Headers(firstRequest.headers).get("Content-Type")).toBe("application/json");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.example.test/maps?limit=50");
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get("Authorization")).toBe("Bearer login-token");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.example.test/maps/map-1");
    expect(new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers).get("Authorization")).toBe("Bearer login-token");
    fetchMock.mockRestore();
  });

  it("converts HTTP and invalid payload responses into Errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }));
    const client = new MapStorageClient("https://api.example.test");
    await expect(client.listMaps("bad-token")).rejects.toThrow("Unauthorized");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ payload: "not-a-map" })));
    await expect(client.loadMap("login-token", "map-1")).rejects.toThrow("invalid map payload");
    fetchMock.mockRestore();
  });
});
