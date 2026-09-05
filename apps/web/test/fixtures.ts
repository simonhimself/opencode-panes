import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { vi, expect } from "vitest";
import type {
  ArtifactLibrary,
  LibraryArtifact,
  UploadRequest,
  UploadSession,
} from "@opencode-panes/contracts";
import worker from "../worker";
import { clearAccessJwksCache } from "../worker/access";
import { encodePath, sha256 } from "../worker/security";

export const ORIGIN = "https://panes.example";
export const KEY = "test-upload-key-not-for-production";
export const UPLOAD_HEADERS = { Authorization: `Bearer ${KEY}` };
export const SOURCES: Record<string, string> = {
  "pages/index.html":
    '\uFEFF<!doctype html>\r\n<link rel="stylesheet" href="../assets/main.css"><script type="module" src="../assets/main.js"></script><img src="../assets/picture.svg">',
  "assets/main.css": "body { color: rebeccapurple; }",
  "assets/main.js": "document.body.dataset.loaded = 'yes';",
  "assets/picture.svg":
    '<svg xmlns="http://www.w3.org/2000/svg"><text>café</text></svg>',
};

export function api(
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {},
) {
  return worker.fetch(new Request(new URL(path, ORIGIN), init), {
    ...env,
    ...overrides,
  });
}

export async function ownerFixture() {
  clearAccessJwksCache();
  const keys = await generateKeyPair("RS256", { extractable: true });
  const issuer = `https://test-${crypto.randomUUID()}.cloudflareaccess.com`;
  const audience = "panes-owner";
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "owner",
    alg: "RS256",
    use: "sig",
  };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected upstream request");
    return Response.json({ keys: [jwk] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const bindings = {
    PANES_ACCESS_ISSUER: issuer,
    PANES_ACCESS_AUDIENCE: audience,
    PANES_ACCESS_ALLOWED_EMAIL: "owner@example.com",
  };
  async function token(claims: JWTPayload = {}) {
    return new SignJWT({ email: "owner@example.com", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "owner" })
      .setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? audience)
      .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(keys.privateKey);
  }
  const headers = { "Cf-Access-Jwt-Assertion": await token(), Origin: ORIGIN };
  return {
    bindings,
    headers,
    token,
    fetchMock,
    request: (path: string, init: RequestInit = {}) => {
      const combined = new Headers(headers);
      new Headers(init.headers).forEach((value, key) =>
        combined.set(key, value),
      );
      return api(path, { ...init, headers: combined }, bindings);
    },
  };
}

export function manifest(
  overrides: Partial<UploadRequest> = {},
  sources = SOURCES,
): UploadRequest {
  return {
    idempotencyKey: sha256(crypto.randomUUID()),
    project: { id: "project-one", name: "Friendly project" },
    artifactKey: "dashboard",
    title: "Dashboard",
    entryPath: "pages/index.html",
    files: Object.entries(sources).map(([path, source]) => ({
      path,
      mediaType: "text/plain",
      size: new TextEncoder().encode(source).byteLength,
      sha256: sha256(source),
    })),
    ...overrides,
  };
}

export async function start(input: UploadRequest): Promise<UploadSession> {
  const response = await api("/api/uploads", {
    method: "POST",
    headers: UPLOAD_HEADERS,
    body: JSON.stringify(input),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<UploadSession>();
}

export function put(session: UploadSession, path: string, bytes: BodyInit) {
  return api(`/api/uploads/${session.uploadId}/files/${encodePath(path)}`, {
    method: "PUT",
    headers: UPLOAD_HEADERS,
    body: bytes,
  });
}

export function commit(session: UploadSession) {
  return api(`/api/uploads/${session.uploadId}/commit`, {
    method: "POST",
    headers: UPLOAD_HEADERS,
  });
}

export async function uploaded(input = manifest(), sources = SOURCES) {
  const session = await start(input);
  for (const [path, bytes] of Object.entries(sources))
    expect((await put(session, path, bytes)).status).toBe(204);
  const result = await commit(session);
  expect(result.status, await result.clone().text()).toBe(200);
  return { session, input };
}

export async function artifact(
  owner: Awaited<ReturnType<typeof ownerFixture>>,
  id: string,
) {
  const response = await owner.request(`/api/library/artifacts/${id}`);
  expect(response.status).toBe(200);
  return response.json<LibraryArtifact>();
}

export async function reset() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessJwksCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM library_shares"),
    env.DB.prepare("DELETE FROM library_versions"),
    env.DB.prepare("DELETE FROM library_uploads"),
    env.DB.prepare("DELETE FROM library_artifacts"),
    env.DB.prepare("DELETE FROM library_projects"),
  ]);
  const objects = await env.PRIVATE_ARTIFACTS.list({ prefix: "library/" });
  if (objects.objects.length)
    await env.PRIVATE_ARTIFACTS.delete(
      objects.objects.map((object) => object.key),
    );
}

export async function inventory(
  owner: Awaited<ReturnType<typeof ownerFixture>>,
) {
  const response = await owner.request("/api/library");
  expect(response.status).toBe(200);
  return response.json<ArtifactLibrary>();
}
