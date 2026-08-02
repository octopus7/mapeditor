import { describe, expect, it, vi } from "vitest";
import {
  createApiHandler,
  DEFAULT_DISPLAY_NAME,
  normalizeMapPayload,
  parseAllowedOrigins,
  parseDeveloperDebugIps,
  type ImageAsset,
  type ImageAssetInput,
  type ImageAssetRepository,
  type MapDocument,
  type MapDocumentInput,
  type MapRepository,
  validateAvatarIcon,
  validateDisplayName,
  validateMemeImageResponse,
  type AvatarIcon,
  type AdminUser,
  type GoogleIdentity,
  type Profile,
  type UserRepository,
} from "../src/index";

const SESSION_SECRET = "a-secure-test-session-secret-with-at-least-32-bytes";
const ALLOWED_ORIGIN = "https://mapedit.pages.dev";
const ALLOWED_ORIGINS =
  "https://mapedit.pages.dev,http://127.0.0.1:4173,http://localhost:4173" as const;

class InMemoryUserRepository implements UserRepository {
  readonly profiles = new Map<string, Profile>();
  readonly subjects = new Map<string, string>();
  readonly admins = new Set<string>();

  async findById(id: string): Promise<Profile | null> {
    return this.profiles.get(id) ?? null;
  }

  async saveGoogleLogin(identity: GoogleIdentity): Promise<Profile> {
    const existingId = this.subjects.get(identity.subject);
    if (existingId) {
      const existing = this.profiles.get(existingId);
      if (!existing) throw new Error("Invalid in-memory user state");
      const profile = { ...existing, email: identity.email };
      this.profiles.set(existingId, profile);
      return profile;
    }
    const profile = {
      id: `user-${this.profiles.size + 1}`,
      email: identity.email,
      displayName: DEFAULT_DISPLAY_NAME,
      avatarIcon: "initial" as const,
    };
    this.subjects.set(identity.subject, profile.id);
    this.profiles.set(profile.id, profile);
    return profile;
  }

  async updateProfile(
    id: string,
    displayName: string,
    avatarIcon: AvatarIcon,
  ): Promise<Profile | null> {
    const existing = this.profiles.get(id);
    if (!existing) return null;
    const profile = { ...existing, displayName, avatarIcon };
    this.profiles.set(id, profile);
    return profile;
  }

  async isAdmin(id: string): Promise<boolean> {
    return this.admins.has(id);
  }

  async listUsers(limit: number): Promise<AdminUser[]> {
    return [...this.profiles.values()].slice(0, limit).map((profile) => ({
      ...profile,
      isAdmin: this.admins.has(profile.id),
    }));
  }

  async promoteToAdmin(id: string): Promise<AdminUser | null> {
    const profile = this.profiles.get(id);
    if (!profile) return null;
    this.admins.add(id);
    return { ...profile, isAdmin: true };
  }
}

class InMemoryImageAssetRepository implements ImageAssetRepository {
  readonly images: ImageAsset[] = [];

  async findByIdempotencyKey(ownerUserId: string, idempotencyKey: string): Promise<ImageAsset | null> {
    return this.images.find((image) =>
      image.id === `${ownerUserId}:${idempotencyKey}`
    ) ?? null;
  }

  async create(input: ImageAssetInput): Promise<ImageAsset> {
    const image = {
      id: `${input.ownerUserId}:${input.idempotencyKey}`,
      originalFilename: input.originalFilename,
      hash: input.hash,
      extension: input.extension,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      originalUrl: input.originalUrl,
      thumbnailUrl: input.thumbnailUrl,
      createdAt: "2026-08-02 00:00:00",
    } satisfies ImageAsset;
    this.images.push(image);
    return image;
  }

  async listByOwner(ownerUserId: string, limit: number): Promise<ImageAsset[]> {
    return this.images
      .filter((image) => image.id.startsWith(`${ownerUserId}:`))
      .slice(0, limit);
  }
}

class InMemoryMapRepository implements MapRepository {
  readonly maps: Array<MapDocument & { ownerUserId: string }> = [];

  async create(input: MapDocumentInput): Promise<MapDocument> {
    const map = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      name: input.name,
      payload: JSON.parse(input.payloadJson) as Record<string, unknown>,
      createdAt: "2026-08-02 00:00:00",
      updatedAt: "2026-08-02 00:00:00",
    };
    this.maps.push(map);
    return map;
  }

  async update(
    ownerUserId: string,
    id: string,
    name: string,
    payloadJson: string,
    _payloadBytes: number,
  ): Promise<MapDocument | null> {
    const existing = this.maps.find((map) => map.ownerUserId === ownerUserId && map.id === id);
    if (!existing) return null;
    existing.name = name;
    existing.payload = JSON.parse(payloadJson) as Record<string, unknown>;
    existing.updatedAt = "2026-08-02 00:01:00";
    return existing;
  }

  async listByOwner(ownerUserId: string, limit: number): Promise<MapDocument[]> {
    return this.maps.filter((map) => map.ownerUserId === ownerUserId).slice(0, limit);
  }

  async findById(ownerUserId: string, id: string): Promise<MapDocument | null> {
    return this.maps.find((map) => map.ownerUserId === ownerUserId && map.id === id) ?? null;
  }
}

function createTestApi() {
  const users = new InMemoryUserRepository();
  const images = new InMemoryImageAssetRepository();
  const maps = new InMemoryMapRepository();
  const handler = createApiHandler({
    createUserRepository: () => users,
    createImageRepository: () => images,
    createMapRepository: () => maps,
    verifyGoogleCredential: async (credential) => credential === "test-google-credential"
      ? { subject: "google-subject-1", email: "editor@example.com" }
      : { subject: credential, email: `${credential}@example.com` },
  });
  const env = {
    ALLOWED_ORIGINS,
    DEVELOPER_DEBUG_IPS: "14.35.239.105",
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    SESSION_SECRET,
    MEME_UPLOAD_BASE_URL: "https://meme-admin.devtuna.win",
    MEME_IMAGE_ORIGIN: "https://meme.devtuna.win",
    MEME_UPLOAD_TOKEN: "a-secure-test-meme-upload-token-with-at-least-32-bytes",
  } satisfies Omit<Env, "DB">;
  return { env, handler, users, images, maps };
}

async function login(
  handler: ReturnType<typeof createApiHandler>,
  env: Omit<Env, "DB">,
  credential = "test-google-credential",
): Promise<{ token: string; profile: Profile }> {
  const response = await handler.fetch!(
    new Request("https://api.example.com/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ credential }),
    }),
    env as Env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  return response.json();
}

describe("authentication helpers", () => {
  it("normalizes display names", () => {
    expect(validateDisplayName("  숲   지킴이  ")).toBe("숲 지킴이");
  });

  it("rejects missing, control-character, and overly long names", () => {
    expect(() => validateDisplayName("   ")).toThrow();
    expect(() => validateDisplayName("잘못된\u0000이름")).toThrow();
    expect(() => validateDisplayName("가".repeat(41))).toThrow();
  });

  it("counts Unicode code points for the display-name limit", () => {
    expect(validateDisplayName("🌲".repeat(40))).toBe("🌲".repeat(40));
  });

  it("accepts only supported avatar icons", () => {
    expect(validateAvatarIcon("leaf")).toBe("leaf");
    expect(validateAvatarIcon("hidden")).toBe("hidden");
    expect(() => validateAvatarIcon("google-photo")).toThrow();
  });

  it("parses the exact CORS allow list", () => {
    const origins = parseAllowedOrigins(`${ALLOWED_ORIGIN}, http://localhost:4173`);
    expect(origins.has(ALLOWED_ORIGIN)).toBe(true);
    expect(origins.has("http://localhost:4173")).toBe(true);
    expect(origins.has("https://example.com")).toBe(false);
  });

  it("parses the developer debug IP allow list", () => {
    const ips = parseDeveloperDebugIps("14.35.239.105, 127.0.0.1");
    expect(ips.has("14.35.239.105")).toBe(true);
    expect(ips.has("127.0.0.1")).toBe(true);
    expect(ips.has("192.0.2.1")).toBe(false);
  });
});

describe("authentication API", () => {
  it("logs in, reads the current D1-backed profile, and updates its display name", async () => {
    const { env, handler } = createTestApi();
    const session = await login(handler, env);
    expect(session.profile).toEqual({
      id: "user-1",
      email: "editor@example.com",
      displayName: "새유저",
      avatarIcon: "initial",
    });
    expect(session.token.split(".")).toHaveLength(3);

    const meResponse = await handler.fetch!(
      new Request("https://api.example.com/auth/me", {
        headers: { Authorization: `Bearer ${session.token}`, Origin: ALLOWED_ORIGIN },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toEqual({ profile: session.profile });

    const updateResponse = await handler.fetch!(
      new Request("https://api.example.com/auth/profile", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
          Origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ displayName: "  새   이름  ", avatarIcon: "leaf" }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toEqual({
      profile: { ...session.profile, displayName: "새 이름", avatarIcon: "leaf" },
    });
  });

  it("preserves a user-chosen display name on a later Google login", async () => {
    const { env, handler } = createTestApi();
    const firstSession = await login(handler, env);
    await handler.fetch!(
      new Request("https://api.example.com/auth/profile", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${firstSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "내가 정한 이름", avatarIcon: "hidden" }),
      }),
      env as Env,
      {} as ExecutionContext,
    );

    const secondSession = await login(handler, env);
    expect(secondSession.profile.displayName).toBe("내가 정한 이름");
    expect(secondSession.profile.avatarIcon).toBe("hidden");
    expect(secondSession.profile.id).toBe(firstSession.profile.id);
  });

  it("rejects missing sessions and disallowed origins", async () => {
    const { env, handler } = createTestApi();
    const missingSession = await handler.fetch!(
      new Request("https://api.example.com/auth/me"),
      env as Env,
      {} as ExecutionContext,
    );
    expect(missingSession.status).toBe(401);

    const disallowedOrigin = await handler.fetch!(
      new Request("https://api.example.com/auth/me", {
        headers: { Origin: "https://evil.example" },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(disallowedOrigin.status).toBe(403);
  });

  it("rejects bodies larger than the configured limit", async () => {
    const { env, handler } = createTestApi();
    const response = await handler.fetch!(
      new Request("https://api.example.com/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "x".repeat(21_000) }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(413);
  });

  it("reports whether the request IP is allowlisted for developer diagnostics", async () => {
    const { env, handler } = createTestApi();
    const developerResponse = await handler.fetch!(
      new Request("https://api.example.com/health", {
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "14.35.239.105" },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect((await developerResponse.json() as { developerDebug: boolean }).developerDebug).toBe(true);

    const regularResponse = await handler.fetch!(
      new Request("https://api.example.com/health", {
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "192.0.2.1" },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect((await regularResponse.json() as { developerDebug: boolean }).developerDebug).toBe(false);
  });

  it("runs detailed D1 diagnostics only for the allowlisted developer IP", async () => {
    const { env, handler } = createTestApi();
    const database = {
      prepare(query: string) {
        return {
          all: async () => query.includes("sqlite_master")
            ? { results: [{ name: "d1_migrations" }, { name: "image_assets" }, { name: "maps" }, { name: "users" }] }
            : { results: [] },
          first: async () => ({ count: query.includes("d1_migrations") ? 5 : 2 }),
        };
      },
    } as unknown as D1Database;

    const response = await handler.fetch!(
      new Request("https://api.example.com/health?d1=1", {
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "14.35.239.105" },
      }),
      { ...env, DB: database } as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      storage: string;
      tables: Array<{ name: string; exists: boolean; rowCount: number }>;
      migrationTable: { exists: boolean; rowCount: number };
    };
    expect(body.ok).toBe(true);
    expect(body.storage).toBe("d1");
    expect(body.tables).toEqual([
      { name: "users", exists: true, rowCount: 2 },
      { name: "image_assets", exists: true, rowCount: 2 },
      { name: "maps", exists: true, rowCount: 2 },
    ]);
    expect(body.migrationTable).toEqual({ name: "d1_migrations", exists: true, rowCount: 5 });

    const nonDeveloperResponse = await handler.fetch!(
      new Request("https://api.example.com/health?d1=1", {
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "192.0.2.1" },
      }),
      { ...env, DB: database } as Env,
      {} as ExecutionContext,
    );
    expect(nonDeveloperResponse.status).toBe(404);
  });

  it("returns extra login diagnostics only to the allowlisted developer IP", async () => {
    const { env, handler } = createTestApi();
    const response = await handler.fetch!(
      new Request("https://api.example.com/auth/google", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ALLOWED_ORIGIN,
          "CF-Connecting-IP": "14.35.239.105",
        },
        body: JSON.stringify({ credential: "x".repeat(20_001) }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(413);
    const body = await response.json() as {
      error: { code: string; debug?: { status: number; path: string } };
    };
    expect(body.error.code).toBe("BODY_TOO_LARGE");
    expect(body.error.debug?.status).toBe(413);
    expect(body.error.debug?.path).toBe("/auth/google");

    const nonDeveloperResponse = await handler.fetch!(
      new Request("https://api.example.com/auth/google", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ALLOWED_ORIGIN,
          "CF-Connecting-IP": "192.0.2.1",
        },
        body: JSON.stringify({ credential: "x".repeat(20_001) }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    const nonDeveloperBody = await nonDeveloperResponse.json() as {
      error: { debug?: unknown };
    };
    expect(nonDeveloperBody.error.debug).toBeUndefined();
  });

  it("allows the developer IP to list users and promote an existing user", async () => {
    const { env, handler } = createTestApi();
    const firstSession = await login(handler, env);
    const secondSession = await login(handler, env, "second-google-credential");

    const listResponse = await handler.fetch!(
      new Request("https://api.example.com/admin/users", {
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "14.35.239.105" },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      users: [
        { ...firstSession.profile, isAdmin: false },
        { ...secondSession.profile, isAdmin: false },
      ],
    });

    const promoteResponse = await handler.fetch!(
      new Request(`https://api.example.com/admin/users/${encodeURIComponent(secondSession.profile.id)}/admin`, {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "14.35.239.105" },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(promoteResponse.status).toBe(200);
    expect(await promoteResponse.json()).toEqual({
      user: { ...secondSession.profile, isAdmin: true },
    });
  });

  it("allows admins but rejects unauthenticated and regular users", async () => {
    const { env, handler, users } = createTestApi();
    const regularSession = await login(handler, env);
    const adminSession = await login(handler, env, "admin-google-credential");
    users.admins.add(adminSession.profile.id);

    const regularResponse = await handler.fetch!(
      new Request("https://api.example.com/admin/users", {
        headers: { Authorization: `Bearer ${regularSession.token}`, Origin: ALLOWED_ORIGIN },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(regularResponse.status).toBe(403);
    expect((await regularResponse.json() as { error: { code: string } }).error.code).toBe("ADMIN_REQUIRED");

    const missingResponse = await handler.fetch!(
      new Request("https://api.example.com/admin/users", { headers: { Origin: ALLOWED_ORIGIN } }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(missingResponse.status).toBe(401);

    const adminResponse = await handler.fetch!(
      new Request("https://api.example.com/admin/users", {
        headers: { Authorization: `Bearer ${adminSession.token}`, Origin: ALLOWED_ORIGIN },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(adminResponse.status).toBe(200);
  });

  it("does not reveal whether a user exists to an unauthorized request", async () => {
    const { env, handler } = createTestApi();
    const response = await handler.fetch!(
      new Request("https://api.example.com/admin/users/missing/admin", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "192.0.2.1" },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
  });
});

describe("user-owned map and image APIs", () => {
  it("requires a session for private maps and images", async () => {
    const { env, handler } = createTestApi();
    for (const path of ["/maps", "/images"]) {
      const response = await handler.fetch!(
        new Request(`https://api.example.com${path}`),
        env as Env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(401);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
    }
  });

  it("saves a JSON map payload and returns only the owner's map data", async () => {
    const { env, handler } = createTestApi();
    const session = await login(handler, env);
    expect(normalizeMapPayload('{"width":2,"height":3}').payloadBytes).toBeGreaterThan(0);

    const saveResponse = await handler.fetch!(
      new Request("https://api.example.com/maps", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "First map", payload: { width: 2, height: 3 } }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(saveResponse.status).toBe(201);
    const saved = (await saveResponse.json()) as { map: MapDocument };
    expect(saved.map.name).toBe("First map");
    expect(saved.map.payload).toEqual({ width: 2, height: 3 });

    const updateResponse = await handler.fetch!(
      new Request(`https://api.example.com/maps/${saved.map.id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Updated map", payload: { width: 4, height: 5 } }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as { map: MapDocument };
    expect(updated.map.id).toBe(saved.map.id);
    expect(updated.map.name).toBe("Updated map");
    expect(updated.map.payload).toEqual({ width: 4, height: 5 });

    const listResponse = await handler.fetch!(
      new Request("https://api.example.com/maps", {
        headers: { Authorization: `Bearer ${session.token}` },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ maps: [updated.map] });

    const singleResponse = await handler.fetch!(
      new Request(`https://api.example.com/maps/${saved.map.id}`, {
        headers: { Authorization: `Bearer ${session.token}` },
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(singleResponse.status).toBe(200);
    expect(await singleResponse.json()).toEqual({ map: updated.map });
  });

  it("returns upstream image failure details only to allowlisted developers", async () => {
    const { env, handler } = createTestApi();
    const session = await login(handler, env);
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      code: "INVALID_IMAGE",
      message: "The image decoder rejected the file.",
      token: env.MEME_UPLOAD_TOKEN,
    }, { status: 422, statusText: "Unprocessable Entity" }));

    const makeUploadRequest = (ip: string) => new Request("https://api.example.com/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "image/png",
        "Content-Length": "3",
        "Idempotency-Key": `failed-upload-${ip}`,
        "X-Original-Filename": "map.png",
        "CF-Connecting-IP": ip,
      },
      body: Uint8Array.from([1, 2, 3]),
    });

    try {
      const developerResponse = await handler.fetch!(
        makeUploadRequest("14.35.239.105") as Parameters<NonNullable<typeof handler.fetch>>[0],
        env as Env,
        {} as ExecutionContext,
      );
      expect(developerResponse.status).toBe(502);
      const developerBody = await developerResponse.json() as {
        error: {
          code: string;
          message: string;
          debug?: {
            status: number;
            upstreamStatus?: number;
            upstreamStatusText?: string;
            upstreamBody?: string;
          };
        };
      };
      expect(developerBody.error).toMatchObject({
        code: "IMAGE_SERVICE_UNAVAILABLE",
        message: "The image service could not accept the image.",
        debug: {
          status: 502,
          upstreamStatus: 422,
          upstreamStatusText: "Unprocessable Entity",
          upstreamBody: expect.stringContaining("The image decoder rejected the file."),
        },
      });
      expect(developerBody.error.debug?.upstreamBody).not.toContain(env.MEME_UPLOAD_TOKEN);

      const regularResponse = await handler.fetch!(
        makeUploadRequest("192.0.2.1") as Parameters<NonNullable<typeof handler.fetch>>[0],
        env as Env,
        {} as ExecutionContext,
      );
      expect(regularResponse.status).toBe(502);
      const regularBody = await regularResponse.json() as { error: { debug?: unknown } };
      expect(regularBody.error.debug).toBeUndefined();
    } finally {
      upstream.mockRestore();
    }
  });

  it("streams an image upload to the meme service and lists its own metadata", async () => {
    const { env, handler } = createTestApi();
    const session = await login(handler, env);
    const hash = "a".repeat(64);
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://meme-admin.devtuna.win/internal/v1/blobs");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${env.MEME_UPLOAD_TOKEN}`);
      expect(headers.get("Content-Type")).toBe("image/png");
      expect(headers.get("Content-Length")).toBe("3");
      expect(headers.has("Idempotency-Key")).toBe(false);
      expect(headers.has("X-Original-Filename")).toBe(false);
      expect(init?.body).toBeTruthy();
      return Response.json({
        hash,
        extension: "png",
        mimeType: "image/png",
        size: 3,
        deduplicated: false,
      }, { status: 201 });
    });

    try {
      const uploadResponse = await handler.fetch!(
        new Request("https://api.example.com/images", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.token}`,
            "Content-Type": "image/png",
            "Content-Length": "3",
            "Idempotency-Key": "upload-1",
            "X-Original-Filename": "map.png",
          },
          body: Uint8Array.from([1, 2, 3]),
        }),
        env as Env,
        {} as ExecutionContext,
      );
      expect(uploadResponse.status).toBe(201);
      const uploaded = (await uploadResponse.json()) as { image: ImageAsset; reused: boolean };
      expect(uploaded.reused).toBe(false);
      expect(uploaded.image.originalFilename).toBe("map.png");

      const retryResponse = await handler.fetch!(
        new Request("https://api.example.com/images", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.token}`,
            "Content-Type": "image/png",
            "Content-Length": "3",
            "Idempotency-Key": "upload-1",
            "X-Original-Filename": "map.png",
          },
          body: Uint8Array.from([1, 2, 3]),
        }),
        env as Env,
        {} as ExecutionContext,
      );
      expect(retryResponse.status).toBe(200);
      expect((await retryResponse.json() as { reused: boolean }).reused).toBe(true);
      expect(upstream).toHaveBeenCalledTimes(1);

      const listResponse = await handler.fetch!(
        new Request("https://api.example.com/images", {
          headers: { Authorization: `Bearer ${session.token}` },
        }),
        env as Env,
        {} as ExecutionContext,
      );
      expect(listResponse.status).toBe(200);
      expect((await listResponse.json() as { images: ImageAsset[] }).images).toHaveLength(1);
    } finally {
      upstream.mockRestore();
    }
  });

  it("validates meme origin metadata and derives public image URLs", () => {
    const hash = "b".repeat(64);
    expect(validateMemeImageResponse({
      hash,
      extension: "png",
      mimeType: "image/png",
      size: 1024,
      deduplicated: true,
    }, "https://meme.devtuna.win")).toEqual({
      hash,
      extension: "png",
      mimeType: "image/png",
      byteSize: 1024,
      originalUrl: `https://meme.devtuna.win/i/${hash}.png`,
      thumbnailUrl: `https://meme.devtuna.win/t/${hash}`,
    });
  });
});
