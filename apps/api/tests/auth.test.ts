import { describe, expect, it } from "vitest";
import {
  createApiHandler,
  DEFAULT_DISPLAY_NAME,
  parseAllowedOrigins,
  validateDisplayName,
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
    };
    this.subjects.set(identity.subject, profile.id);
    this.profiles.set(profile.id, profile);
    return profile;
  }

  async updateDisplayName(id: string, displayName: string): Promise<Profile | null> {
    const existing = this.profiles.get(id);
    if (!existing) return null;
    const profile = { ...existing, displayName };
    this.profiles.set(id, profile);
    return profile;
  }
}

function createTestApi() {
  const users = new InMemoryUserRepository();
  const handler = createApiHandler({
    createUserRepository: () => users,
    verifyGoogleCredential: async () => ({
      subject: "google-subject-1",
      email: "editor@example.com",
    }),
  });
  const env = {
    ALLOWED_ORIGINS,
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    SESSION_SECRET,
  } satisfies Omit<Env, "DB">;
  return { env, handler, users };
}

async function login(
  handler: ReturnType<typeof createApiHandler>,
  env: Omit<Env, "DB">,
): Promise<{ token: string; profile: Profile }> {
  const response = await handler.fetch!(
    new Request("https://api.example.com/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ credential: "test-google-credential" }),
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

  it("parses the exact CORS allow list", () => {
    const origins = parseAllowedOrigins(`${ALLOWED_ORIGIN}, http://localhost:4173`);
    expect(origins.has(ALLOWED_ORIGIN)).toBe(true);
    expect(origins.has("http://localhost:4173")).toBe(true);
    expect(origins.has("https://example.com")).toBe(false);
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
        body: JSON.stringify({ displayName: "  새   이름  " }),
      }),
      env as Env,
      {} as ExecutionContext,
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toEqual({
      profile: { ...session.profile, displayName: "새 이름" },
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
        body: JSON.stringify({ displayName: "내가 정한 이름" }),
      }),
      env as Env,
      {} as ExecutionContext,
    );

    const secondSession = await login(handler, env);
    expect(secondSession.profile.displayName).toBe("내가 정한 이름");
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
});
