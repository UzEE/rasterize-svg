import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRequest } from "./index";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let cacheDir = "";
let previousCacheRoot: string | undefined;

beforeAll(async () => {
  previousCacheRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  cacheDir = await mkdtemp(join(tmpdir(), "rasterize-svg-test-"));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = cacheDir;
});

afterAll(async () => {
  if (previousCacheRoot === undefined) {
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  } else {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = previousCacheRoot;
  }
  if (cacheDir) {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

function svgDataUrl(svg: string, base64 = true): string {
  if (base64) {
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function buildRequest(urlSource?: string, params: Record<string, string> = {}): Request {
  const url = new URL("http://localhost/");
  if (urlSource !== undefined) {
    url.searchParams.set("url", urlSource);
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

function signatureFromEtag(etag: string | null): string {
  expect(etag).toBeTruthy();
  return (etag as string).replace(/^"|"$/g, "");
}

async function parseErrorBody(response: Response): Promise<{ error: string; message: string }> {
  return (await response.json()) as { error: string; message: string };
}

describe("rasterize-svg handler", () => {
  test("renders PNG from base64 data URL and writes cache file", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#ff6600"/></svg>';
    const res = await handleRequest(buildRequest(svgDataUrl(svg), { width: "240" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const signature = signatureFromEtag(res.headers.get("etag"));
    expect(signature.endsWith("_240_120")).toBe(true);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_MAGIC);

    const cachePath = join(cacheDir, "png-cache", `${signature}.png`);
    const fileStat = await stat(cachePath);
    expect(fileStat.isFile()).toBe(true);

    const cached = await readFile(cachePath);
    expect(cached.length).toBe(bytes.length);
  });

  test("infers height from provided width", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><circle cx="30" cy="30" r="20" fill="#333"/></svg>';
    const res = await handleRequest(buildRequest(svgDataUrl(svg), { width: "300" }));

    expect(res.status).toBe(200);
    const signature = signatureFromEtag(res.headers.get("etag"));
    expect(signature.endsWith("_300_150")).toBe(true);
  });

  test("infers width from provided height", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#0055ff"/></svg>';
    const res = await handleRequest(buildRequest(svgDataUrl(svg), { height: "200" }));

    expect(res.status).toBe(200);
    const signature = signatureFromEtag(res.headers.get("etag"));
    expect(signature.endsWith("_400_200")).toBe(true);
  });

  test("accepts non-base64 SVG data URL", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0a0"/></svg>';
    const res = await handleRequest(buildRequest(svgDataUrl(svg, false), { width: "160" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("rejects non-SVG data URL media type", async () => {
    const html = "<h1>Hello</h1>";
    const dataUrl = `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
    const res = await handleRequest(buildRequest(dataUrl));

    expect(res.status).toBe(415);
    const body = await parseErrorBody(res);
    expect(body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  test("rejects unsafe SVG event handlers", async () => {
    const unsafeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" onclick="alert(1)"/></svg>';
    const res = await handleRequest(buildRequest(svgDataUrl(unsafeSvg)));

    expect(res.status).toBe(415);
    const body = await parseErrorBody(res);
    expect(body.error).toBe("UNSAFE_SVG");
  });

  test("returns 400 when url query param is missing", async () => {
    const res = await handleRequest(buildRequest(undefined));

    expect(res.status).toBe(400);
    const body = await parseErrorBody(res);
    expect(body.error).toBe("MISSING_URL");
  });
});
