# rasterize-svg

Secure Bun/Railway function that rasterizes SVG input into PNG using [Sharp](https://sharp.pixelplumbing.com/), with deterministic signature-based caching.

## What it does

- Accepts `url` query input as either:
  - `https://...` SVG URL
  - `data:image/svg+xml,...` or `data:image/svg+xml;base64,...`
- Validates SVG content with a strict safety policy (blocks script/event handlers/external refs/etc.).
- Infers dimensions from SVG when needed.
- Generates a stable signature: `{sha256(normalized_svg)}_{width}_{height}`.
- Caches generated PNGs on disk (Railway volume if mounted).
- Returns PNG with long-lived immutable cache headers.

## Endpoint

`GET /?url=<svg_source>&width=<int>&height=<int>`

- `url` is required.
- `width` and `height` are optional.
- If one dimension is missing, it is inferred from intrinsic aspect ratio.

## Environment variables

- `PORT` (default: `3000`)
- `RAILWAY_VOLUME_MOUNT_PATH` (default fallback: `/tmp/raster-cache`)

Cache path:

- `${RAILWAY_VOLUME_MOUNT_PATH}/png-cache/{signature}.png`

## Local development

Install dependencies:

```bash
bun install
```

Run:

```bash
PORT=3000 RAILWAY_VOLUME_MOUNT_PATH=/tmp/raster-cache bun run index.ts
```

Type check:

```bash
bun x tsc --noEmit
```

## Usage examples

HTTPS source:

```bash
curl -sS \
  "http://127.0.0.1:3000/?url=https://upload.wikimedia.org/wikipedia/commons/6/6b/Bitmap_VS_SVG.svg&width=320" \
  -o out.png
```

Data URL source (use URL encoding):

```bash
curl -sS -G "http://127.0.0.1:3000/" \
  --data-urlencode 'url=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNjAiPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iNjAiIGZpbGw9IiNmZjY2MDAiLz48L3N2Zz4=' \
  --data-urlencode 'width=320' \
  -o out-data.png
```

## Security model

For remote URLs:

- HTTPS only
- Reject URL credentials
- Redirects handled manually (`max 3`)
- DNS/IP checks reject private/non-routable addresses (SSRF hardening)
- Upstream timeout: `8s`
- Max SVG payload: `5MB`

For all SVG inputs:

- XML parsing and policy validation via `saxes`
- Blocks dangerous tags (`script`, `foreignObject`, animation tags, etc.)
- Blocks event attributes (`on*`) and `javascript:`
- Blocks external resource refs; allows safe fragment refs and `data:image/...`

## Response behavior

Success:

- `200 image/png`
- `Content-Disposition: inline; filename="{signature}.png"`
- `Cache-Control: public, max-age=31536000, immutable`
- `ETag: "{signature}"`

Errors are JSON:

```json
{ "error": "ERROR_CODE", "message": "Human-readable detail" }
```

Typical error statuses: `400`, `403`, `408`, `413`, `415`, `422`, `500`, `502`.

## Logging

Structured JSON logs include:

- `server_started`
- `request_received`
- `source_parsed`
- `cache_hit` / `cache_miss`
- `request_succeeded`
- `request_failed`

## Railway notes

This project is designed for Railway Functions (Bun runtime) and Railway volume mounts:

- Functions docs: https://docs.railway.com/functions
- Volumes docs: https://docs.railway.com/volumes

