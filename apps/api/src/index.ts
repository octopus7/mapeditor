import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const SESSION_ISSUER = "mapeditor-api";
const SESSION_AUDIENCE = "mapedit.pages.dev";
const SESSION_TTL = "7d";
const MAX_BODY_BYTES = 20_000;
const MAX_MAP_PAYLOAD_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 10_000_000;
const MAX_IMAGE_RESPONSE_BYTES = 100_000;
const MAX_CREDENTIAL_BYTES = 10_000;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_MAP_NAME_LENGTH = 120;
const MAX_LIST_ITEMS = 100;
export const DEFAULT_DISPLAY_NAME = "새유저";
export const AVATAR_ICONS = ["initial", "hidden", "leaf", "pine", "water", "stone"] as const;
export type AvatarIcon = typeof AVATAR_ICONS[number];
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"] as const;
type ImageMimeType = typeof IMAGE_MIME_TYPES[number];
type ImageExtension = typeof IMAGE_EXTENSIONS[number];

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

export interface ImageAsset {
  id: string;
  originalFilename: string;
  hash: string;
  extension: ImageExtension;
  mimeType: ImageMimeType;
  byteSize: number;
  originalUrl: string;
  thumbnailUrl: string;
  createdAt: string;
}

export interface ImageAssetInput extends ImageAsset {
  ownerUserId: string;
  idempotencyKey: string;
}

export interface ImageAssetRepository {
  findByIdempotencyKey(ownerUserId: string, idempotencyKey: string): Promise<ImageAsset | null>;
  create(input: ImageAssetInput): Promise<ImageAsset>;
  listByOwner(ownerUserId: string, limit: number): Promise<ImageAsset[]>;
}

export interface MapDocument {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MapDocumentInput {
  id: string;
  ownerUserId: string;
  name: string;
  payloadJson: string;
  payloadBytes: number;
}

export interface MapRepository {
  create(input: MapDocumentInput): Promise<MapDocument>;
  update(ownerUserId: string, id: string, name: string, payloadJson: string, payloadBytes: number): Promise<MapDocument | null>;
  listByOwner(ownerUserId: string, limit: number): Promise<MapDocument[]>;
  findById(ownerUserId: string, id: string): Promise<MapDocument | null>;
}

interface Dependencies {
  createUserRepository(database: D1Database): UserRepository;
  verifyGoogleCredential(credential: string, clientId: string): Promise<GoogleIdentity>;
  createImageRepository?(database: D1Database): ImageAssetRepository;
  createMapRepository?(database: D1Database): MapRepository;
}

interface GoogleCredentialBody {
  credential?: unknown;
}

interface ProfileUpdateBody {
  displayName?: unknown;
  avatarIcon?: unknown;
}

interface ImageAssetRow {
  id: string;
  owner_user_id: string;
  idempotency_key: string;
  original_filename: string;
  hash: string;
  extension: ImageExtension;
  mime_type: ImageMimeType;
  byte_size: number;
  original_url: string;
  thumbnail_url: string;
  created_at: string;
}

interface MapRow {
  id: string;
  owner_user_id: string;
  name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface MapCreateBody {
  name?: unknown;
  payload?: unknown;
}

const D1_DIAGNOSTIC_TABLES = ["users", "image_assets", "maps"] as const;

interface SqliteTableRow {
  name: string;
}

interface SqliteCountRow {
  count: number;
}

interface D1TableDiagnostic {
  name: string;
  exists: boolean;
  rowCount: number | null;
}

async function diagnoseD1(database: D1Database, developerDebug: boolean): Promise<{
  ok: boolean;
  service: string;
  storage: string;
  developerDebug: boolean;
  tables: D1TableDiagnostic[];
  migrationTable: D1TableDiagnostic;
}> {
  const tableResult = await database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all<SqliteTableRow>();
  const tableNames = new Set(tableResult.results.map((row) => row.name));
  const inspectTable = async (name: string): Promise<D1TableDiagnostic> => {
    if (!tableNames.has(name)) return { name, exists: false, rowCount: null };
    const countRow = await database
      .prepare(`SELECT COUNT(*) AS count FROM ${name}`)
      .first<SqliteCountRow>();
    return { name, exists: true, rowCount: countRow?.count ?? null };
  };
  const tables = await Promise.all(D1_DIAGNOSTIC_TABLES.map(inspectTable));
  const migrationTable = await inspectTable("d1_migrations");

  return {
    ok: tables.every((table) => table.exists && table.rowCount !== null),
    service: "mapeditor-api",
    storage: "d1",
    developerDebug,
    tables,
    migrationTable,
  };
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
    readonly source?: unknown,
  ) {
    super(message);
  }
}

class ImageServiceResponseError extends Error {
  constructor(
    readonly upstreamStatus: number,
    readonly upstreamStatusText: string,
    readonly upstreamBody?: string,
  ) {
    super(`The image service returned HTTP ${upstreamStatus} ${upstreamStatusText}.`);
    this.name = "ImageServiceResponseError";
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

class D1ImageAssetRepository implements ImageAssetRepository {
  constructor(private readonly database: D1Database) {}

  async findByIdempotencyKey(ownerUserId: string, idempotencyKey: string): Promise<ImageAsset | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_user_id, idempotency_key, original_filename, hash, extension,
                mime_type, byte_size, original_url, thumbnail_url, created_at
         FROM image_assets
         WHERE owner_user_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(ownerUserId, idempotencyKey)
      .first<ImageAssetRow>();
    return row ? imageAssetFromRow(row) : null;
  }

  async create(input: ImageAssetInput): Promise<ImageAsset> {
    const row = await this.database
      .prepare(
        `INSERT INTO image_assets (
           id, owner_user_id, idempotency_key, original_filename, hash, extension,
           mime_type, byte_size, original_url, thumbnail_url
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         RETURNING id, owner_user_id, idempotency_key, original_filename, hash, extension,
                   mime_type, byte_size, original_url, thumbnail_url, created_at`,
      )
      .bind(
        input.id,
        input.ownerUserId,
        input.idempotencyKey,
        input.originalFilename,
        input.hash,
        input.extension,
        input.mimeType,
        input.byteSize,
        input.originalUrl,
        input.thumbnailUrl,
      )
      .first<ImageAssetRow>();
    if (!row) throw new ApiError(500, "IMAGE_SAVE_FAILED", "The image metadata could not be saved.");
    return imageAssetFromRow(row);
  }

  async listByOwner(ownerUserId: string, limit: number): Promise<ImageAsset[]> {
    const result = await this.database
      .prepare(
        `SELECT id, owner_user_id, idempotency_key, original_filename, hash, extension,
                mime_type, byte_size, original_url, thumbnail_url, created_at
         FROM image_assets
         WHERE owner_user_id = ?1
         ORDER BY created_at DESC, id DESC
         LIMIT ?2`,
      )
      .bind(ownerUserId, limit)
      .all<ImageAssetRow>();
    return result.results.map(imageAssetFromRow);
  }
}

class D1MapRepository implements MapRepository {
  constructor(private readonly database: D1Database) {}

  async create(input: MapDocumentInput): Promise<MapDocument> {
    const row = await this.database
      .prepare(
        `INSERT INTO maps (id, owner_user_id, name, payload_json, payload_bytes)
         VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING id, owner_user_id, name, payload_json, created_at, updated_at`,
      )
      .bind(input.id, input.ownerUserId, input.name, input.payloadJson, input.payloadBytes)
      .first<MapRow>();
    if (!row) throw new ApiError(500, "MAP_SAVE_FAILED", "The map could not be saved.");
    return mapFromRow(row);
  }

  async update(
    ownerUserId: string,
    id: string,
    name: string,
    payloadJson: string,
    payloadBytes: number,
  ): Promise<MapDocument | null> {
    const row = await this.database
      .prepare(
        `UPDATE maps
         SET name = ?1, payload_json = ?2, payload_bytes = ?3, updated_at = CURRENT_TIMESTAMP
         WHERE owner_user_id = ?4 AND id = ?5
         RETURNING id, owner_user_id, name, payload_json, created_at, updated_at`,
      )
      .bind(name, payloadJson, payloadBytes, ownerUserId, id)
      .first<MapRow>();
    return row ? mapFromRow(row) : null;
  }

  async listByOwner(ownerUserId: string, limit: number): Promise<MapDocument[]> {
    const result = await this.database
      .prepare(
        `SELECT id, owner_user_id, name, payload_json, created_at, updated_at
         FROM maps
         WHERE owner_user_id = ?1
         ORDER BY updated_at DESC, id DESC
         LIMIT ?2`,
      )
      .bind(ownerUserId, limit)
      .all<MapRow>();
    return result.results.map(mapFromRow);
  }

  async findById(ownerUserId: string, id: string): Promise<MapDocument | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_user_id, name, payload_json, created_at, updated_at
         FROM maps
         WHERE owner_user_id = ?1 AND id = ?2`,
      )
      .bind(ownerUserId, id)
      .first<MapRow>();
    return row ? mapFromRow(row) : null;
  }
}

function imageAssetFromRow(row: ImageAssetRow): ImageAsset {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    hash: row.hash,
    extension: row.extension,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    originalUrl: row.original_url,
    thumbnailUrl: row.thumbnail_url,
    createdAt: row.created_at,
  };
}

function mapFromRow(row: MapRow): MapDocument {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(500, "MAP_PAYLOAD_INVALID", "The stored map payload is invalid.");
  }
  return {
    id: row.id,
    name: row.name,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export function parseDeveloperDebugIps(value: string): Set<string> {
  return new Set(value.split(",").map((ip) => ip.trim()).filter(Boolean));
}

function isDeveloperDebugRequest(request: Request, env: Env): boolean {
  const clientIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (!clientIp) return false;
  return parseDeveloperDebugIps(env.DEVELOPER_DEBUG_IPS).has(clientIp);
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

export function validateMapName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_MAP_NAME", "A map name is required.");
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const length = Array.from(normalized).length;
  if (length < 1 || length > MAX_MAP_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ApiError(400, "INVALID_MAP_NAME", `A map name must be 1-${MAX_MAP_NAME_LENGTH} characters.`);
  }
  return normalized;
}

export interface NormalizedMapPayload {
  payload: Record<string, unknown>;
  payloadJson: string;
  payloadBytes: number;
}

export function normalizeMapPayload(value: unknown): NormalizedMapPayload {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new ApiError(400, "INVALID_MAP_PAYLOAD", "The map payload must be valid JSON.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "INVALID_MAP_PAYLOAD", "The map payload must be a JSON object.");
  }
  const payloadJson = JSON.stringify(parsed);
  const payloadBytes = new TextEncoder().encode(payloadJson).byteLength;
  if (payloadBytes > MAX_MAP_PAYLOAD_BYTES) {
    throw new ApiError(413, "MAP_PAYLOAD_TOO_LARGE", "The map payload is too large.");
  }
  return {
    payload: parsed as Record<string, unknown>,
    payloadJson,
    payloadBytes,
  };
}

export interface ValidatedMemeImage {
  hash: string;
  extension: ImageExtension;
  mimeType: ImageMimeType;
  byteSize: number;
  originalUrl: string;
  thumbnailUrl: string;
}

function requireHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "The image service origin is invalid.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "The image service origin is invalid.");
  }
  return url.origin;
}

function validateImageUrl(value: unknown, origin: string, pathname: string): string {
  if (typeof value !== "string") {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned invalid metadata.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned an invalid URL.");
  }
  if (url.protocol !== "https:" || url.origin !== origin || url.pathname !== pathname || url.search || url.hash) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned an unsafe URL.");
  }
  return url.toString();
}

export function validateMemeImageResponse(value: unknown, imageOrigin: string): ValidatedMemeImage {
  if (!value || typeof value !== "object") {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned invalid metadata.");
  }
  const response = value as Record<string, unknown>;
  const hash = response.hash;
  const extension = response.extension;
  const mimeType = response.mime_type;
  const byteSize = response.byte_size;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned an invalid hash.");
  }
  if (typeof extension !== "string" || !IMAGE_EXTENSIONS.includes(extension as ImageExtension)) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned an invalid extension.");
  }
  if (typeof mimeType !== "string" || !IMAGE_MIME_TYPES.includes(mimeType as ImageMimeType)) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned an invalid MIME type.");
  }
  if (typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_IMAGE_BYTES) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned an invalid byte size.");
  }
  const origin = requireHttpsOrigin(imageOrigin);
  const originalUrl = validateImageUrl(response.original_url, origin, `/i/${hash}.${extension}`);
  const thumbnailUrl = validateImageUrl(response.thumbnail_url, origin, `/t/${hash}`);
  return {
    hash,
    extension: extension as ImageExtension,
    mimeType: mimeType as ImageMimeType,
    byteSize,
    originalUrl,
    thumbnailUrl,
  };
}

type CorsHeaders = Record<string, string>;

function corsHeaders(origin: string | null, allowedOrigins: Set<string>): CorsHeaders {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Original-Filename",
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

interface DeveloperErrorDetails {
  requestId: string;
  method: string;
  path: string;
  status: number;
  cause?: string;
  upstreamStatus?: number;
  upstreamStatusText?: string;
  upstreamBody?: string;
}

function redactDebugText(value: string, env: Env): string {
  let result = value.slice(0, 500);
  for (const secret of [env.SESSION_SECRET, env.MEME_UPLOAD_TOKEN, env.GOOGLE_CLIENT_ID]) {
    if (secret && secret.length >= 8) result = result.split(secret).join("[redacted]");
  }
  return result;
}

function developerErrorDetails(
  error: unknown,
  request: Request,
  env: Env,
  requestId: string,
): DeveloperErrorDetails {
  const apiError = error instanceof ApiError ? error : null;
  const source = apiError?.source ?? (apiError ? undefined : error);
  const cause = source instanceof Error
    ? `${source.name}: ${redactDebugText(source.message, env)}`
    : source === undefined
      ? undefined
      : redactDebugText(String(source), env);
  const imageServiceError = source instanceof ImageServiceResponseError
    ? source
    : undefined;
  return {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    status: apiError?.status ?? 500,
    ...(cause ? { cause } : {}),
    ...(imageServiceError ? {
      upstreamStatus: imageServiceError.upstreamStatus,
      upstreamStatusText: redactDebugText(imageServiceError.upstreamStatusText, env),
      ...(imageServiceError.upstreamBody
        ? { upstreamBody: redactDebugText(imageServiceError.upstreamBody, env) }
        : {}),
    } : {}),
  };
}

function apiErrorResponse(
  error: unknown,
  request: Request,
  env: Env,
  cors: CorsHeaders,
  debugEnabled: boolean,
  requestId: string,
): Response {
  const apiError = error instanceof ApiError ? error : null;
  const status = apiError?.status ?? 500;
  const code = apiError?.code ?? "INTERNAL_ERROR";
  const message = apiError?.message ?? "서버 요청을 처리하지 못했습니다.";
  const debug = debugEnabled ? developerErrorDetails(error, request, env, requestId) : undefined;
  return json(
    {
      error: {
        code,
        message,
        ...(debug ? { debug } : {}),
      },
    },
    status,
    cors,
  );
}

async function readLimitedText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
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
      if (totalBytes > maxBytes) {
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

async function readJson<T>(request: Request, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const text = await readLimitedText(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "올바른 JSON 요청이 아닙니다.");
  }
}

function listLimit(url: URL): number {
  const value = Number(url.searchParams.get("limit") ?? MAX_LIST_ITEMS);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_ITEMS) {
    throw new ApiError(400, "INVALID_LIMIT", `The limit must be between 1 and ${MAX_LIST_ITEMS}.`);
  }
  return value;
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!value || value.length > 128 || !/^[A-Za-z0-9._~-]+$/u.test(value)) {
    throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "A valid Idempotency-Key is required.");
  }
  return value;
}

function requireOriginalFilename(request: Request): { header: string; value: string } {
  const header = request.headers.get("X-Original-Filename")?.trim() ?? "";
  if (!header || new TextEncoder().encode(header).byteLength > 512) {
    throw new ApiError(400, "INVALID_ORIGINAL_FILENAME", "X-Original-Filename is required.");
  }
  let value = header;
  try {
    value = decodeURIComponent(header);
  } catch {
    throw new ApiError(400, "INVALID_ORIGINAL_FILENAME", "X-Original-Filename is invalid.");
  }
  value = value.replace(/[\\/]/gu, "_").trim();
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || Array.from(value).length > 160) {
    throw new ApiError(400, "INVALID_ORIGINAL_FILENAME", "X-Original-Filename is invalid.");
  }
  return { header, value };
}

function requireImageRequestHeaders(request: Request): {
  contentType: ImageMimeType;
  contentLength: string;
  contentLengthNumber: number;
} {
  const contentType = (request.headers.get("Content-Type")?.split(";", 1)[0] ?? "")
    .trim()
    .toLowerCase();
  if (!IMAGE_MIME_TYPES.includes(contentType as ImageMimeType)) {
    throw new ApiError(400, "INVALID_IMAGE_TYPE", "Only JPEG, PNG, WebP, and GIF images are supported.");
  }
  const contentLength = request.headers.get("Content-Length") ?? "";
  const contentLengthNumber = Number(contentLength);
  if (!/^\d+$/u.test(contentLength) || !Number.isInteger(contentLengthNumber) || contentLengthNumber < 1) {
    throw new ApiError(400, "INVALID_IMAGE_SIZE", "Content-Length is required for image uploads.");
  }
  if (contentLengthNumber > MAX_IMAGE_BYTES) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", "The image is too large.");
  }
  if (!request.body) {
    throw new ApiError(400, "EMPTY_IMAGE", "The image body is empty.");
  }
  return {
    contentType: contentType as ImageMimeType,
    contentLength,
    contentLengthNumber,
  };
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_RESPONSE_BYTES) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service response is too large.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_IMAGE_RESPONSE_BYTES) {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service response is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(502, "IMAGE_SERVICE_INVALID_RESPONSE", "The image service returned invalid JSON.");
  }
}

async function readUpstreamErrorBody(response: Response): Promise<string | undefined> {
  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_RESPONSE_BYTES) {
    return `[response body omitted: larger than ${MAX_IMAGE_RESPONSE_BYTES} bytes]`;
  }

  const text = await response.text().catch(() => "");
  if (!text.trim()) return undefined;
  if (new TextEncoder().encode(text).byteLength > MAX_IMAGE_RESPONSE_BYTES) {
    return `[response body omitted: larger than ${MAX_IMAGE_RESPONSE_BYTES} bytes]`;
  }
  return text.trim();
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
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Google 로그인 정보를 확인할 수 없습니다.", error);
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

function requireRepository<T>(repository: T | undefined, name: string): T {
  if (!repository) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", `${name} storage is not configured.`);
  }
  return repository;
}

async function handleImageUpload(
  request: Request,
  env: Env,
  ownerUserId: string,
  images: ImageAssetRepository,
): Promise<Response> {
  const idempotencyKey = requireIdempotencyKey(request);
  const existing = await images.findByIdempotencyKey(ownerUserId, idempotencyKey);
  if (existing) return json({ image: existing, reused: true });

  const { header: originalFilenameHeader, value: originalFilename } = requireOriginalFilename(request);
  const { contentType, contentLength } = requireImageRequestHeaders(request);
  if (!env.MEME_UPLOAD_TOKEN || new TextEncoder().encode(env.MEME_UPLOAD_TOKEN).byteLength < 32) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "The image upload service is not configured.");
  }
  let uploadUrl: URL;
  try {
    uploadUrl = new URL("/v1/images", env.MEME_UPLOAD_BASE_URL);
  } catch {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "The image upload service URL is invalid.");
  }
  if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "The image upload service URL is invalid.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MEME_UPLOAD_TOKEN}`,
        "Content-Type": contentType,
        "Content-Length": contentLength,
        "Idempotency-Key": idempotencyKey,
        "X-Original-Filename": originalFilenameHeader,
      },
      body: request.body,
    });
  } catch (error) {
    throw new ApiError(502, "IMAGE_SERVICE_UNAVAILABLE", "The image service could not be reached.", error);
  }
  if (!upstream.ok) {
    const upstreamError = new ImageServiceResponseError(
      upstream.status,
      upstream.statusText || "Unknown status",
      await readUpstreamErrorBody(upstream),
    );
    if (upstream.status === 413) {
      throw new ApiError(413, "IMAGE_TOO_LARGE", "The image is too large.", upstreamError);
    }
    if (upstream.status === 429) {
      throw new ApiError(429, "IMAGE_SERVICE_RATE_LIMITED", "The image service is busy.", upstreamError);
    }
    throw new ApiError(502, "IMAGE_SERVICE_UNAVAILABLE", "The image service could not accept the image.", upstreamError);
  }

  let metadata: ValidatedMemeImage;
  try {
    metadata = validateMemeImageResponse(await readUpstreamJson(upstream), env.MEME_IMAGE_ORIGIN);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(error.status, error.code, error.message, error);
    }
    throw error;
  }
  const image: ImageAssetInput = {
    id: crypto.randomUUID(),
    ownerUserId,
    idempotencyKey,
    originalFilename,
    hash: metadata.hash,
    extension: metadata.extension,
    mimeType: metadata.mimeType,
    byteSize: metadata.byteSize,
    originalUrl: metadata.originalUrl,
    thumbnailUrl: metadata.thumbnailUrl,
    createdAt: "",
  };
  try {
    const saved = await images.create(image);
    return json({ image: saved, reused: false }, 201);
  } catch (error) {
    const raced = await images.findByIdempotencyKey(ownerUserId, idempotencyKey);
    if (raced) return json({ image: raced, reused: true });
    throw error;
  }
}

async function route(
  request: Request,
  env: Env,
  dependencies: Dependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const users = dependencies.createUserRepository(env.DB);
  const images = dependencies.createImageRepository?.(env.DB);
  const maps = dependencies.createMapRepository?.(env.DB);

  if (request.method === "GET" && url.pathname === "/health") {
    if (url.searchParams.get("d1") === "1") {
      if (!isDeveloperDebugRequest(request, env)) {
        throw new ApiError(404, "NOT_FOUND", "Not found.");
      }
      try {
        return json(await diagnoseD1(env.DB, true));
      } catch (error) {
        throw new ApiError(503, "D1_DIAGNOSTIC_FAILED", "The D1 diagnostic query failed.", error);
      }
    }
    return json({
      ok: true,
      service: "mapeditor-api",
      storage: "d1",
      developerDebug: isDeveloperDebugRequest(request, env),
    });
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
  if (request.method === "POST" && url.pathname === "/images") {
    const currentProfile = await requireProfile(request, env, users);
    return handleImageUpload(
      request,
      env,
      currentProfile.id,
      requireRepository(images, "Image"),
    );
  }
  if (request.method === "GET" && url.pathname === "/images") {
    const currentProfile = await requireProfile(request, env, users);
    const imageList = await requireRepository(images, "Image").listByOwner(
      currentProfile.id,
      listLimit(url),
    );
    return json({ images: imageList });
  }
  if (request.method === "POST" && url.pathname === "/maps") {
    const currentProfile = await requireProfile(request, env, users);
    const body = await readJson<MapCreateBody>(request, MAX_BODY_BYTES + MAX_MAP_PAYLOAD_BYTES);
    const normalizedPayload = normalizeMapPayload(body.payload);
    const savedMap = await requireRepository(maps, "Map").create({
      id: crypto.randomUUID(),
      ownerUserId: currentProfile.id,
      name: validateMapName(body.name),
      payloadJson: normalizedPayload.payloadJson,
      payloadBytes: normalizedPayload.payloadBytes,
    });
    return json({ map: savedMap }, 201);
  }
  if (request.method === "GET" && url.pathname === "/maps") {
    const currentProfile = await requireProfile(request, env, users);
    const mapList = await requireRepository(maps, "Map").listByOwner(
      currentProfile.id,
      listLimit(url),
    );
    return json({ maps: mapList });
  }
  const mapMatch = url.pathname.match(/^\/maps\/([^/]+)$/u);
  if (request.method === "PUT" && mapMatch) {
    const currentProfile = await requireProfile(request, env, users);
    const body = await readJson<MapCreateBody>(request, MAX_BODY_BYTES + MAX_MAP_PAYLOAD_BYTES);
    const normalizedPayload = normalizeMapPayload(body.payload);
    const updatedMap = await requireRepository(maps, "Map").update(
      currentProfile.id,
      decodeURIComponent(mapMatch[1]),
      validateMapName(body.name),
      normalizedPayload.payloadJson,
      normalizedPayload.payloadBytes,
    );
    if (!updatedMap) throw new ApiError(404, "MAP_NOT_FOUND", "The map was not found.");
    return json({ map: updatedMap });
  }
  if (request.method === "GET" && mapMatch) {
    const currentProfile = await requireProfile(request, env, users);
    let mapId: string;
    try {
      mapId = decodeURIComponent(mapMatch[1]);
    } catch {
      throw new ApiError(400, "INVALID_MAP_ID", "The map id is invalid.");
    }
    const map = await requireRepository(maps, "Map").findById(currentProfile.id, mapId);
    if (!map) throw new ApiError(404, "MAP_NOT_FOUND", "The map was not found.");
    return json({ map });
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
      const debugEnabled = isDeveloperDebugRequest(request, env);
      const requestId = request.headers.get("CF-Ray")?.trim() || crypto.randomUUID();

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
        if (!(error instanceof ApiError)) {
          console.error(JSON.stringify({
            event: "request_failed",
            method: request.method,
            path: new URL(request.url).pathname,
            requestId,
            cause: error instanceof Error ? error.message : String(error),
          }));
        }
        return apiErrorResponse(error, request, env, cors, debugEnabled, requestId);
      }
    },
  };
}

export default createApiHandler({
  createUserRepository: (database) => new D1UserRepository(database),
  createImageRepository: (database) => new D1ImageAssetRepository(database),
  createMapRepository: (database) => new D1MapRepository(database),
  verifyGoogleCredential,
});
