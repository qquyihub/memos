import type { Env } from "../types";
import * as settingDB from "../db/setting";

export type StorageType = "R2" | "S3" | "WEBDAV";

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  usePathStyle: boolean;
}

export interface WebDAVStorageConfig {
  baseUrl: string;
  username: string;
  password: string;
  rootPath?: string;
}

export interface StorageConfig {
  storageType: StorageType;
  s3Config?: S3StorageConfig;
  webdavConfig?: WebDAVStorageConfig;
}

export interface ObjRange {
  offset: number;
  length: number;
}

export interface StoredObject {
  body: ReadableStream | null;
  size: number;
  partial: boolean;
}

export interface ObjectStorage {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string, range?: ObjRange): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export const normalizeStorageType = (value: unknown): StorageType => {
  if (typeof value === "number") {
    return value === 3 ? "S3" : "R2";
  }
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "S3" || normalized === "WEBDAV" ? normalized : "R2";
};

export async function getStorageConfig(db: D1Database): Promise<StorageConfig> {
  const setting = await settingDB.getInstanceSetting(db, "STORAGE");
  if (!setting) {
    return { storageType: "R2" };
  }
  try {
    const parsed = JSON.parse(setting.value) as Partial<StorageConfig> & { storageType?: unknown };
    return {
      storageType: normalizeStorageType(parsed.storageType),
      s3Config: parsed.s3Config,
      webdavConfig: parsed.webdavConfig,
    };
  } catch {
    return { storageType: "R2" };
  }
}

const requireS3Config = (config?: S3StorageConfig): S3StorageConfig => {
  if (!config?.endpoint?.trim() || !config.bucket?.trim() || !config.accessKeyId?.trim() || !config.accessKeySecret?.trim()) {
    throw new Error("S3 storage is not fully configured");
  }
  return config;
};

const requireWebDAVConfig = (config?: WebDAVStorageConfig): WebDAVStorageConfig => {
  if (!config?.baseUrl?.trim()) {
    throw new Error("WebDAV storage is not configured");
  }
  return config;
};

export type ImageOutputFormat = "origin" | "webp" | "jpeg" | "png";

export interface ImageProcessingConfig {
  enabled: boolean;
  compress: boolean;
  quality: number;
  maxEdge: number;
  format: ImageOutputFormat;
}

export interface UploadPolicy {
  filepathTemplate: string;
  uploadSizeLimitMb: number;
  imageProcessing: ImageProcessingConfig;
}

export const DEFAULT_FILEPATH_TEMPLATE = "{username}/{date}/{shortId}.{ext}";
export const DEFAULT_MAX_UPLOAD_SIZE_MB = 100;
export const DEFAULT_IMAGE_PROCESSING: ImageProcessingConfig = {
  enabled: false,
  compress: true,
  quality: 0.82,
  maxEdge: 2560,
  format: "webp",
};

const normalizeImageFormat = (value: unknown): ImageOutputFormat => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "origin" || normalized === "webp" || normalized === "jpeg" || normalized === "png"
    ? normalized
    : DEFAULT_IMAGE_PROCESSING.format;
};

const normalizeImageProcessing = (raw: unknown): ImageProcessingConfig => {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_IMAGE_PROCESSING };
  }

  const parsed = raw as Partial<ImageProcessingConfig>;
  const quality = Number(parsed.quality);
  const maxEdge = Number(parsed.maxEdge);

  return {
    enabled: parsed.enabled === true,
    compress: parsed.compress !== false,
    quality: Number.isFinite(quality) && quality >= 0.1 && quality <= 1 ? quality : DEFAULT_IMAGE_PROCESSING.quality,
    maxEdge: Number.isFinite(maxEdge) && maxEdge >= 0 ? Math.min(Math.round(maxEdge), 8192) : DEFAULT_IMAGE_PROCESSING.maxEdge,
    format: normalizeImageFormat(parsed.format),
  };
};

export async function getUploadPolicy(db: D1Database): Promise<UploadPolicy> {
  const defaults: UploadPolicy = {
    filepathTemplate: DEFAULT_FILEPATH_TEMPLATE,
    uploadSizeLimitMb: DEFAULT_MAX_UPLOAD_SIZE_MB,
    imageProcessing: { ...DEFAULT_IMAGE_PROCESSING },
  };

  const setting = await settingDB.getInstanceSetting(db, "STORAGE");
  if (!setting) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(setting.value) as {
      filepathTemplate?: unknown;
      uploadSizeLimitMb?: unknown;
      imageProcessing?: unknown;
    };
    const limit = Number(parsed.uploadSizeLimitMb);
    const template = typeof parsed.filepathTemplate === "string" ? parsed.filepathTemplate.trim() : "";

    return {
      filepathTemplate: template || DEFAULT_FILEPATH_TEMPLATE,
      uploadSizeLimitMb: limit > 0 ? limit : DEFAULT_MAX_UPLOAD_SIZE_MB,
      imageProcessing: normalizeImageProcessing(parsed.imageProcessing),
    };
  } catch {
    return defaults;
  }
}

// --- Object key naming (referenced from CloudFlare-ImgBed) ---

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "weba",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
};

export const resolveFileExtension = (filename: string, mimeType: string): string => {
  const match = filename.match(/\.([a-z0-9]{1,10})$/i);
  if (match) {
    return match[1].toLowerCase();
  }
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (MIME_EXTENSIONS[mime]) {
    return MIME_EXTENSIONS[mime];
  }
  const subtype = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "");
  return subtype || "bin";
};

const sanitizeKeySegment = (value: string, fallback: string): string => {
  const cleaned = (value || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"'<>|]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
};

const sanitizeObjectKey = (key: string): string =>
  key
    .split("/")
    .map((segment) => sanitizeKeySegment(segment, ""))
    .filter(Boolean)
    .join("/");

export interface ObjectKeyContext {
  template: string;
  username: string;
  uid: string;
  shortId: string;
  filename: string;
  mimeType: string;
  timestamp: number;
}

export function renderObjectKey(context: ObjectKeyContext): string {
  const { template, username, uid, shortId, filename, mimeType, timestamp } = context;
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const ext = resolveFileExtension(filename, mimeType);
  const originName = filename.replace(/\.[^.]+$/, "") || "unnamed";

  const values: Record<string, string> = {
    username: sanitizeKeySegment(username, "user"),
    date: `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    year: String(date.getUTCFullYear()),
    month: pad(date.getUTCMonth() + 1),
    day: pad(date.getUTCDate()),
    timestamp: String(timestamp),
    uuid: uid,
    shortId,
    filename: sanitizeKeySegment(filename, "unnamed"),
    originName: sanitizeKeySegment(originName, "unnamed"),
    ext,
  };

  const rendered = (template.trim() || DEFAULT_FILEPATH_TEMPLATE).replace(
    /\{([a-zA-Z]+)\}/g,
    (match, name: string) => values[name] ?? match,
  );

  return sanitizeObjectKey(rendered);
}

export function appendUniqueSuffix(key: string, counter: number): string {
  const slashIndex = key.lastIndexOf("/");
  const dotIndex = key.lastIndexOf(".");
  if (dotIndex > slashIndex && dotIndex > 0) {
    return `${key.slice(0, dotIndex)}(${counter})${key.slice(dotIndex)}`;
  }
  return `${key}(${counter})`;
}

export interface StoredObjectDeletionTarget {
  reference: string;
  storage_type: string;
}

/**
 * Deletes stored objects for the given attachments. Failures are logged but never
 * thrown so that database cleanup (attachment rows, memos) can always proceed.
 */
export async function deleteStoredObjects(env: Env, db: D1Database, attachments: StoredObjectDeletionTarget[]): Promise<void> {
  const backends = new Map<StorageType, ObjectStorage>();
  let config: StorageConfig | null = null;

  for (const attachment of attachments) {
    if (!attachment.reference) {
      continue;
    }
    const type = normalizeStorageType(attachment.storage_type);
    try {
      let backend = backends.get(type);
      if (!backend) {
        config ??= await getStorageConfig(db);
        backend = createStorageBackend(env, config, type);
        backends.set(type, backend);
      }
      await backend.delete(attachment.reference);
    } catch (error) {
      console.warn(`[storage] Failed to delete object ${attachment.reference} from ${type} storage:`, error);
    }
  }
}

export function createStorageBackend(env: Env, config: StorageConfig, typeOverride?: StorageType): ObjectStorage {
  const type = typeOverride ?? config.storageType;
  if (type === "S3") {
    return createS3Backend(requireS3Config(config.s3Config));
  }
  if (type === "WEBDAV") {
    return createWebDAVBackend(requireWebDAVConfig(config.webdavConfig));
  }
  if (!env.BUCKET) {
    throw new Error("R2 bucket binding is not configured");
  }
  return createR2Backend(env.BUCKET);
}

// --- R2 ---

const createR2Backend = (bucket: R2Bucket): ObjectStorage => ({
  async put(key, data, contentType) {
    await bucket.put(key, data, { httpMetadata: { contentType } });
  },
  async get(key, range) {
    const object = range
      ? await bucket.get(key, { range: { offset: range.offset, length: range.length } })
      : await bucket.get(key);
    if (!object) {
      return null;
    }
    return { body: object.body, size: object.size, partial: Boolean(range) };
  },
  async delete(key) {
    await bucket.delete(key);
  },
});

// --- S3 (AWS Signature V4) ---

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (data: ArrayBuffer | Uint8Array | string): Promise<string> => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
};

const hmacSha256 = async (key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> => {
  const rawKey = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
};

const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const encodeKeyPath = (key: string): string => key.split("/").map(encodeRfc3986).join("/");

const normalizeEndpoint = (endpoint: string): string => {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
};

interface S3RequestOptions {
  body?: ArrayBuffer;
  contentType?: string;
  range?: ObjRange;
}

const signS3Request = async (
  config: S3StorageConfig,
  method: string,
  url: URL,
  payloadHash: string,
): Promise<{ authorization: string; amzDate: string }> => {
  const amzDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = config.region.trim() || "auto";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  let signingKey = new TextEncoder().encode(`AWS4${config.accessKeySecret}`);
  signingKey = new Uint8Array(await hmacSha256(signingKey, dateStamp));
  signingKey = new Uint8Array(await hmacSha256(signingKey, region));
  signingKey = new Uint8Array(await hmacSha256(signingKey, "s3"));
  signingKey = new Uint8Array(await hmacSha256(signingKey, "aws4_request"));
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return {
    amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

const createS3Backend = (config: S3StorageConfig): ObjectStorage => {
  const endpoint = new URL(normalizeEndpoint(config.endpoint));
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const usePathStyle = config.usePathStyle !== false;

  const buildUrl = (key: string): URL => {
    const url = new URL(endpoint.toString());
    const segments = [config.bucket, ...key.split("/")];
    if (usePathStyle) {
      url.pathname = `${basePath}/${segments.map(encodeRfc3986).join("/")}`;
    } else {
      url.hostname = `${config.bucket}.${endpoint.hostname}`;
      url.pathname = `${basePath}/${encodeKeyPath(key)}`;
    }
    return url;
  };

  const request = async (method: string, key: string, options: S3RequestOptions = {}) => {
    const url = buildUrl(key);
    const payloadHash = options.body ? await sha256Hex(options.body) : EMPTY_SHA256;
    const { authorization, amzDate } = await signS3Request(config, method, url, payloadHash);

    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
    };
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    if (options.range) {
      headers.Range = `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`;
    }

    return fetch(url.toString(), {
      method,
      headers,
      body: options.body,
    });
  };

  return {
    async put(key, data, contentType) {
      const response = await request("PUT", key, { body: data, contentType });
      if (!response.ok) {
        throw new Error(`S3 upload failed (${response.status}): ${await response.text()}`);
      }
    },
    async get(key, range) {
      const response = await request("GET", key, { range });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`S3 download failed (${response.status}): ${await response.text()}`);
      }
      return {
        body: response.body,
        size: parseContentRangeTotal(response.headers.get("content-range")) ?? Number(response.headers.get("content-length")) ?? 0,
        partial: Boolean(range) && response.status === 206,
      };
    },
    async delete(key) {
      const response = await request("DELETE", key);
      if (!response.ok && response.status !== 404) {
        throw new Error(`S3 delete failed (${response.status}): ${await response.text()}`);
      }
    },
  };
};

// --- WebDAV ---

const parseContentRangeTotal = (value: string | null): number | null => {
  if (!value) {
    return null;
  }
  const match = value.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
};

const basicAuth = (username: string, password: string): string => {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return `Basic ${btoa(binary)}`;
};

const createWebDAVBackend = (config: WebDAVStorageConfig): ObjectStorage => {
  const baseUrl = normalizeEndpoint(config.baseUrl);
  const rootSegments = (config.rootPath || "")
    .trim()
    .split("/")
    .filter(Boolean)
    .map(encodeRfc3986);
  const authHeaders: Record<string, string> =
    config.username || config.password ? { Authorization: basicAuth(config.username || "", config.password || "") } : {};

  const buildUrl = (segments: string[]): string => `${baseUrl}/${segments.join("/")}`;

  const ensureDirectories = async (key: string) => {
    const keyDirSegments = key
      .split("/")
      .filter(Boolean)
      .slice(0, -1)
      .map(encodeRfc3986);
    const directories = [...rootSegments, ...keyDirSegments];
    for (let index = 1; index <= directories.length; index++) {
      const response = await fetch(buildUrl(directories.slice(0, index)), {
        method: "MKCOL",
        headers: authHeaders,
      });
      if (!response.ok && response.status !== 405) {
        throw new Error(`WebDAV MKCOL failed (${response.status}): ${await response.text()}`);
      }
    }
  };

  return {
    async put(key, data, contentType) {
      await ensureDirectories(key);
      const segments = [...rootSegments, ...key.split("/").filter(Boolean).map(encodeRfc3986)];
      const response = await fetch(buildUrl(segments), {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": contentType },
        body: data,
      });
      if (!response.ok) {
        throw new Error(`WebDAV upload failed (${response.status}): ${await response.text()}`);
      }
    },
    async get(key, range) {
      const segments = [...rootSegments, ...key.split("/").filter(Boolean).map(encodeRfc3986)];
      const headers: Record<string, string> = { ...authHeaders };
      if (range) {
        headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      }
      const response = await fetch(buildUrl(segments), { method: "GET", headers });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`WebDAV download failed (${response.status}): ${await response.text()}`);
      }
      const contentRange = response.headers.get("content-range");
      return {
        body: response.body,
        size: parseContentRangeTotal(contentRange) ?? Number(response.headers.get("content-length")) ?? 0,
        partial: Boolean(range) && response.status === 206,
      };
    },
    async delete(key) {
      const segments = [...rootSegments, ...key.split("/").filter(Boolean).map(encodeRfc3986)];
      const response = await fetch(buildUrl(segments), { method: "DELETE", headers: authHeaders });
      if (!response.ok && response.status !== 404) {
        throw new Error(`WebDAV delete failed (${response.status}): ${await response.text()}`);
      }
    },
  };
};
