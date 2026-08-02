export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_RESAMPLE_TARGET_BYTES = 1_950_000;
const IMAGE_RESAMPLE_MAX_DIMENSION = 4096;
const IMAGE_RESAMPLE_DIMENSION_SCALES = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2] as const;
const IMAGE_RESAMPLE_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3] as const;

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

export interface ImageAsset {
  id: string;
  originalFilename: string;
  originalUrl: string;
  thumbnailUrl: string;
  mimeType: ImageMimeType;
  byteSize: number;
  createdAt: string;
}

export interface ImageListResult {
  images: readonly ImageAsset[];
  nextCursor: string | null;
}

interface ApiErrorBody {
  error?: string | {
    code?: unknown;
    message?: unknown;
    debug?: unknown;
  };
  message?: unknown;
}

export interface ImageDebugDetails {
  requestId: string;
  method: string;
  path: string;
  status: number;
  cause?: string;
  upstreamStatus?: number;
  upstreamStatusText?: string;
  upstreamBody?: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_CURSOR_LENGTH = 512;
const MAX_FILENAME_LENGTH = 255;
const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 80;

export class ImageLibraryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly debug?: ImageDebugDetails,
  ) {
    super(message);
    this.name = "ImageLibraryError";
  }
}

export class ImageLibraryClient {
  private readonly baseUrl: string;

  constructor(apiBaseUrl: string) {
    this.baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  }

  async listImages(token: string, cursor?: string): Promise<ImageListResult> {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor !== undefined && cursor !== "") {
      params.set("cursor", validateCursor(cursor));
    }

    const body = await this.requestJson<unknown>(
      `/images?${params.toString()}`,
      {
        headers: this.authHeaders(token),
      },
    );
    return parseImageListResponse(body);
  }

  async uploadImage(token: string, file: File, originalFilename = file.name): Promise<ImageAsset> {
    validateToken(token);
    validateImageFile(file);

    const headers = this.authHeaders(token);
    headers["Content-Type"] = file.type;
    headers["X-Original-Filename"] = encodeURIComponent(originalFilename);
    headers["Idempotency-Key"] = createIdempotencyKey();

    const body = await this.requestJson<unknown>("/images", {
      method: "POST",
      headers,
      body: file,
    });

    return parseImageAssetResponse(body);
  }

  private authHeaders(token: string): Record<string, string> {
    validateToken(token);
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch {
      throw new ImageLibraryError(
        "이미지 서버에 연결할 수 없습니다.",
        undefined,
        "NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      throw await createResponseError(response);
    }

    const responseText = await response.text().catch(() => "");
    if (!responseText) {
      throw new ImageLibraryError(
        "이미지 서버의 응답을 읽을 수 없습니다.",
        response.status,
        "INVALID_RESPONSE",
      );
    }

    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new ImageLibraryError(
        "이미지 서버의 응답 형식이 올바르지 않습니다.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
  }
}

export function parseImageListResponse(value: unknown): ImageListResult {
  if (!isRecord(value) || !Array.isArray(value.images)) {
    throw invalidResponseError();
  }

  const nextCursor = value.nextCursor === undefined || value.nextCursor === null
    ? null
    : validateCursor(value.nextCursor);

  return {
    images: value.images.map((asset, index) => parseImageAsset(asset, index)),
    nextCursor,
  };
}

export function parseImageAssetResponse(value: unknown): ImageAsset {
  if (!isRecord(value)) throw invalidResponseError();

  const asset = value.image ?? value.asset ?? value;
  return parseImageAsset(asset);
}

export function validateImageFile(file: File): void {
  validateImageFileMetadata(file);

  if (file.size > IMAGE_MAX_BYTES) {
    throw new ImageLibraryError("이미지 파일은 10MB 이하만 업로드할 수 있습니다.", 413, "FILE_TOO_LARGE");
  }
}

export function isImageUploadOversized(file: Pick<File, "size">): boolean {
  return file.size >= IMAGE_UPLOAD_MAX_BYTES;
}

/**
 * Prepare an oversized image in the browser after the user has opted in.
 * PNG output is intentionally limited to alpha-safe formats so transparent
 * pixels are not replaced with a solid JPEG background.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  validateImageFileMetadata(file);
  if (!isImageUploadOversized(file)) return file;

  let decoded: DecodedImage;
  try {
    decoded = await decodeImage(file);
  } catch {
    throw new ImageLibraryError(
      "이미지를 브라우저에서 읽지 못해 리샘플링할 수 없습니다.",
      415,
      "IMAGE_RESAMPLE_FAILED",
    );
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    decoded.dispose();
    throw new ImageLibraryError(
      "이 브라우저에서는 이미지 리샘플링을 지원하지 않습니다.",
      415,
      "IMAGE_RESAMPLE_UNSUPPORTED",
    );
  }

  const initialScale = Math.min(
    1,
    IMAGE_RESAMPLE_MAX_DIMENSION / decoded.width,
    IMAGE_RESAMPLE_MAX_DIMENSION / decoded.height,
  );
  let smallestBlob: { blob: Blob; mimeType: ImageMimeType } | null = null;

  try {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    for (const dimensionScale of IMAGE_RESAMPLE_DIMENSION_SCALES) {
      const width = Math.max(1, Math.round(decoded.width * initialScale * dimensionScale));
      const height = Math.max(1, Math.round(decoded.height * initialScale * dimensionScale));
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(decoded.source, 0, 0, width, height);

      for (const mimeType of getResampleMimeTypes(file.type as ImageMimeType)) {
        const qualities = mimeType === "image/png" ? [undefined] : IMAGE_RESAMPLE_QUALITIES;
        for (const quality of qualities) {
          const blob = await canvasToBlob(canvas, mimeType, quality);
          if (!blob || blob.size <= 0) continue;

          if (!smallestBlob || blob.size < smallestBlob.blob.size) {
            smallestBlob = { blob, mimeType };
          }
          if (blob.size <= IMAGE_RESAMPLE_TARGET_BYTES) {
            return createResampledFile(blob, mimeType, file.name);
          }
          if (blob.size < IMAGE_UPLOAD_MAX_BYTES) {
            return createResampledFile(blob, mimeType, file.name);
          }
        }
      }
    }
  } finally {
    decoded.dispose();
  }

  if (smallestBlob && smallestBlob.blob.size < IMAGE_UPLOAD_MAX_BYTES) {
    return createResampledFile(smallestBlob.blob, smallestBlob.mimeType, file.name);
  }
  throw new ImageLibraryError(
    "이미지를 2MB 미만으로 줄이지 못했습니다. 이미지 크기나 해상도를 낮춘 뒤 다시 시도해 주세요.",
    413,
    "FILE_TOO_LARGE",
  );
}

function validateImageFileMetadata(file: File): void {
  if (!file || typeof file !== "object") {
    throw new ImageLibraryError("이미지 파일을 선택해 주세요.", 400, "INVALID_FILE");
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new ImageLibraryError("빈 이미지 파일은 업로드할 수 없습니다.", 400, "INVALID_FILE");
  }

  if (!isImageMimeType(file.type)) {
    throw new ImageLibraryError(
      "JPEG, PNG, WebP, GIF 이미지만 업로드할 수 있습니다.",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  if (typeof file.name !== "string" || file.name.trim() === "") {
    throw new ImageLibraryError("이미지 파일 이름을 확인해 주세요.", 400, "INVALID_FILE");
  }
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Image decoding failed"));
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: ImageMimeType,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mimeType, quality);
  });
}

function getResampleMimeTypes(sourceMimeType: ImageMimeType): readonly ImageMimeType[] {
  if (sourceMimeType === "image/png" || sourceMimeType === "image/gif") {
    return ["image/webp", "image/png"];
  }
  if (sourceMimeType === "image/jpeg") {
    return ["image/jpeg", "image/webp"];
  }
  return ["image/webp", "image/jpeg"];
}

function createResampledFile(blob: Blob, mimeType: ImageMimeType, originalName: string): File {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  const baseName = originalName.replace(/\.[^./\\]*$/u, "") || "image";
  return new File([blob], `${baseName}.${extension}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

export function isImageMimeType(value: unknown): value is ImageMimeType {
  return typeof value === "string" && IMAGE_MIME_TYPES.includes(value as ImageMimeType);
}

function parseImageAsset(value: unknown, index?: number): ImageAsset {
  if (!isRecord(value)) throw invalidResponseError(index);

  const id = readBoundedString(value, ["id", "imageId", "image_id"], MAX_ID_LENGTH);
  const originalFilename = sanitizeFilename(readRequiredString(value, [
    "originalFilename",
    "original_filename",
  ]));
  const originalUrl = readSafeImageUrl(value, ["originalUrl", "original_url"]);
  const thumbnailUrl = readSafeImageUrl(value, ["thumbnailUrl", "thumbnail_url"]);
  const mimeTypeValue = readRequiredString(value, ["mimeType", "mime_type"]);
  const byteSize = readByteSize(value, ["byteSize", "byte_size"]);
  const createdAt = readBoundedString(
    value,
    ["createdAt", "created_at"],
    MAX_TIMESTAMP_LENGTH,
  );

  if (!isImageMimeType(mimeTypeValue)) {
    throw invalidResponseError(index);
  }

  return {
    id,
    originalFilename,
    originalUrl,
    thumbnailUrl,
    mimeType: mimeTypeValue,
    byteSize,
    createdAt,
  };
}

function readSafeImageUrl(
  record: Record<string, unknown>,
  keys: readonly string[],
): string {
  const value = readRequiredString(record, keys);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponseError();
  }

  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw invalidResponseError();
  }

  return url.href;
}

function readRequiredString(record: Record<string, unknown>, keys: readonly string[]): string {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "string");
  if (typeof value !== "string") throw invalidResponseError();

  const normalized = value.trim();
  if (!normalized || hasControlCharacter(normalized)) throw invalidResponseError();
  return normalized;
}

function readBoundedString(
  record: Record<string, unknown>,
  keys: readonly string[],
  maxLength: number,
): string {
  const value = readRequiredString(record, keys);
  if (value.length > maxLength) throw invalidResponseError();
  return value;
}

function readByteSize(record: Record<string, unknown>, keys: readonly string[]): number {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === "number");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > IMAGE_MAX_BYTES) {
    throw invalidResponseError();
  }
  return value;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[\\/]/g, "_").slice(0, MAX_FILENAME_LENGTH);
  if (!sanitized) throw invalidResponseError();
  return sanitized;
}

function validateCursor(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_CURSOR_LENGTH || hasControlCharacter(value)) {
    throw new ImageLibraryError("이미지 목록 페이지 정보가 올바르지 않습니다.", 400, "INVALID_CURSOR");
  }
  return value;
}

function validateToken(token: string): void {
  if (typeof token !== "string" || token.trim() === "") {
    throw new ImageLibraryError("이미지 저장과 목록 조회에는 로그인이 필요합니다.", 401, "AUTH_REQUIRED");
  }
}

function createIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new ImageLibraryError("안전한 업로드 식별자를 만들 수 없습니다.", undefined, "CRYPTO_UNAVAILABLE");
  }
  return randomUUID.call(globalThis.crypto);
}

function normalizeApiBaseUrl(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("이미지 API 주소가 필요합니다.");
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("이미지 API 주소가 올바르지 않습니다.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("이미지 API 주소는 HTTP 또는 HTTPS여야 합니다.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("이미지 API 주소에 인증 정보나 쿼리를 포함할 수 없습니다.");
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function invalidResponseError(index?: number): ImageLibraryError {
  const suffix = index === undefined ? "" : ` (${index + 1}번째 항목)`;
  return new ImageLibraryError(
    `이미지 서버의 응답에 안전하지 않거나 누락된 데이터가 있습니다.${suffix}`,
    undefined,
    "INVALID_RESPONSE",
  );
}

async function createResponseError(response: Response): Promise<ImageLibraryError> {
  const responseText = await response.text().catch(() => "");
  let body: ApiErrorBody | undefined;
  try {
    body = JSON.parse(responseText) as ApiErrorBody;
  } catch {
    body = undefined;
  }

  const nestedError = body && typeof body.error === "object" && body.error !== null
    ? body.error
    : undefined;
  const code = typeof nestedError?.code === "string"
    ? nestedError.code
    : typeof body?.error === "string"
      ? body.error
      : undefined;
  const message = typeof nestedError?.message === "string"
    ? nestedError.message
    : typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : responseText.trim();
  const debug = parseImageDebugDetails(nestedError?.debug);

  const fallback = response.status === 401
    ? "이미지 저장과 목록 조회에는 로그인이 필요합니다."
    : `이미지 요청에 실패했습니다. (${response.status})`;

  return new ImageLibraryError(
    limitErrorMessage(message, fallback),
    response.status,
    code ?? "REQUEST_FAILED",
    debug,
  );
}

function parseImageDebugDetails(value: unknown): ImageDebugDetails | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = boundedDebugString(value.requestId, 128);
  const method = boundedDebugString(value.method, 16);
  const path = boundedDebugString(value.path, 256);
  const status = boundedDebugNumber(value.status);
  if (!requestId || !method || !path || status === undefined) return undefined;

  const cause = boundedDebugString(value.cause, MAX_ERROR_MESSAGE_LENGTH);
  const upstreamStatus = boundedDebugNumber(value.upstreamStatus);
  const upstreamStatusText = boundedDebugString(value.upstreamStatusText, 100);
  const upstreamBody = boundedDebugString(value.upstreamBody, MAX_ERROR_MESSAGE_LENGTH);
  return {
    requestId,
    method,
    path,
    status,
    ...(cause ? { cause } : {}),
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    ...(upstreamStatusText ? { upstreamStatusText } : {}),
    ...(upstreamBody ? { upstreamBody } : {}),
  };
}

function boundedDebugString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function boundedDebugNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function limitErrorMessage(value: string, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH) || fallback;
}
