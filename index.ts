import sharp from "sharp";
import { SaxesParser } from "saxes";
import ipaddr from "ipaddr.js";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

const MAX_SVG_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_DIMENSION = 4_096;

const ALLOWED_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/plain",
]);

const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

const URL_LIKE_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isHttpError(error: unknown): error is HttpError {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "status" in error && "code" in error;
}

type IntrinsicDimensions = {
  width: number;
  height: number;
};

type SourceInput =
  | {
      kind: "remote";
      url: URL;
    }
  | {
      kind: "data";
      bytes: Uint8Array;
    };

const inflightRenders = new Map<string, Promise<Uint8Array>>();

function logInfo(event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level: "info",
      time: new Date().toISOString(),
      event,
      ...data,
    }),
  );
}

function logError(event: string, data: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      event,
      ...data,
    }),
  );
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(extraHeaders ?? {}),
  });

  return new Response(JSON.stringify({ error, message }), {
    status,
    headers,
  });
}

function toHttpError(error: unknown): HttpError {
  if (isHttpError(error)) {
    return error;
  }
  if (isAbortError(error)) {
    return new HttpError(408, "UPSTREAM_TIMEOUT", "Timed out while fetching the SVG.");
  }
  return new HttpError(500, "INTERNAL_ERROR", "Unexpected server error.");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function decodeDataUrl(rawUrl: string): Uint8Array {
  const commaIndex = rawUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new HttpError(400, "INVALID_URL", "Malformed data URL.");
  }

  const metadata = rawUrl.slice(5, commaIndex);
  const payload = rawUrl.slice(commaIndex + 1);

  const metadataParts = metadata.split(";").filter(Boolean);
  let mediaType = "";
  let isBase64 = false;

  for (const part of metadataParts) {
    if (part.toLowerCase() === "base64") {
      isBase64 = true;
      continue;
    }
    if (!mediaType) {
      mediaType = part;
    }
  }

  const effectiveType = mediaType || "text/plain;charset=US-ASCII";
  validateContentType(effectiveType);

  let decodedPayload: string;
  try {
    decodedPayload = decodeURIComponent(payload);
  } catch {
    throw new HttpError(400, "INVALID_URL", "Malformed data URL payload.");
  }

  let bytes: Uint8Array;
  if (isBase64) {
    const normalizedBase64 = decodedPayload.replace(/\s+/g, "");
    if (
      normalizedBase64.length === 0 ||
      normalizedBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)
    ) {
      throw new HttpError(400, "INVALID_URL", "Invalid base64 payload in data URL.");
    }
    bytes = new Uint8Array(Buffer.from(normalizedBase64, "base64"));
  } else {
    bytes = new TextEncoder().encode(decodedPayload);
  }

  if (bytes.byteLength === 0) {
    throw new HttpError(415, "INVALID_SVG", "Empty payload is not a valid SVG.");
  }
  if (bytes.byteLength > MAX_SVG_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "SVG exceeds maximum allowed size.");
  }

  return bytes;
}

function parseSourceInput(rawUrl: string): SourceInput {
  if (rawUrl.toLowerCase().startsWith("data:")) {
    return {
      kind: "data",
      bytes: decodeDataUrl(rawUrl),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "INVALID_URL", "Query parameter \"url\" must be a valid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "INVALID_URL_SCHEME", "Only HTTPS source URLs are allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(
      400,
      "INVALID_URL_CREDENTIALS",
      "URL credentials are not allowed in source URLs.",
    );
  }

  return {
    kind: "remote",
    url: parsed,
  };
}

function localName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const separatorIndex = normalized.indexOf(":");
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

function attributeMapLowerCase(attributes: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

function parseCssUrlReferences(value: string): string[] {
  const urls: string[] = [];
  const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match: RegExpExecArray | null = regex.exec(value);
  while (match) {
    const ref = match[2];
    if (ref) {
      urls.push(ref.trim());
    }
    match = regex.exec(value);
  }
  return urls;
}

function isSafeSvgReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("#")) {
    return true;
  }
  if (lower.startsWith("data:image/")) {
    return true;
  }

  return false;
}

function validateCssSnippet(css: string): void {
  if (/javascript\s*:/i.test(css)) {
    throw new HttpError(
      415,
      "UNSAFE_SVG",
      "SVG CSS contains forbidden javascript: references.",
    );
  }

  const urls = parseCssUrlReferences(css);
  for (const url of urls) {
    if (!isSafeSvgReference(url)) {
      throw new HttpError(
        415,
        "UNSAFE_SVG",
        "SVG CSS contains external URL references.",
      );
    }
  }

  const importRegex = /@import\s+(?:url\(\s*)?(['"]?)([^'"\s\)]+)\1/gi;
  let match: RegExpExecArray | null = importRegex.exec(css);
  while (match) {
    const ref = match[2];
    if (!ref || !isSafeSvgReference(ref)) {
      throw new HttpError(415, "UNSAFE_SVG", "SVG CSS @import is not allowed.");
    }
    match = importRegex.exec(css);
  }
}

function validateAndNormalizeSvg(svgText: string): {
  normalizedSvg: string;
  rootAttributes: Record<string, string>;
} {
  let sawRoot = false;
  let rootAttributes: Record<string, string> = {};
  const openTagStack: string[] = [];
  let parserFailure: unknown | null = null;

  const parser = new SaxesParser({ xmlns: false, fragment: false });

  const fail = (message: string): never => {
    const err = new HttpError(415, "UNSAFE_SVG", message);
    parserFailure = err;
    throw err;
  };

  parser.on("doctype", () => fail("DOCTYPE declarations are not allowed in SVG."));
  parser.on("processinginstruction", () =>
    fail("Processing instructions are not allowed in SVG."),
  );
  parser.on("error", (error) => {
    parserFailure = new HttpError(415, "INVALID_SVG", `Invalid SVG XML: ${error.message}`);
    throw parserFailure;
  });
  parser.on("opentag", (tag) => {
    const tagName = localName(tag.name);
    if (!sawRoot) {
      if (tagName !== "svg") {
        fail("Root element must be <svg>.");
      }
      sawRoot = true;
      rootAttributes = attributeMapLowerCase(tag.attributes as Record<string, string>);
    }

    if (FORBIDDEN_TAGS.has(tagName)) {
      fail(`SVG tag <${tag.name}> is not allowed.`);
    }

    const attributes = tag.attributes as Record<string, string>;
    for (const [rawName, rawValue] of Object.entries(attributes)) {
      const name = rawName.toLowerCase();
      const value = rawValue.trim();

      if (name.startsWith("on")) {
        fail(`Event attribute "${rawName}" is not allowed.`);
      }
      if (/javascript\s*:/i.test(value)) {
        fail(`Attribute "${rawName}" contains a forbidden javascript: value.`);
      }

      if (URL_LIKE_ATTRIBUTES.has(name) || name.endsWith(":href")) {
        if (!isSafeSvgReference(value)) {
          fail(`Attribute "${rawName}" points to an external resource.`);
        }
      }

      const cssUrls = parseCssUrlReferences(value);
      for (const cssUrl of cssUrls) {
        if (!isSafeSvgReference(cssUrl)) {
          fail(`Attribute "${rawName}" contains external CSS URL references.`);
        }
      }
    }

    openTagStack.push(tagName);
  });
  parser.on("closetag", () => {
    openTagStack.pop();
  });
  parser.on("text", (text) => {
    if (openTagStack[openTagStack.length - 1] === "style") {
      validateCssSnippet(text);
    }
  });
  parser.on("cdata", (cdata) => {
    if (openTagStack[openTagStack.length - 1] === "style") {
      validateCssSnippet(cdata);
    }
  });

  try {
    parser.write(svgText).close();
  } catch (error) {
    if (isHttpError(error)) {
      throw error;
    }
    if (isHttpError(parserFailure)) {
      throw parserFailure;
    }
    throw new HttpError(415, "INVALID_SVG", "Invalid SVG XML payload.");
  }

  if (!sawRoot) {
    throw new HttpError(415, "INVALID_SVG", "Root element must be <svg>.");
  }

  const normalizedSvg = svgText
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();

  return { normalizedSvg, rootAttributes };
}

function parsePositivePxLength(value?: string): number | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(/^([+]?\d*\.?\d+)(px)?$/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseViewBoxDimensions(value?: string): IntrinsicDimensions | null {
  if (!value) {
    return null;
  }
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const width = parts[2]!;
  const height = parts[3]!;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

async function extractIntrinsicDimensions(
  svgText: string,
  rootAttributes: Record<string, string>,
): Promise<IntrinsicDimensions> {
  let width = parsePositivePxLength(rootAttributes.width);
  let height = parsePositivePxLength(rootAttributes.height);
  const viewBox = parseViewBoxDimensions(rootAttributes.viewbox);
  if (viewBox) {
    if (width === null) {
      width = viewBox.width;
    }
    if (height === null) {
      height = viewBox.height;
    }
  }

  if (width === null || height === null) {
    const metadata = await sharp(Buffer.from(svgText, "utf8")).metadata();
    if (width === null && typeof metadata.width === "number" && metadata.width > 0) {
      width = metadata.width;
    }
    if (height === null && typeof metadata.height === "number" && metadata.height > 0) {
      height = metadata.height;
    }
  }

  if (width === null || height === null) {
    throw new HttpError(
      422,
      "UNRESOLVABLE_DIMENSIONS",
      "Could not infer intrinsic width and height from the SVG.",
    );
  }

  return { width, height };
}

function parseDimensionParam(value: string | null, name: "width" | "height"): number | null {
  if (value === null) {
    return null;
  }

  const raw = value.trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(
      400,
      "INVALID_DIMENSION",
      `Query parameter "${name}" must be a positive integer.`,
    );
  }

  const parsed = Number(raw);
  if (parsed > MAX_DIMENSION) {
    throw new HttpError(
      422,
      "DIMENSION_TOO_LARGE",
      `Query parameter "${name}" cannot exceed ${MAX_DIMENSION}.`,
    );
  }

  return parsed;
}

function resolveTargetDimensions(
  widthParam: number | null,
  heightParam: number | null,
  intrinsic: IntrinsicDimensions,
): { width: number; height: number } {
  const aspectRatio = intrinsic.width / intrinsic.height;
  let width: number;
  let height: number;

  if (widthParam !== null && heightParam !== null) {
    width = widthParam;
    height = heightParam;
  } else if (widthParam !== null) {
    width = widthParam;
    height = Math.max(1, Math.round(widthParam / aspectRatio));
  } else if (heightParam !== null) {
    height = heightParam;
    width = Math.max(1, Math.round(heightParam * aspectRatio));
  } else {
    width = Math.max(1, Math.round(intrinsic.width));
    height = Math.max(1, Math.round(intrinsic.height));
    width = Math.min(width, MAX_DIMENSION);
    height = Math.min(height, MAX_DIMENSION);
  }

  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new HttpError(
      422,
      "DIMENSION_TOO_LARGE",
      `Resolved dimensions exceed the maximum allowed size of ${MAX_DIMENSION}.`,
    );
  }

  return { width, height };
}

function normalizeContentType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const type = value.split(";")[0]?.trim().toLowerCase();
  return type || null;
}

function validateContentType(value: string | null): void {
  const contentType = normalizeContentType(value);
  if (contentType === null) {
    return;
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      `Upstream content type "${contentType}" is not allowed for SVG processing.`,
    );
  }
}

function isPublicIpAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }

  if (parsed.kind() === "ipv6") {
    const parsedV6 = parsed as ipaddr.IPv6;
    if (parsedV6.isIPv4MappedAddress()) {
      parsed = parsedV6.toIPv4Address();
    }
  }

  return parsed.range() === "unicast";
}

async function assertPublicHostname(hostname: string): Promise<void> {
  if (ipaddr.isValid(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new HttpError(
        403,
        "FORBIDDEN_HOST",
        "Direct IP source URLs must resolve to a public routable address.",
      );
    }
    return;
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = (await lookup(hostname, {
      all: true,
      verbatim: true,
    })) as Array<{ address: string; family: number }>;
  } catch {
    throw new HttpError(502, "DNS_RESOLUTION_FAILED", "Failed to resolve the source hostname.");
  }

  if (results.length === 0) {
    throw new HttpError(502, "DNS_RESOLUTION_FAILED", "Source hostname resolved to no addresses.");
  }

  for (const result of results) {
    if (!isPublicIpAddress(result.address)) {
      throw new HttpError(
        403,
        "FORBIDDEN_HOST",
        "Source hostname resolves to a non-public address.",
      );
    }
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!body) {
    throw new HttpError(502, "UPSTREAM_FETCH_FAILED", "Upstream response had no body.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "SVG exceeds maximum allowed size.");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function fetchSvgWithRedirects(initialUrl: URL): Promise<Uint8Array> {
  let currentUrl = new URL(initialUrl.toString());

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHostname(currentUrl.hostname);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          accept: "image/svg+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1",
          "user-agent": "rasterize-svg/1.0",
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new HttpError(408, "UPSTREAM_TIMEOUT", "Timed out while fetching the SVG.");
      }
      throw new HttpError(502, "UPSTREAM_FETCH_FAILED", "Failed to fetch the SVG URL.");
    }

    if (isRedirectStatus(response.status)) {
      if (redirects === MAX_REDIRECTS) {
        throw new HttpError(502, "TOO_MANY_REDIRECTS", "Too many redirects while fetching SVG.");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpError(502, "INVALID_REDIRECT", "Redirect response missing location header.");
      }
      currentUrl = new URL(location, currentUrl);
      if (currentUrl.protocol !== "https:") {
        throw new HttpError(
          403,
          "FORBIDDEN_REDIRECT",
          "Redirect target must remain on HTTPS.",
        );
      }
      if (currentUrl.username || currentUrl.password) {
        throw new HttpError(
          400,
          "INVALID_URL_CREDENTIALS",
          "URL credentials are not allowed in redirect targets.",
        );
      }
      continue;
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        "UPSTREAM_FETCH_FAILED",
        `Upstream server responded with status ${response.status}.`,
      );
    }

    validateContentType(response.headers.get("content-type"));

    let bytes: Uint8Array;
    try {
      bytes = await readBodyWithLimit(response.body, MAX_SVG_BYTES);
    } catch (error) {
      if (isAbortError(error)) {
        throw new HttpError(408, "UPSTREAM_TIMEOUT", "Timed out while reading SVG payload.");
      }
      throw error;
    }

    if (bytes.byteLength === 0) {
      throw new HttpError(415, "INVALID_SVG", "Empty payload is not a valid SVG.");
    }
    return bytes;
  }

  throw new HttpError(502, "UPSTREAM_FETCH_FAILED", "Unable to fetch SVG after redirects.");
}

async function loadSvgBytes(source: SourceInput): Promise<Uint8Array> {
  if (source.kind === "data") {
    return source.bytes;
  }
  return fetchSvgWithRedirects(source.url);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(415, "INVALID_SVG", "SVG payload must be valid UTF-8 XML.");
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function readCachedPng(path: string): Promise<Uint8Array | null> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size <= 0) {
      return null;
    }
    const data = await readFile(path);
    return new Uint8Array(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new HttpError(500, "CACHE_READ_FAILED", "Failed to read cached PNG file.");
  }
}

async function writePngAtomic(path: string, pngData: Uint8Array): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(tmpPath, pngData);
    await rename(tmpPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      const existing = await readCachedPng(path);
      if (existing) {
        await unlink(tmpPath).catch(() => {});
        return;
      }
    }
    await unlink(tmpPath).catch(() => {});
    throw new HttpError(500, "CACHE_WRITE_FAILED", "Failed to write PNG to cache.");
  }
}

async function rasterizeSvg(svg: string, width: number, height: number): Promise<Uint8Array> {
  try {
    const buffer = await sharp(Buffer.from(svg, "utf8"))
      .resize(width, height, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({
        quality: 85,
        compressionLevel: 9,
        adaptiveFiltering: true,
      })
      .toBuffer();
    return new Uint8Array(buffer);
  } catch {
    throw new HttpError(500, "RASTERIZATION_FAILED", "Failed to rasterize SVG to PNG.");
  }
}

async function getOrCreateRaster(
  signature: string,
  createRaster: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const existing = inflightRenders.get(signature);
  if (existing) {
    return existing;
  }

  const pending = createRaster().finally(() => {
    inflightRenders.delete(signature);
  });

  inflightRenders.set(signature, pending);
  return pending;
}

function pngHeaders(signature: string): Headers {
  return new Headers({
    "content-type": "image/png",
    "content-disposition": `inline; filename="${signature}.png"`,
    "cache-control": "public, max-age=31536000, immutable",
    etag: `"${signature}"`,
    "x-content-type-options": "nosniff",
  });
}

async function handleRequest(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const requestUrl = new URL(request.url);
  logInfo("request_received", {
    requestId,
    method: request.method,
    path: requestUrl.pathname,
  });

  if (request.method !== "GET") {
    logInfo("request_rejected_method", {
      requestId,
      method: request.method,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Only GET requests are supported.",
      { allow: "GET" },
    );
  }

  try {
    const sourceUrlParam = requestUrl.searchParams.get("url");
    if (!sourceUrlParam) {
      throw new HttpError(400, "MISSING_URL", "Query parameter \"url\" is required.");
    }

    const source = parseSourceInput(sourceUrlParam);
    logInfo("source_parsed", {
      requestId,
      sourceKind: source.kind,
      sourceHost: source.kind === "remote" ? source.url.host : undefined,
      sourceBytes: source.kind === "data" ? source.bytes.byteLength : undefined,
    });
    const widthParam = parseDimensionParam(requestUrl.searchParams.get("width"), "width");
    const heightParam = parseDimensionParam(requestUrl.searchParams.get("height"), "height");

    const svgBytes = await loadSvgBytes(source);
    const svgText = decodeUtf8(svgBytes);
    const { normalizedSvg, rootAttributes } = validateAndNormalizeSvg(svgText);
    const intrinsicDimensions = await extractIntrinsicDimensions(svgText, rootAttributes);
    const { width, height } = resolveTargetDimensions(widthParam, heightParam, intrinsicDimensions);

    const hash = sha256Hex(normalizedSvg);
    const signature = `${hash}_${width}_${height}`;
    const headers = pngHeaders(signature);

    const cacheRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/tmp/raster-cache";
    const cacheDir = join(cacheRoot, "png-cache");
    const cachePath = join(cacheDir, `${signature}.png`);

    const cached = await readCachedPng(cachePath);
    if (cached) {
      logInfo("cache_hit", {
        requestId,
        signature,
        width,
        height,
        durationMs: Date.now() - startedAt,
      });
      return new Response(cached, { status: 200, headers });
    }

    logInfo("cache_miss", {
      requestId,
      signature,
      width,
      height,
    });

    const png = await getOrCreateRaster(signature, async () => {
      const existing = await readCachedPng(cachePath);
      if (existing) {
        return existing;
      }
      const rendered = await rasterizeSvg(normalizedSvg, width, height);
      await writePngAtomic(cachePath, rendered);
      return rendered;
    });

    logInfo("request_succeeded", {
      requestId,
      signature,
      width,
      height,
      durationMs: Date.now() - startedAt,
    });
    return new Response(png, { status: 200, headers });
  } catch (error) {
    const httpError = toHttpError(error);
    logError("request_failed", {
      requestId,
      errorCode: httpError.code,
      status: httpError.status,
      message: httpError.message,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(httpError.status, httpError.code, httpError.message);
  }
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: handleRequest,
});

logInfo("server_started", {
  port: server.port,
  cacheRoot: process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "/tmp/raster-cache",
});
