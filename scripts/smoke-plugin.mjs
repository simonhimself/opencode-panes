import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const isolated = await realpath(
  await mkdtemp(join(tmpdir(), "panes-standalone-")),
);
const key = "standalone-smoke-secret";
const binary = Buffer.from([0, 255, 13, 10, 128, 1]);
let request;
let committed = false;
let puts = 0;
const received = new Map();
const calls = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    calls.push(`${req.method} ${req.url}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/uploads") {
      const next = JSON.parse(body.toString());
      const { idempotencyKey, ...payload } = next;
      assert.equal(
        idempotencyKey,
        createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      );
      if (request) assert.deepEqual(next, request);
      request = next;
      res.end(
        JSON.stringify({
          uploadId: "smoke-upload",
          artifactId: "smoke-artifact",
          complete: committed,
          dashboardUrl: `https://untrusted.example/${key}`,
        }),
      );
    } else if (req.method === "PUT") {
      const path = decodeURIComponent(
        req.url.slice("/api/uploads/smoke-upload/files/".length),
      );
      const file = request.files.find((file) => file.path === path);
      assert.ok(file);
      assert.equal(body.length, file.size);
      assert.equal(
        createHash("sha256").update(body).digest("hex"),
        file.sha256,
      );
      received.set(path, body);
      puts++;
      res.writeHead(204).end();
    } else if (req.url === "/api/uploads/smoke-upload/commit") {
      assert.equal(received.size, 2);
      committed = true;
      res.end(
        JSON.stringify({
          artifactId: "smoke-artifact",
          version: 1,
          dashboardUrl: key,
        }),
      );
    } else throw new Error("Unexpected route");
  } catch {
    res.writeHead(500).end("Smoke API validation failed");
  }
});

try {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundle = join(isolated, "plugin.mjs");
  await cp(join(repository, "packages/opencode-plugin/dist/global.js"), bundle);
  await mkdir(join(isolated, "site"));
  const html = "<!doctype html><img src='./picture 1.png'>\r\n";
  await writeFile(join(isolated, "site/index.html"), html);
  await writeFile(join(isolated, "site/picture 1.png"), binary);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  // A fresh Node process outside the repository cannot resolve workspace dependencies.
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    const { default: plugin } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    const hooks = await plugin({}, { apiBaseUrl: ${JSON.stringify(origin)}, uploadKey: process.env.SMOKE_UPLOAD_KEY });
    assert.deepEqual(Object.keys(hooks.tool), ['artifact_upload', 'artifact_dashboard']);
    let permissions = 0;
    const context = { directory: process.cwd(), worktree: process.cwd(), sessionID: 'smoke', messageID: 'smoke', agent: 'build', abort: new AbortController().signal, metadata() {}, async ask() { permissions++; } };
    for (let i = 0; i < 2; i++) {
      const output = await hooks.tool.artifact_upload.execute({ sourcePath: 'site' }, context);
      assert.equal(typeof output, 'string');
      assert.ok(!output.includes(process.env.SMOKE_UPLOAD_KEY));
      assert.deepEqual(JSON.parse(output), { artifactId: 'smoke-artifact', version: 1, dashboardUrl: ${JSON.stringify(`${origin}/inventory/artifacts/smoke-artifact`)} });
    }
    assert.equal(permissions, 2);
    assert.deepEqual(JSON.parse(await hooks.tool.artifact_dashboard.execute({}, context)), { dashboardUrl: ${JSON.stringify(`${origin}/inventory`)} });
  `,
    ],
    {
      cwd: isolated,
      env: { ...process.env, NODE_PATH: "", SMOKE_UPLOAD_KEY: key },
    },
  );
  assert.equal(puts, 2, "completed retry must not retransfer files");
  assert.ok(calls.every((call) => /^(POST|PUT) \/api\/uploads/u.test(call)));
  assert.deepEqual(received.get("picture 1.png"), binary);
  assert.equal(
    (await readFile(join(isolated, "site/index.html"))).toString(),
    html,
  );
  assert.deepEqual((await readdir(isolated)).sort(), ["plugin.mjs", "site"]);
  console.log(
    "Standalone plugin smoke passed: private binary upload, deterministic retry, JSON results, no runtime dependencies or source writes.",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(isolated, { recursive: true, force: true });
}
