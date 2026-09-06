import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function requireUploadKey(env: Env): string {
  if (!env.PANES_UPLOAD_KEY?.trim())
    throw new HttpError(503, "Upload key is not configured");
  return env.PANES_UPLOAD_KEY;
}

export function authorizeUpload(request: Request, env: Env): void {
  const expected = requireUploadKey(env);
  const supplied =
    request.headers.get("Authorization")?.match(/^Bearer (\S+)$/u)?.[1] ?? "";
  if (
    !timingSafeEqual(
      createHash("sha256").update(expected).digest(),
      createHash("sha256").update(supplied).digest(),
    )
  )
    throw new HttpError(401, "Unauthorized");
}

export function devOwner(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  return (
    env.PANES_DEV_MODE === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

export function requireSameOrigin(request: Request): void {
  if (
    request.headers.get("Origin") !== new URL(request.url).origin ||
    ["cross-site", "same-site"].includes(
      request.headers.get("Sec-Fetch-Site") ?? "",
    )
  )
    throw new HttpError(403, "Same-origin request required");
}

const PREVIEW_SECONDS = 10 * 60;

export function previewToken(versionId: string, env: Env): string {
  const payload = `${versionId}.${Math.floor(Date.now() / 1000) + PREVIEW_SECONDS}`;
  return `${payload}.${previewSignature(payload, env)}`;
}

export function previewVersion(token: string, env: Env): string {
  const match = /^([a-f0-9-]{36})\.(\d{10})\.([a-f0-9]{64})$/u.exec(token);
  if (!match) throw new HttpError(404, "Not found");
  const [, versionId, expiry, signature] = match;
  const now = Math.floor(Date.now() / 1000);
  if (
    Number(expiry) <= now ||
    Number(expiry) > now + PREVIEW_SECONDS ||
    !timingSafeEqual(
      Buffer.from(signature!, "hex"),
      Buffer.from(previewSignature(`${versionId}.${expiry}`, env), "hex"),
    )
  )
    throw new HttpError(404, "Not found");
  return versionId!;
}

function previewSignature(payload: string, env: Env): string {
  // Domain separation keeps the upload credential out of guest URLs and prevents
  // signatures from being reused for any future management capability.
  return createHmac("sha256", requireUploadKey(env))
    .update(`panes:read-preview:v1:${payload}`)
    .digest("hex");
}

export async function readBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > limit) {
    await request.body?.cancel();
    throw new HttpError(413, "Request exceeds byte limit");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "Request exceeds byte limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  const bytes = await readBytes(request, limit);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function fileHeaders(path: string, root: string): Headers {
  // Ignore uploader MIME declarations: only browser-safe types are served inline.
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    svg: "image/svg+xml",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json",
    txt: "text/plain; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    wasm: "application/wasm",
  };
  const extension = path.split(".").pop()!.toLowerCase();
  const type = Object.hasOwn(types, extension)
    ? types[extension]!
    : "application/octet-stream";
  return new Headers({
    "Content-Type": type,
    ...(type === "application/octet-stream"
      ? { "Content-Disposition": "attachment" }
      : {}),
    // Opaque sandbox origins need anonymous CORS for local modules/fonts/fetch.
    // This header is only set on capability-scoped files, never owner APIs.
    "Access-Control-Allow-Origin": "*",
    // allow-forms enables validation/submit handlers; form-action blocks native submissions
    // from this Panes-served document, not third-party documents with their own CSP.
    "Content-Security-Policy": `sandbox allow-scripts allow-forms; default-src https: ${root} data: blob:; script-src https: ${root} 'unsafe-inline' 'unsafe-eval' blob:; style-src https: ${root} 'unsafe-inline'; connect-src https: ${root}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  });
}
