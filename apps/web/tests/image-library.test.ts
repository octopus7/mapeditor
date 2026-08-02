import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_MAX_BYTES,
  ImageLibraryClient,
  ImageLibraryError,
  parseImageAssetResponse,
  parseImageListResponse,
} from "../src/image-library";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFile(
  name: string,
  type: string,
  size = 3,
): File {
  const bytes = new Uint8Array(size);
  if (typeof File === "function") {
    return new File([bytes], name, { type });
  }

  const blob = new Blob([bytes], { type });
  Object.defineProperty(blob, "name", { value: name });
  return blob as File;
}

const sampleAsset = {
  id: "asset-1",
  originalFilename: "forest tile.png",
  originalUrl: "https://images.example.com/i/asset-1.png",
  thumbnailUrl: "https://images.example.com/t/asset-1",
  mimeType: "image/png",
  byteSize: 3,
  createdAt: "2026-08-02T10:00:00.000Z",
};

describe("ImageLibraryClient", () => {
  it("lists only the authenticated user's image display data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      images: [{ ...sampleAsset, ownerUserId: "other-user", secret: "do-not-return" }],
      nextCursor: "next page",
      internalToken: "do-not-return",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ImageLibraryClient("https://api.example.com/")
      .listImages("session-token", "cursor/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/images?limit=50&cursor=cursor%2F1",
      expect.objectContaining({ headers: expect.anything() }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session-token");
    expect(result).toEqual({
      images: [sampleAsset],
      nextCursor: "next page",
    });
    expect((result.images[0] as unknown as Record<string, unknown>).ownerUserId).toBeUndefined();
  });

  it("omits the cursor for the first page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ images: [] })));

    await new ImageLibraryClient("https://api.example.com").listImages("session-token");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/images?limit=50",
      expect.anything(),
    );
  });

  it("uploads a raw File with the required headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ image: sampleAsset }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("upload-key-1") });
    const file = makeFile("맵 조각 (1).png", "image/png");

    const result = await new ImageLibraryClient("https://api.example.com")
      .uploadImage("session-token", file);

    expect(result).toEqual(sampleAsset);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/images");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer session-token");
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(headers.get("X-Original-Filename")).toBe(encodeURIComponent("맵 조각 (1).png"));
    expect(headers.get("Idempotency-Key")).toBe("upload-key-1");
  });

  it("rejects an unsupported file before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ImageLibraryClient("https://api.example.com");

    await expect(client.uploadImage("session-token", makeFile("map.svg", "image/svg+xml")))
      .rejects.toMatchObject({
        code: "UNSUPPORTED_MEDIA_TYPE",
        status: 415,
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects files larger than 10MB before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ImageLibraryClient("https://api.example.com");

    await expect(client.uploadImage(
      "session-token",
      makeFile("large.png", "image/png", IMAGE_MAX_BYTES + 1),
    )).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      status: 413,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns structured API errors into a user-visible Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: { code: "IMAGE_QUOTA_EXCEEDED", message: "이미지 저장 한도를 초과했습니다." },
    }, 413)));

    const request = new ImageLibraryClient("https://api.example.com").listImages("session-token");
    await expect(request).rejects.toBeInstanceOf(Error);
    await expect(request).rejects.toEqual(expect.objectContaining({
      name: "ImageLibraryError",
      status: 413,
      code: "IMAGE_QUOTA_EXCEEDED",
      message: "이미지 저장 한도를 초과했습니다.",
    }));
  });

  it("preserves developer diagnostics from image API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "IMAGE_SERVICE_UNAVAILABLE",
        message: "The image service could not accept the image.",
        debug: {
          requestId: "ray-123",
          method: "POST",
          path: "/images",
          status: 502,
          upstreamStatus: 422,
          upstreamStatusText: "Unprocessable Entity",
          upstreamBody: "The image decoder rejected the file.",
        },
      },
    }, 502)));

    const request = new ImageLibraryClient("https://api.example.com").listImages("session-token");
    await expect(request).rejects.toMatchObject({
      code: "IMAGE_SERVICE_UNAVAILABLE",
      debug: {
        requestId: "ray-123",
        method: "POST",
        path: "/images",
        status: 502,
        upstreamStatus: 422,
        upstreamStatusText: "Unprocessable Entity",
        upstreamBody: "The image decoder rejected the file.",
      },
    });
  });

  it("requires a login token for both list and upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ImageLibraryClient("https://api.example.com");

    await expect(client.listImages("")).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    await expect(client.uploadImage("", makeFile("map.png", "image/png")))
      .rejects.toMatchObject({
        status: 401,
        code: "AUTH_REQUIRED",
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("image response parsing", () => {
  it("supports the API's snake_case response aliases while returning safe camelCase data", () => {
    expect(parseImageAssetResponse({
      image: {
        id: "asset-2",
        original_filename: "tile.webp",
        original_url: "https://images.example.com/i/asset-2.webp",
        thumbnail_url: "https://images.example.com/t/asset-2",
        mime_type: "image/webp",
        byte_size: 42,
        created_at: "2026-08-02T10:00:00.000Z",
        owner_user_id: "hidden",
      },
    })).toEqual({
      id: "asset-2",
      originalFilename: "tile.webp",
      originalUrl: "https://images.example.com/i/asset-2.webp",
      thumbnailUrl: "https://images.example.com/t/asset-2",
      mimeType: "image/webp",
      byteSize: 42,
      createdAt: "2026-08-02T10:00:00.000Z",
    });
  });

  it("rejects unsafe image URLs and malformed list data", () => {
    expect(() => parseImageAssetResponse({ ...sampleAsset, originalUrl: "javascript:alert(1)" }))
      .toThrow(ImageLibraryError);
    expect(() => parseImageListResponse({ images: [{ ...sampleAsset, byteSize: 0 }] }))
      .toThrow(ImageLibraryError);
  });
});
