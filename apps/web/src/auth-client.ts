export const AVATAR_ICONS = ["initial", "hidden", "leaf", "pine", "water", "stone"] as const;
export type AvatarIcon = typeof AVATAR_ICONS[number];

export interface AuthProfile {
  id: string;
  email: string;
  displayName: string;
  avatarIcon: AvatarIcon;
}

export interface AuthSession {
  profile: AuthProfile;
  token: string;
}

export interface AdminUser extends AuthProfile {
  isAdmin: boolean;
}

export interface AdminMapSummary {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminMap extends AdminMapSummary {
  payload: unknown;
}

export interface PublicAppConfig {
  apiBaseUrl: string;
  googleClientId: string;
}

interface ApiErrorBody {
  error?: string | {
    code?: string;
    message?: string;
    debug?: AuthDebugDetails;
  };
  message?: string;
}

export interface AuthDebugDetails {
  requestId: string;
  method: string;
  path: string;
  status: number;
  cause?: string;
}

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly debug?: AuthDebugDetails,
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

  async updateProfile(
    token: string,
    displayName: string,
    avatarIcon: AvatarIcon,
  ): Promise<{ profile: AuthProfile }> {
    return this.request("/auth/profile", {
      method: "PUT",
      headers: this.authHeaders(token),
      body: JSON.stringify({ displayName, avatarIcon }),
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
        nestedError?.debug,
      );
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export class AdminClient {
  constructor(private readonly baseUrl: string) {}

  async listUsers(token?: string): Promise<AdminUser[]> {
    const response = await this.request<{ users: AdminUser[] }>("/admin/users", token);
    if (!Array.isArray(response.users)) throw new Error("The administrator API returned an invalid user list.");
    return response.users;
  }

  async promoteUser(userId: string, token?: string): Promise<AdminUser> {
    const response = await this.request<{ user: AdminUser }>(
      `/admin/users/${encodeURIComponent(userId)}/admin`,
      token,
      { method: "POST" },
    );
    return response.user;
  }

  async listMaps(userId: string, token?: string): Promise<AdminMapSummary[]> {
    const response = await this.request<{ maps: AdminMapSummary[] }>(
      `/admin/users/${encodeURIComponent(userId)}/maps`,
      token,
    );
    if (!Array.isArray(response.maps)) throw new Error("The administrator API returned an invalid map list.");
    return response.maps;
  }

  async loadMap(userId: string, mapId: string, token?: string): Promise<AdminMap> {
    const response = await this.request<{ map: AdminMap }>(
      `/admin/users/${encodeURIComponent(userId)}/maps/${encodeURIComponent(mapId)}`,
      token,
    );
    return response.map;
  }

  private async request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ApiErrorBody;
      const nestedError = typeof body.error === "object" ? body.error : undefined;
      throw new AuthApiError(
        response.status,
        nestedError?.code ?? (typeof body.error === "string" ? body.error : "REQUEST_FAILED"),
        nestedError?.message ?? body.message ?? "Administrator API request failed.",
        nestedError?.debug,
      );
    }
    return response.json() as Promise<T>;
  }
}

export function isAvatarIcon(value: unknown): value is AvatarIcon {
  return typeof value === "string" && AVATAR_ICONS.includes(value as AvatarIcon);
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
