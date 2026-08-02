export interface AuthProfile {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthSession {
  profile: AuthProfile;
  token: string;
}

export interface PublicAppConfig {
  apiBaseUrl: string;
  googleClientId: string;
}

interface ApiErrorBody {
  error?: string | {
    code?: string;
    message?: string;
  };
  message?: string;
}

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export class AuthClient {
  constructor(private readonly baseUrl: string) {}

  async login(credential: string): Promise<AuthSession> {
    return this.request("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
  }

  async me(token: string): Promise<{ profile: AuthProfile }> {
    return this.request("/auth/me", { headers: this.authHeaders(token) });
  }

  async updateProfile(token: string, displayName: string): Promise<{ profile: AuthProfile }> {
    return this.request("/auth/profile", {
      method: "PUT",
      headers: this.authHeaders(token),
      body: JSON.stringify({ displayName }),
    });
  }

  async logout(token: string): Promise<void> {
    await this.request("/auth/logout", {
      method: "POST",
      headers: this.authHeaders(token),
    });
  }

  private authHeaders(token: string): HeadersInit {
    return { Authorization: `Bearer ${token}` };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ApiErrorBody;
      const nestedError = typeof body.error === "object" ? body.error : undefined;
      throw new AuthApiError(
        response.status,
        nestedError?.code ?? (typeof body.error === "string" ? body.error : "REQUEST_FAILED"),
        nestedError?.message ?? body.message ?? "로그인 서버 요청에 실패했습니다.",
      );
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const url = new URL(trimmed);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("로그인 API 주소는 HTTPS여야 합니다.");
  }
  return url.origin;
}

export function normalizeGoogleClientId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function parsePublicAppConfig(value: unknown): PublicAppConfig {
  if (!value || typeof value !== "object") {
    throw new Error("앱 설정 파일 형식이 올바르지 않습니다.");
  }
  const candidate = value as Record<string, unknown>;
  return {
    apiBaseUrl: normalizeApiBaseUrl(candidate.apiBaseUrl),
    googleClientId: normalizeGoogleClientId(candidate.googleClientId),
  };
}
