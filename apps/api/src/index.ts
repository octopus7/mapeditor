import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const SESSION_ISSUER = "mapeditor-api";
const SESSION_AUDIENCE = "mapedit.pages.dev";
const SESSION_TTL = "7d";
const MAX_BODY_BYTES = 20_000;
const MAX_CREDENTIAL_BYTES = 10_000;
const MAX_DISPLAY_NAME_LENGTH = 40;
export const DEFAULT_DISPLAY_NAME = "새유저";
export const AVATAR_ICONS = ["initial", "hidden", "leaf", "pine", "water", "stone"] as const;
export type AvatarIcon = typeof AVATAR_ICONS[number];

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  avatarIcon: AvatarIcon;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
}

export interface UserRepository {
  findById(id: string): Promise<Profile | null>;
  saveGoogleLogin(identity: GoogleIdentity): Promise<Profile>;
  updateProfile(id: string, displayName: string, avatarIcon: AvatarIcon): Promise<Profile | null>;
}

interface Dependencies {
  createUserRepository(database: D1Database): UserRepository;
  verifyGoogleCredential(credential: string, clientId: string): Promise<GoogleIdentity>;
}

interface GoogleCredentialBody {
  credential?: unknown;
}

interface ProfileUpdateBody {
  displayName?: unknown;
  avatarIcon?: unknown;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_icon: AvatarIcon;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class D1UserRepository implements UserRepository {
  constructor(private readonly database: D1Database) {}

  async findById(id: string): Promise<Profile | null> {
    const row = await this.database
      .prepare("SELECT id, email, display_name, avatar_icon FROM users WHERE id = ?1")
      .bind(id)
      .first<UserRow>();
    return row ? profileFromRow(row) : null;
  }

  async saveGoogleLogin(identity: GoogleIdentity): Promise<Profile> {
    const row = await this.database
      .prepare(
        `INSERT INTO users (id, google_subject, email, display_name)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (google_subject) DO UPDATE SET
           email = excluded.email,
           last_login_at = CURRENT_TIMESTAMP
         RETURNING id, email, display_name, avatar_icon`,
      )
      .bind(
        crypto.randomUUID(),
        identity.subject,
        identity.email,
        DEFAULT_DISPLAY_NAME,
      )
      .first<UserRow>();

    if (!row) {
      throw new ApiError(500, "USER_SAVE_FAILED", "사용자 정보를 저장하지 못했습니다.");
    }
    return profileFromRow(row);
  }

  async updateProfile(
    id: string,
    displayName: string,
    avatarIcon: AvatarIcon,
  ): Promise<Profile | null> {
    const row = await this.database
      .prepare(
        `UPDATE users
         SET display_name = ?1, avatar_icon = ?2, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?3
         RETURNING id, email, display_name, avatar_icon`,
      )
      .bind(displayName, avatarIcon, id)
      .first<UserRow>();
    return row ? profileFromRow(row) : null;
  }
}

function profileFromRow(row: UserRow): Profile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarIcon: row.avatar_icon,
  };
}

export function parseAllowedOrigins(value: string): Set<string> {
  return new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function normalizeDisplayName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function displayNameLength(value: string): number {
  return Array.from(value).length;
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_DISPLAY_NAME", "표시 이름을 입력해 주세요.");
  }
  const normalized = normalizeDisplayName(value);
  const length = displayNameLength(normalized);
  if (length < 1 || length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError(
      400,
      "INVALID_DISPLAY_NAME",
      `표시 이름은 1자 이상 ${MAX_DISPLAY_NAME_LENGTH}자 이하로 입력해 주세요.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ApiError(400, "INVALID_DISPLAY_NAME", "표시 이름에 제어 문자를 사용할 수 없습니다.");
  }
  return normalized;
}

export function validateAvatarIcon(value: unknown): AvatarIcon {
  if (typeof value !== "string" || !AVATAR_ICONS.includes(value as AvatarIcon)) {
    throw new ApiError(400, "INVALID_AVATAR_ICON", "프로필 아이콘 설정이 올바르지 않습니다.");
  }
  return value as AvatarIcon;
}

type CorsHeaders = Record<string, string>;

function corsHeaders(origin: string | null, allowedOrigins: Set<string>): CorsHeaders {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(value, { status, headers: responseHeaders });
}

async function readLimitedText(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "BODY_TOO_LARGE", "요청 본문이 너무 큽니다.");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE", "요청 본문이 너무 큽니다.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readJson<T>(request: Request): Promise<T> {
  const text = await readLimitedText(request);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "올바른 JSON 요청이 아닙니다.");
  }
}

function sessionKey(secret: string): Uint8Array {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "로그인 설정이 완료되지 않았습니다.");
  }
  return new TextEncoder().encode(secret);
}

async function createSessionToken(userId: string, secret: string): Promise<string> {
  return new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(SESSION_TTL)
    .sign(sessionKey(secret));
}

async function readSessionUserId(request: Request, secret: string): Promise<string> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  }
  try {
    const { payload } = await jwtVerify(authorization.slice(7), sessionKey(secret), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string") {
      throw new ApiError(401, "INVALID_SESSION", "로그인 세션이 올바르지 않습니다.");
    }
    return payload.sub;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_SESSION", "로그인 세션이 만료되었거나 올바르지 않습니다.");
  }
}

export async function verifyGoogleCredential(
  credential: string,
  clientId: string,
): Promise<GoogleIdentity> {
  try {
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      audience: clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      algorithms: ["RS256"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      payload.email_verified !== true
    ) {
      throw new ApiError(401, "INVALID_GOOGLE_ACCOUNT", "확인된 Google 계정 정보가 필요합니다.");
    }
    return {
      subject: payload.sub,
      email: payload.email,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Google 로그인 정보를 확인할 수 없습니다.");
  }
}

async function requireProfile(
  request: Request,
  env: Env,
  users: UserRepository,
): Promise<Profile> {
  const userId = await readSessionUserId(request, env.SESSION_SECRET);
  const profile = await users.findById(userId);
  if (!profile) {
    throw new ApiError(401, "INVALID_SESSION", "로그인 계정을 찾을 수 없습니다.");
  }
  return profile;
}

async function route(
  request: Request,
  env: Env,
  dependencies: Dependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const users = dependencies.createUserRepository(env.DB);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "mapeditor-api", storage: "d1" });
  }
  if (request.method === "POST" && url.pathname === "/auth/google") {
    const body = await readJson<GoogleCredentialBody>(request);
    if (
      typeof body.credential !== "string" ||
      new TextEncoder().encode(body.credential).byteLength > MAX_CREDENTIAL_BYTES
    ) {
      throw new ApiError(400, "INVALID_CREDENTIAL", "Google 로그인 정보가 없습니다.");
    }
    const identity = await dependencies.verifyGoogleCredential(
      body.credential,
      env.GOOGLE_CLIENT_ID,
    );
    const profile = await users.saveGoogleLogin(identity);
    const token = await createSessionToken(profile.id, env.SESSION_SECRET);
    return json({ token, profile });
  }
  if (request.method === "GET" && url.pathname === "/auth/me") {
    return json({ profile: await requireProfile(request, env, users) });
  }
  if (request.method === "PUT" && url.pathname === "/auth/profile") {
    const currentProfile = await requireProfile(request, env, users);
    const body = await readJson<ProfileUpdateBody>(request);
    const profile = await users.updateProfile(
      currentProfile.id,
      validateDisplayName(body.displayName),
      validateAvatarIcon(body.avatarIcon),
    );
    if (!profile) {
      throw new ApiError(401, "INVALID_SESSION", "로그인 계정을 찾을 수 없습니다.");
    }
    return json({ profile });
  }
  if (request.method === "POST" && url.pathname === "/auth/logout") {
    await readSessionUserId(request, env.SESSION_SECRET);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  throw new ApiError(404, "NOT_FOUND", "요청한 API를 찾을 수 없습니다.");
}

export function createApiHandler(dependencies: Dependencies): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const origin = request.headers.get("Origin");
      const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
      const cors = corsHeaders(origin, allowedOrigins);

      if (origin && !allowedOrigins.has(origin)) {
        return json(
          { error: { code: "ORIGIN_NOT_ALLOWED", message: "허용되지 않은 출처입니다." } },
          403,
          { Vary: "Origin" },
        );
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      try {
        const response = await route(request, env, dependencies);
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(cors)) headers.set(key, value);
        return new Response(response.body, { status: response.status, headers });
      } catch (error) {
        if (error instanceof ApiError) {
          return json({ error: { code: error.code, message: error.message } }, error.status, cors);
        }
        console.error(JSON.stringify({
          event: "request_failed",
          method: request.method,
          path: new URL(request.url).pathname,
        }));
        return json(
          { error: { code: "INTERNAL_ERROR", message: "서버 요청을 처리하지 못했습니다." } },
          500,
          cors,
        );
      }
    },
  };
}

export default createApiHandler({
  createUserRepository: (database) => new D1UserRepository(database),
  verifyGoogleCredential,
});
