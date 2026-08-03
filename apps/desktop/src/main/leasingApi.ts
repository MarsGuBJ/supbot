import { Buffer } from "node:buffer";
import {
  defaultLeasingScopes,
  defaultServstationBaseUrl,
  type IdentityContext,
  type LeasingRequestBody,
  type LeasingRequestInput,
  type LeasingResponse,
  type LeasingResponseBody,
  type ServstationA2AConfig,
} from "@supbot/shared";

/** The small runtime surface required by the leasing transport. */
export interface LeasingRuntime {
  servstationA2AConfig(): Promise<ServstationA2AConfig>;
  identityContext(): Promise<IdentityContext | undefined>;
  servstationA2AAccessToken(signal?: AbortSignal, forceRefresh?: boolean): Promise<string | undefined>;
}

export interface LeasingTransportOptions {
  /** Used by tests; production uses the global fetch implementation. */
  fetch?: typeof fetch;
  /** Used by tests; production reads process.env. */
  env?: Record<string, string | undefined>;
  /** Opens the existing OIDC login flow when the current access token is rejected. */
  reauthenticate?: () => Promise<void>;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "range",
  "x-request-id",
]);
const LEASING_PATH_ROOTS = new Set([
  "dashboard",
  "rating",
  "customers",
  "customer-groups",
  "partners",
  "partner-admissions",
  "commission-agreements",
  "commission-accruals",
  "commission-settlements",
  "projects",
  "pricing",
  "credit-applications",
  "credit-facilities",
  "limit-ledger",
  "risk-imports",
  "contracts",
  "deposit-accounts",
  "assets",
  "asset-compliance-summary",
  "disbursements",
  "receivables",
  "payments",
  "accounting-entries",
  "settlements",
  "postlease",
  "collection",
  "commands",
]);

const FORBIDDEN_AUTH_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "x-botstation-department-id",
  "x-botstation-internal-token",
  "x-botstation-organization-id",
  "x-botstation-role-ids",
  "x-botstation-tenant-id",
  "x-botstation-user-id",
]);

/**
 * Resolve the gateway leasing namespace from the configured Botstation URL.
 * HBCLIENT_LEASING_API_BASE_URL is an explicit full API override and is not
 * modified, which also supports direct leasing-api development servers.
 */
export function resolveLeasingApiBaseUrl(
  configuredBaseUrl: string | undefined,
  identityBaseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.HBCLIENT_LEASING_API_BASE_URL?.trim();
  const raw =
    explicit ||
    configuredBaseUrl?.trim() ||
    identityBaseUrl?.trim() ||
    env.HBCLIENT_BOTSTATION_BASE_URL?.trim() ||
    defaultServstationBaseUrl;
  const url = parseHttpUrl(raw, "Leasing API base URL");
  if (explicit) {
    return trimTrailingSlash(url.toString());
  }
  const pathname = trimTrailingSlash(url.pathname);
  if (pathname.endsWith("/api/v1/leasing")) {
    return trimTrailingSlash(url.toString());
  }
  url.pathname = pathname.endsWith("/api/v1") ? `${pathname}/leasing` : `${pathname}/api/v1/leasing`;
  return trimTrailingSlash(url.toString());
}

/**
 * Send one leasing API request. The renderer can only address the leasing
 * namespace and cannot provide authentication headers; the main process adds
 * the currently configured OIDC or trusted identity credentials.
 */
export async function requestLeasing(
  runtime: LeasingRuntime,
  input: LeasingRequestInput,
  options: LeasingTransportOptions = {},
): Promise<LeasingResponse> {
  const request = validateLeasingRequest(input);
  const fetchImpl = options.fetch || fetch;
  const loadContext = async () => {
    const config = await runtime.servstationA2AConfig();
    if (!config.enabled) {
      throw new Error("Botstation connection is disabled.");
    }
    const identity = await runtime.identityContext();
    const baseUrl = resolveLeasingApiBaseUrl(config.baseUrl, identity?.servstationUrl, options.env);
    return { config, identity, url: `${baseUrl}${request.path}` };
  };
  let context = await loadContext();

  const send = async (forceRefresh: boolean): Promise<Response> => {
    const headers = requestHeaders(request.headers);
    if (context.config.authMode === "oidc" || context.config.authMode === "bearer") {
      const token = await runtime.servstationA2AAccessToken(undefined, forceRefresh);
      if (!token) {
        throw new Error("Botstation authentication token is not configured.");
      }
      headers.set("Authorization", `Bearer ${token}`);
    } else if (context.config.authMode === "identityHeaders") {
      addIdentityHeaders(headers, context.identity);
    } else {
      throw new Error(`Unsupported Botstation authentication mode: ${String(context.config.authMode)}`);
    }

    const body = toRequestBody(request.body, headers);
    return fetchImpl(context.url, { method: request.method, headers, body });
  };

  let response = await send(false);
  if (response.status === 401 && context.config.authMode === "oidc") {
    let needsSignIn = !context.config.oidc?.refreshTokenSaved;
    if (!needsSignIn) {
      try {
        response = await send(true);
        needsSignIn = response.status === 401;
      } catch (error) {
        if (!options.reauthenticate) {
          throw error;
        }
        needsSignIn = true;
      }
    }
    if (needsSignIn && options.reauthenticate) {
      await options.reauthenticate();
      context = await loadContext();
      response = await send(false);
    }
  }
  return toLeasingResponse(response);
}

export function mergeLeasingScopes(scope: string | undefined): string {
  const values = (scope || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const required of ["leasing.read", "leasing.command"]) {
    if (!values.includes(required)) {
      values.push(required);
    }
  }
  return values.join(" ");
}

export function hasLeasingScopes(scope: string | undefined): boolean {
  const values = new Set((scope || "").split(/\s+/).filter(Boolean));
  return defaultLeasingScopes.every((required) => values.has(required));
}

export function validateLeasingRequest(input: LeasingRequestInput): LeasingRequestInput {
  if (!input || typeof input !== "object") {
    throw new Error("Leasing request must be an object.");
  }
  const path = input.path;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4096 ||
    !path.startsWith("/") ||
    path.startsWith("//")
  ) {
    throw new Error("Leasing request path must be a relative path beginning with '/'.");
  }
  if (path.includes("\\") || path.includes("#") || containsControlCharacter(path)) {
    throw new Error("Leasing request path contains forbidden characters.");
  }
  const rawPath = path.split("?", 1)[0] || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw new Error("Leasing request path is not valid URL encoding.");
  }
  const segments = decodedPath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Leasing request path cannot contain traversal segments.");
  }
  if (!segments.length || !LEASING_PATH_ROOTS.has(segments[0])) {
    throw new Error("Leasing request path is outside the supported leasing workspace.");
  }

  const method = (input.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Leasing request method is not allowed: ${method}`);
  }
  const headers = validateRequestHeaders(input.headers);
  const body = validateRequestBody(input.body);
  if ((method === "GET" || method === "DELETE") && body !== undefined) {
    throw new Error(`${method} leasing requests cannot include a body.`);
  }
  return { path, method: method as LeasingRequestInput["method"], headers, body };
}

function validateRequestHeaders(input: Record<string, string> | undefined): Record<string, string> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Leasing request headers must be a string map.");
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    const lowerKey = key.toLowerCase();
    if (!key || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) {
      throw new Error("Leasing request contains an invalid header name.");
    }
    if (FORBIDDEN_AUTH_HEADERS.has(lowerKey) || !ALLOWED_REQUEST_HEADERS.has(lowerKey)) {
      throw new Error(`Leasing request header is not allowed: ${key}`);
    }
    if (typeof rawValue !== "string" || containsControlCharacter(rawValue, true)) {
      throw new Error(`Leasing request header value is invalid: ${key}`);
    }
    result[key] = rawValue;
  }
  return result;
}

function validateRequestBody(body: LeasingRequestBody | undefined): LeasingRequestBody | undefined {
  if (body === undefined || typeof body === "string") {
    return body;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Leasing request body is invalid.");
  }
  if (body.encoding === "base64") {
    if (typeof body.data !== "string" || !isBase64(body.data)) {
      throw new Error("Leasing binary request body must contain valid base64 data.");
    }
    return { encoding: "base64", data: body.data };
  }
  if (body.encoding === "multipart") {
    const fields = body.fields || [];
    const files = body.files;
    if (!Array.isArray(fields) || !Array.isArray(files) || files.length > 50) {
      throw new Error("Leasing multipart request body is invalid.");
    }
    const normalizedFields = fields.map((field) => {
      if (
        !field ||
        typeof field.name !== "string" ||
        typeof field.value !== "string" ||
        !safeMultipartName(field.name)
      ) {
        throw new Error("Leasing multipart field is invalid.");
      }
      return { name: field.name, value: field.value };
    });
    const normalizedFiles = files.map((file) => {
      if (
        !file ||
        typeof file.fieldName !== "string" ||
        typeof file.fileName !== "string" ||
        typeof file.contentBase64 !== "string"
      ) {
        throw new Error("Leasing multipart file is invalid.");
      }
      if (!safeMultipartName(file.fieldName) || !safeFileName(file.fileName) || !isBase64(file.contentBase64)) {
        throw new Error("Leasing multipart file metadata is invalid.");
      }
      if (file.contentType !== undefined && (typeof file.contentType !== "string" || /[\r\n]/.test(file.contentType))) {
        throw new Error("Leasing multipart content type is invalid.");
      }
      return {
        fieldName: file.fieldName,
        fileName: file.fileName,
        contentType: file.contentType,
        contentBase64: file.contentBase64,
      };
    });
    return { encoding: "multipart", fields: normalizedFields, files: normalizedFiles };
  }
  throw new Error("Leasing request body encoding is not supported.");
}

function requestHeaders(input: Record<string, string> | undefined): Headers {
  const headers = new Headers(input);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  return headers;
}

function addIdentityHeaders(headers: Headers, identity: IdentityContext | undefined): void {
  if (!identity) {
    throw new Error("Botstation identity headers are not configured.");
  }
  const values: Array<[string, string | undefined]> = [
    ["X-Botstation-Tenant-Id", identity.tenantId],
    ["X-Botstation-Organization-Id", identity.organizationId],
    ["X-Botstation-Department-Id", identity.departmentId],
    ["X-Botstation-User-Id", identity.userId],
    ["X-Botstation-Role-Ids", identity.roleIds.join(",")],
  ];
  for (const [key, value] of values) {
    if (!value?.trim()) {
      throw new Error(`Botstation identity is missing ${key}.`);
    }
    headers.set(key, value);
  }
}

function toRequestBody(body: LeasingRequestBody | undefined, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body.encoding === "base64") {
    return Buffer.from(body.data, "base64") as unknown as BodyInit;
  }
  headers.delete("content-type");
  const form = new FormData();
  for (const field of body.fields || []) {
    form.append(field.name, field.value);
  }
  for (const file of body.files) {
    const bytes = Buffer.from(file.contentBase64, "base64");
    const blob = new Blob([bytes as unknown as BlobPart], { type: file.contentType || "application/octet-stream" });
    form.append(file.fieldName, blob, file.fileName);
  }
  return form;
}

async function toLeasingResponse(response: Response): Promise<LeasingResponse> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";
  const body = parseResponseBody(bytes, contentType);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ok: response.ok, status: response.status, statusText: response.statusText, headers, body };
}

export function parseResponseBody(bytes: Uint8Array, contentType: string): LeasingResponseBody {
  if (bytes.length === 0) {
    return { encoding: "empty" };
  }
  const text = new TextDecoder().decode(bytes);
  if (/json|problem\+json/i.test(contentType)) {
    try {
      return { encoding: "json", data: JSON.parse(text) as unknown };
    } catch {
      return { encoding: "text", data: text };
    }
  }
  if (/text\//i.test(contentType) || /csv|xml|javascript|x-www-form-urlencoded/i.test(contentType)) {
    return { encoding: "text", data: text };
  }
  // A few gateway responses omit content-type while still returning JSON.
  const firstNonWhitespace = text.trimStart()[0];
  if (firstNonWhitespace === "[" || firstNonWhitespace === "{") {
    try {
      return { encoding: "json", data: JSON.parse(text) as unknown };
    } catch {
      // Keep the original bytes when the body only happens to begin with '{'.
    }
  }
  return { encoding: "base64", data: Buffer.from(bytes).toString("base64") };
}

function parseHttpUrl(value: string, label: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} must use HTTP or HTTPS.`);
    }
    url.hash = "";
    url.search = "";
    return url;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} must use`)) {
      throw error;
    }
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function safeMultipartName(value: string): boolean {
  return (
    value.length > 0 && value.length <= 200 && !value.includes("\r") && !value.includes("\n") && !value.includes("\0")
  );
}

function safeFileName(value: string): boolean {
  return safeMultipartName(value) && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

function containsControlCharacter(value: string, allowHorizontalTab = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 31 && !(allowHorizontalTab && code === 9)) || code === 127) {
      return true;
    }
  }
  return false;
}
