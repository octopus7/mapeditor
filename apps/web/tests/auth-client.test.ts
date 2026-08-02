import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthApiError,
  AuthClient,
  normalizeApiBaseUrl,
  parsePublicAppConfig,
} from "../src/auth-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public app configuration", () => {
  it("normalizes the API origin and Google client ID", () => {
    expect(parsePublicAppConfig({
      apiBaseUrl: " https://api.example.com/ ",
      googleClientId: " client-id.apps.googleusercontent.com ",
    })).toEqual({
      apiBaseUrl: "https://api.example.com",
      googleClientId: "client-id.apps.googleusercontent.com",
    });
  });

  it("allows an HTTP localhost API", () => {
    expect(normalizeApiBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
  });

  it("rejects an insecure remote API", () => {
    expect(() => normalizeApiBaseUrl("http://example.com")).toThrow("HTTPS");
  });

  it("rejects a non-object configuration", () => {
    expect(() => parsePublicAppConfig(null)).toThrow("형식");
  });
});

describe("AuthClient", () => {
  it("exchanges a Google credential for an app session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: "session-token",
      profile: { id: "user-1", email: "user@example.com", displayName: "숲지기", avatarIcon: "pine" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const session = await new AuthClient("https://api.example.com").login("google-id-token");

    expect(session.profile.displayName).toBe("숲지기");
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/auth/google", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ credential: "google-id-token" }),
    }));
  });

  it("updates only the signed-in user's display name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: { id: "user-1", email: "user@example.com", displayName: "새 이름", avatarIcon: "hidden" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new AuthClient("https://api.example.com").updateProfile("session-token", "새 이름", "hidden");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ displayName: "새 이름", avatarIcon: "hidden" }));
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer session-token");
  });

  it("accepts a no-content logout response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AuthClient("https://api.example.com").logout("session-token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/auth/logout", expect.objectContaining({ method: "POST" }));
  });

  it("exposes structured API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "INVALID_NAME", message: "표시 이름이 올바르지 않습니다." },
    }), { status: 400, headers: { "Content-Type": "application/json" } })));

    const request = new AuthClient("https://api.example.com").updateProfile("session-token", "", "initial");
    await expect(request).rejects.toBeInstanceOf(AuthApiError);
    await expect(request).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: "INVALID_NAME",
      message: "표시 이름이 올바르지 않습니다.",
    }));
  });

  it("preserves developer-only API diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "INVALID_GOOGLE_TOKEN",
        message: "Google 로그인 정보를 확인할 수 없습니다.",
        debug: {
          requestId: "ray-123",
          method: "POST",
          path: "/auth/google",
          status: 401,
          cause: "JWTClaimValidationFailed: unexpected aud claim",
        },
      },
    }), { status: 401, headers: { "Content-Type": "application/json" } })));

    const request = new AuthClient("https://api.example.com").login("google-id-token");
    await expect(request).rejects.toEqual(expect.objectContaining({
      code: "INVALID_GOOGLE_TOKEN",
      debug: expect.objectContaining({ requestId: "ray-123", cause: expect.stringContaining("aud") }),
    }));
  });
});
