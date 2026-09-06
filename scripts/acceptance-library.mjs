import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the built plugin against a real local Worker, never a hosted deployment.
const origin = new URL(
  process.env.OPENCODE_PANES_API_URL ?? "http://127.0.0.1:8787",
);
assert.equal(origin.protocol, "http:");
assert.ok(
  ["127.0.0.1", "[::1]"].includes(origin.hostname),
  "Acceptance is local-only",
);
const uploadKey = process.env.OPENCODE_PANES_UPLOAD_KEY;
assert.ok(
  uploadKey,
  "Set OPENCODE_PANES_UPLOAD_KEY to the local Worker's test key",
);
const { default: plugin } = await import(
  pathToFileURL(resolve("packages/opencode-plugin/dist/global.js")).href
);
const hooks = await plugin({}, { apiBaseUrl: origin.origin, uploadKey });
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "panes-acceptance-")),
);
const root = join(temporary, "fieldnotes");
const asks = [];
const context = {
  sessionID: "library-acceptance",
  messageID: "library-acceptance",
  agent: "build",
  directory: temporary,
  worktree: temporary,
  abort: new AbortController().signal,
  metadata() {},
  async ask(permission) {
    asks.push(permission);
  },
};
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function upload(sourcePath, title) {
  const result = await hooks.tool.artifact_upload.execute(
    { sourcePath, title, projectName: "Panes examples" },
    context,
  );
  assert.equal(typeof result, "string", "OpenCode tool output must be text");
  assert.ok(
    !result.includes(uploadKey),
    "Tool output must not reveal credentials",
  );
  const parsed = JSON.parse(result);
  assert.ok(!parsed.error, parsed.error);
  return parsed;
}
async function api(path, options = {}) {
  const response = await fetch(new URL(path, origin), {
    ...options,
    headers: {
      Origin: origin.origin,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  assert.ok(
    response.ok,
    `${options.method ?? "GET"} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`,
  );
  return response.status === 204 ? undefined : response.json();
}
async function exactFile(url, expected) {
  const response = await fetch(new URL(url, origin));
  assert.equal(response.status, 200);
  assert.equal(
    digest(Buffer.from(await response.arrayBuffer())),
    digest(expected),
  );
  return response;
}
async function denied(url) {
  assert.ok(
    [404, 410].includes((await fetch(new URL(url, origin))).status),
    "Revoked or unselected content must be inaccessible",
  );
}

try {
  // Each run has a new source identity; retries within a run still target the same artifact.
  await cp(resolve("examples/fieldnotes"), root, { recursive: true });
  const binary = Buffer.from([0, 255, 128, 10]);
  await writeFile(join(root, "assets/pixel.bin"), binary);
  const original = await readFile(join(root, "index.html"));
  const first = await upload(root, "Fieldnotes prototype");
  assert.ok(first.artifactId);
  assert.equal(new URL(first.dashboardUrl).origin, origin.origin);
  const again = await upload(root, "Fieldnotes prototype");
  assert.equal(again.artifactId, first.artifactId);
  assert.equal(
    again.version,
    first.version,
    "Identical retry must not create another version",
  );
  assert.equal(
    digest(await readFile(join(root, "index.html"))),
    digest(original),
  );
  assert.ok(asks.length >= 2, "Uploads must ask OpenCode permission");

  const detailPath = `/api/library/artifacts/${first.artifactId}`;
  const artifact = await api(detailPath);
  assert.equal(artifact.share, null, "Upload must start private");
  const selected = artifact.versions[0];
  const preview = await exactFile(selected.previewUrl, original);
  const sandbox = preview.headers
    .get("Content-Security-Policy")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("sandbox"))
    ?.split(/\s+/);
  assert.deepEqual(
    sandbox,
    ["sandbox", "allow-scripts", "allow-forms"],
    "Preview must not grant same-origin privileges",
  );
  assert.ok(
    preview.headers
      .get("Content-Security-Policy")
      .split("; ")
      .includes("form-action 'none'"),
    "Native form submissions from Panes-served artifact documents must remain blocked",
  );
  assert.equal(preview.headers.get("Referrer-Policy"), "no-referrer");
  const moduleResponse = await exactFile(
    new URL("assets/app.js", new URL(selected.previewUrl, origin)),
    await readFile(join(root, "assets/app.js")),
  );
  assert.equal(
    moduleResponse.headers.get("Access-Control-Allow-Origin"),
    "*",
    "Opaque-origin sandbox modules need read-only CORS",
  );
  await exactFile(
    new URL("assets/pixel.bin", new URL(selected.previewUrl, origin)),
    binary,
  );

  const share = await api(`${detailPath}/share`, {
    method: "PUT",
    body: JSON.stringify({ versionId: selected.id, expiresInDays: null }),
  });
  assert.equal(share.expiresAt, null);
  const token = new URL(share.url).pathname.split("/").pop();
  const shared = await api(`/api/shares/${token}`);
  assert.equal(shared.version.id, selected.id);
  await exactFile(shared.version.previewUrl, original);
  const unauthorized = await fetch(new URL("/api/uploads", origin), {
    method: "POST",
    body: "{}",
  });
  assert.equal(
    unauthorized.status,
    401,
    "Local development must still require machine authorization",
  );

  const path = join(temporary, "example.svg");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#dce8f0"/><text x="24" y="110" font-size="28">A simple SVG artifact</text></svg>';
  await writeFile(path, svg);
  const uploaded = await upload(path, "Identity sketch");
  const privatePath = `/api/library/artifacts/${uploaded.artifactId}`;
  const before = await api(privatePath);
  assert.equal(before.share, null);
  const originalVersion = before.versions[0];
  const initialShare = await api(`${privatePath}/share`, {
    method: "PUT",
    body: JSON.stringify({ versionId: originalVersion.id, expiresInDays: 7 }),
  });
  assert.ok(initialShare.expiresAt);
  const updateToken = new URL(initialShare.url).pathname.split("/").pop();
  const initialPublic = await api(`/api/shares/${updateToken}`);
  await exactFile(initialPublic.version.previewUrl, svg);

  const updatedSvg = svg.replace(
    "A simple SVG artifact",
    "An updated SVG artifact",
  );
  await writeFile(path, updatedSvg);
  const revised = await upload(path, "Identity sketch");
  assert.equal(revised.artifactId, uploaded.artifactId);
  const after = await api(privatePath);
  assert.equal(after.versions.length, 2);
  assert.equal(
    after.share.versionId,
    originalVersion.id,
    "A new upload must not update the public share",
  );
  await exactFile(initialPublic.version.previewUrl, svg);
  const next = after.versions[0];
  const updatedShare = await api(`${privatePath}/share`, {
    method: "PUT",
    body: JSON.stringify({ versionId: next.id, expiresInDays: null }),
  });
  assert.equal(
    updatedShare.url,
    initialShare.url,
    "Updating an active share must preserve its link",
  );
  assert.equal(updatedShare.versionId, next.id);
  assert.equal(updatedShare.expiresAt, null);
  const updatedPublic = await api(`/api/shares/${updateToken}`);
  await exactFile(updatedPublic.version.previewUrl, updatedSvg);
  await denied(initialPublic.version.previewUrl);
  await api(`${privatePath}/share`, { method: "DELETE" });
  await denied(`/api/shares/${updateToken}`);
  await denied(updatedPublic.version.previewUrl);
  const republished = await api(`${privatePath}/share`, {
    method: "PUT",
    body: JSON.stringify({ versionId: next.id, expiresInDays: null }),
  });
  assert.notEqual(
    republished.url,
    updatedShare.url,
    "Unpublish must invalidate the old link permanently",
  );
  await api(privatePath, { method: "DELETE" });
  await denied(next.previewUrl);
  assert.equal(
    await readFile(path, "utf8"),
    updatedSvg,
    "Cloud deletion must leave local files alone",
  );

  assert.equal((await api(detailPath)).share.status, "active");
  console.log(
    "Local acceptance passed: real plugin upload, exact bytes, assets, private defaults, stable sharing, versions, revocation, deletion.",
  );
  console.log(`Owner library: ${new URL("/inventory", origin).href}`);
  console.log(`Example artifact: ${first.dashboardUrl}`);
  console.log(`Example share: ${share.url}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
