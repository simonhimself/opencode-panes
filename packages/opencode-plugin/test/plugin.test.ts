import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type {
  PluginInput,
  ToolContext,
  ToolDefinition,
} from "@opencode-ai/plugin";
import {
  MAX_FILE_BYTES,
  uploadRequestSchema,
  type UploadRequest,
} from "@opencode-panes/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(vi.fn(actual.execFile), {
      [promisify.custom]: vi.fn(promisify(actual.execFile)),
    }),
  };
});

const exec = promisify(execFile);
const key = "test-secret-never-return-this";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
let root: string;
let api: Awaited<ReturnType<typeof mockApi>>;
let context: ToolContext;
let upload: ToolDefinition;
let dashboard: ToolDefinition;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "panes-upload-")));
  api = await mockApi();
  context = {
    directory: root,
    worktree: root,
    sessionID: "test",
    messageID: "test",
    agent: "build",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(async () => {}),
  };
  const hooks = await plugin({} as PluginInput, {
    apiBaseUrl: api.origin,
    uploadKey: key,
  });
  expect(Object.keys(hooks.tool!)).toEqual([
    "artifact_upload",
    "artifact_dashboard",
  ]);
  upload = hooks.tool!.artifact_upload!;
  dashboard = hooks.tool!.artifact_dashboard!;
  await put(
    "site/index.html",
    "<!doctype html><img src='./assets/picture 1.png'><script src='./app.js'></script>\r\n",
  );
});

afterEach(async () => {
  api.server.closeAllConnections();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  vi.mocked(exec).mockReset();
});

async function put(path: string, bytes: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}

async function run(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx = context,
) {
  const result = await tool.execute(args, ctx);
  expect(typeof result).toBe("string");
  expect(result).not.toContain(key);
  return JSON.parse(result as string);
}

describe("private snapshot uploads", () => {
  it("hashes the normalized wire request even when default names contain whitespace", async () => {
    await put(" spaced /index.html", "<h1>Whitespace</h1>");
    expect(
      (await run(upload, { sourcePath: " spaced " })).error,
    ).toBeUndefined();
    const { idempotencyKey, ...payload } = api.requests[0]!;
    expect(payload.title).toBe("spaced");
    expect(payload.artifactKey).toBe(" spaced ");
    expect(idempotencyKey).toBe(digest(JSON.stringify(payload)));
  });

  it("uploads exact binary and text bytes with encoded paths, permission, stable identities, and no source writes", async () => {
    const binary = Buffer.from([0, 255, 128, 13, 10, 1, 0, 200]);
    await put("site/assets/picture 1.png", binary);
    await put("site/assets/\u00e9.bin", binary);
    await put(
      "site/app.js",
      "throw new Error('Source must never execute on the server');\r\n",
    );
    const before = await tree(root);
    context.ask = vi.fn(async () => {
      expect(api.calls).toHaveLength(0);
    });
    const result = await run(upload, { sourcePath: "site" });
    expect(result).toEqual({
      artifactId: "artifact-1",
      version: 1,
      dashboardUrl: `${api.origin}/inventory/artifacts/artifact-1`,
    });
    expect(context.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "artifact_upload",
        patterns: [api.origin],
        metadata: expect.objectContaining({
          sourcePath: join(root, "site"),
          destination: api.origin,
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(context.ask).mock.calls)).not.toContain(
      key,
    );
    const request = api.requests[0]!;
    expect(request.project).toEqual({
      id: `local:${digest(root)}`,
      name: root.split("/").at(-1),
    });
    expect(request.artifactKey).toBe("site");
    const { idempotencyKey, ...withoutKey } = request;
    expect(idempotencyKey).toBe(digest(JSON.stringify(withoutKey)));
    expect(api.received.get("upload-1/assets/picture 1.png")).toEqual(binary);
    expect(api.calls.some((call) => call.url.includes("picture%201.png"))).toBe(
      true,
    );
    expect(api.calls.some((call) => call.url.includes("%C3%A9.bin"))).toBe(
      true,
    );
    expect(
      api.calls.every((call) => call.authorization === `Bearer ${key}`),
    ).toBe(true);
    expect(await tree(root)).toEqual(before);
  });

  it("uses shared exclusions at every depth without copying private metadata or dependencies", async () => {
    const excluded = [
      ".env",
      ".env.local",
      "nested/.ENV.production",
      "id.key",
      "cert.pem",
      "cert.p12",
      "cert.pfx",
      ".git/config",
      "node_modules/pkg/main.js",
      ".cache/a",
      ".next/a",
      ".nuxt/a",
      ".turbo/a",
      ".output/a",
      ".panes/state",
      ".panesignore",
      "artifact.json",
      "nested/draft.json",
    ];
    for (const path of excluded) await put(`site/${path}`, key);
    const before = await tree(root);
    await run(upload, { sourcePath: "site" });
    expect(api.requests[0]!.files.map((file) => file.path)).toEqual([
      "index.html",
    ]);
    expect(JSON.stringify(api.requests)).not.toContain(key);
    expect(await tree(root)).toEqual(before);
  });

  it("supports SVG, custom folder entries, session-relative sources and friendly overrides", async () => {
    await put(
      "site/nested/image.svg",
      "<svg xmlns='http://www.w3.org/2000/svg'/>\r\n",
    );
    const result = await run(
      upload,
      {
        sourcePath: "nested/image.svg",
        title: "Picture",
        projectName: "Friendly",
      },
      { ...context, directory: join(root, "site") },
    );
    expect(result.error).toBeUndefined();
    expect(api.requests[0]).toMatchObject({
      artifactKey: "site/nested/image.svg",
      title: "Picture",
      project: { name: "Friendly" },
      entryPath: "image.svg",
      files: [{ path: "image.svg", mediaType: "image/svg+xml" }],
    });
    await run(upload, { sourcePath: "site", entryPath: "nested/image.svg" });
    expect(api.requests[1]!.entryPath).toBe("nested/image.svg");
  });

  it("retries completed uploads deterministically and changes the key for bytes or metadata", async () => {
    const first = await run(upload, { sourcePath: "site" });
    const puts = api.calls.filter((call) => call.method === "PUT").length;
    expect(await run(upload, { sourcePath: join(root, "site") })).toEqual(
      first,
    );
    expect(api.requests[1]).toEqual(api.requests[0]);
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(
      puts,
    );
    expect(api.versions).toBe(1);
    await put("site/index.html", "<h1>Changed</h1>");
    expect((await run(upload, { sourcePath: "site" })).version).toBe(2);
    await run(upload, { sourcePath: "site", title: "New title" });
    expect(
      new Set(api.requests.map((request) => request.idempotencyKey)).size,
    ).toBe(3);
    expect(context.ask).toHaveBeenCalledTimes(4);
  });

  it.each(["fail-put", "fail-commit"])(
    "resumes safely after %s",
    async (mode) => {
      api.mode = mode;
      expect((await run(upload, { sourcePath: "site" })).error).toContain(
        "HTTP 503",
      );
      api.mode = "normal";
      expect((await run(upload, { sourcePath: "site" })).version).toBe(1);
      expect(api.requests[0]).toEqual(api.requests[1]);
      expect(api.versions).toBe(1);
    },
  );

  it("sends the buffered snapshot even when source changes after upload creation", async () => {
    const bytes = await readFile(join(root, "site/index.html"));
    api.onCreate = async () => {
      await put("site/index.html", "Changed by another editor");
    };
    expect((await run(upload, { sourcePath: "site" })).error).toBeUndefined();
    expect(api.received.get("upload-1/index.html")).toEqual(bytes);
  });

  it("rejects an earlier asset and later entry changing during collection instead of mixing builds", async () => {
    await put("site/a.js", "old asset");
    await utimes(join(root, "site/a.js"), 0, 0);
    await put("site/middle.bin", Buffer.from([0, 255, 128]));
    await put("site/z.html", "<h1>Old entry</h1>");
    const mutate = vi.fn(async () => {
      await put("site/a.js", "new asset");
      await put("site/z.html", "<h1>New entry</h1>");
    });
    changeDuringRead(mutate);

    expect(
      (await run(upload, { sourcePath: "site", entryPath: "z.html" })).error,
    ).toContain("Source changed");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(api.calls).toHaveLength(0);

    expect(
      (await run(upload, { sourcePath: "site", entryPath: "z.html" })).version,
    ).toBe(1);
    expect(api.received.get("upload-1/a.js")?.toString()).toBe("new asset");
    expect(api.received.get("upload-1/z.html")?.toString()).toBe(
      "<h1>New entry</h1>",
    );
  });

  it.each(["add", "remove", "rename"])(
    "rejects directory membership %s during a later file read and recovers safely",
    async (change) => {
      await put("site/a/old.js", "asset");
      await put("site/middle.bin", Buffer.from([0, 255, 128]));
      const mutate = vi.fn(async () => {
        if (change === "add") await put("site/a/new.js", "new asset");
        if (change === "remove") await rm(join(root, "site/a/old.js"));
        if (change === "rename")
          await rename(
            join(root, "site/a/old.js"),
            join(root, "site/a/new.js"),
          );
      });
      changeDuringRead(mutate);

      expect((await run(upload, { sourcePath: "site" })).error).toContain(
        "Source changed",
      );
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(api.calls).toHaveLength(0);
      expect((await run(upload, { sourcePath: "site" })).version).toBe(1);
      const paths = api.requests[0]!.files.map((file) => file.path);
      expect(paths.includes("a/old.js")).toBe(change === "add");
      expect(paths.includes("a/new.js")).toBe(change !== "remove");
    },
  );

  it.each([
    { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { code: "EACCES" },
    { code: 1, stderr: key },
    { code: 1, killed: true, signal: "SIGTERM" },
    { code: "ENOENT" },
  ])(
    "does not change identity on git discovery failure $code and resumes the partial upload",
    async (failure) => {
      await exec("git", ["init", "--quiet", root]);
      await exec("git", [
        "-C",
        root,
        "config",
        "remote.origin.url",
        "git@example.com:owner/project.git",
      ]);
      api.mode = "fail-put";
      expect((await run(upload, { sourcePath: "site" })).error).toContain(
        "HTTP 503",
      );
      const calls = api.calls.length;
      const permissions = vi.mocked(context.ask).mock.calls.length;
      vi.mocked(exec).mockRejectedValueOnce(
        Object.assign(new Error(key), { stdout: "", stderr: "", ...failure }),
      );

      const result = await run(upload, { sourcePath: "site" });
      expect(result.error).toContain(
        failure.code === "ENOENT"
          ? "Install Git"
          : "Retry project identity discovery",
      );
      expect(api.calls).toHaveLength(calls);
      expect(context.ask).toHaveBeenCalledTimes(permissions);

      api.mode = "normal";
      expect((await run(upload, { sourcePath: "site" })).version).toBe(1);
      expect(api.requests).toHaveLength(2);
      expect(api.requests[1]).toEqual(api.requests[0]);
      expect(api.requests[0]!.project.id).toBe(
        `git:${digest("example.com/owner/project")}`,
      );
      expect(api.versions).toBe(1);
    },
  );

  it.each(["absent", "unusable"])(
    "keeps legitimate local identity fallback for an %s repository remote",
    async (remote) => {
      await exec("git", ["init", "--quiet", root]);
      if (remote === "unusable")
        await exec("git", [
          "-C",
          root,
          "config",
          "remote.origin.url",
          "../local-only-repository",
        ]);
      expect((await run(upload, { sourcePath: "site" })).version).toBe(1);
      expect(api.requests[0]!.project.id).toBe(`local:${digest(root)}`);
    },
  );

  it("fails closed on unreadable git configuration rather than treating it as no remotes", async () => {
    await exec("git", ["init", "--quiet", root]);
    await put(".git/config", "[invalid configuration");
    expect((await run(upload, { sourcePath: "site" })).error).toContain(
      "Retry project identity discovery",
    );
    expect(api.calls).toHaveLength(0);
  });

  it("normalizes HTTPS and SSH remotes without exposing remote credentials", async () => {
    await exec("git", ["init", "--quiet", root]);
    await exec("git", [
      "-C",
      root,
      "config",
      "remote.origin.url",
      `https://user:${key}@GitHub.com/owner/project.git/`,
    ]);
    await run(upload, { sourcePath: "site" });
    await exec("git", [
      "-C",
      root,
      "config",
      "remote.origin.url",
      "git@github.com:owner/project.git",
    ]);
    await run(upload, { sourcePath: "site" });
    expect(api.requests[0]).toEqual(api.requests[1]);
    expect(api.requests[0]!.project.id).toBe(
      `git:${digest("github.com/owner/project")}`,
    );
    expect(JSON.stringify(api.requests)).not.toContain(key);
  });

  it("uses another configured remote when origin is absent", async () => {
    await exec("git", ["init", "--quiet", root]);
    await exec("git", [
      "-C",
      root,
      "config",
      "remote.upstream.url",
      "ssh://git@example.com/owner/project.git",
    ]);
    await run(upload, { sourcePath: "site" });
    expect(api.requests[0]!.project.id).toBe(
      `git:${digest("example.com/owner/project")}`,
    );
  });
});

describe("read and network boundaries", () => {
  it.each(["file", "directory", "nested", "ancestor"])(
    "rejects %s symlinks without uploading",
    async (kind) => {
      let sourcePath = "site";
      if (kind === "file") {
        await symlink(join(root, "site/index.html"), join(root, "link.html"));
        sourcePath = "link.html";
      }
      if (kind === "directory") {
        await symlink(join(root, "site"), join(root, "linked"));
        sourcePath = "linked";
      }
      if (kind === "nested")
        await symlink(
          join(root, "site/index.html"),
          join(root, "site/link.html"),
        );
      if (kind === "ancestor") {
        await symlink(join(root, "site"), join(root, "linked"));
        sourcePath = "linked/index.html";
      }
      expect((await run(upload, { sourcePath })).error).toContain(
        "Symbolic links",
      );
      expect(api.calls).toHaveLength(0);
    },
  );

  it.each([
    ".env/index.html",
    "node_modules/pkg/index.html",
    ".cache/index.html",
  ])("rejects explicitly selected excluded source %s", async (sourcePath) => {
    await put(sourcePath, key);
    expect((await run(upload, { sourcePath })).error).toContain("excluded");
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    "../index.html",
    "bad%20.html",
    "bad?.html",
    "bad\\name.html",
    "bad#name.html",
    "/index.html",
  ])("rejects unsafe entry %s", async (entryPath) => {
    expect(
      (await run(upload, { sourcePath: "site", entryPath })).error,
    ).toBeTruthy();
    expect(api.calls).toHaveLength(0);
  });

  it("rejects unsafe asset paths and non-browser or absent entries", async () => {
    expect(
      (await run(upload, { sourcePath: "site", entryPath: "App.tsx" })).error,
    ).toContain("HTML or SVG");
    expect(
      (await run(upload, { sourcePath: "site", entryPath: "missing.html" }))
        .error,
    ).toContain("snapshot");
    await put("site/unsafe?.png", "x");
    expect((await run(upload, { sourcePath: "site" })).error).toContain(
      "unsafe",
    );
    expect(api.calls).toHaveLength(0);
  });

  it("rejects outside-project paths", async () => {
    expect(
      (await run(upload, { sourcePath: "../outside.html" })).error,
    ).toContain("inside the project");
    expect(api.calls).toHaveLength(0);
  });

  it.each(["file", "total", "count"])(
    "enforces the %s snapshot limit before network requests",
    async (limit) => {
      if (limit === "count") {
        for (let i = 0; i < 500; i++) await put(`site/${i}.txt`, "");
      } else {
        for (let i = 0; i < (limit === "total" ? 5 : 1); i++) {
          const handle = await open(join(root, `site/${i}.bin`), "w");
          await handle.truncate(MAX_FILE_BYTES + (limit === "file" ? 1 : 0));
          await handle.close();
        }
      }
      expect((await run(upload, { sourcePath: "site" })).error).toContain(
        limit === "file"
          ? "25 MiB"
          : limit === "total"
            ? "100 MiB"
            : "500 files",
      );
      expect(api.calls).toHaveLength(0);
    },
  );

  it("does not send anything when permission is denied and redacts permission exceptions", async () => {
    context.ask = vi.fn(async () => {
      throw new Error(key);
    });
    const before = await tree(root);
    expect((await run(upload, { sourcePath: "site" })).error).toContain(
      "permission denied",
    );
    expect(api.calls).toHaveLength(0);
    expect(await tree(root)).toEqual(before);
  });

  it("cancels before permission and while permission is pending", async () => {
    const abort = new AbortController();
    abort.abort(key);
    expect(
      (
        await run(
          upload,
          { sourcePath: "site" },
          { ...context, abort: abort.signal },
        )
      ).error,
    ).toContain("cancelled");
    expect(context.ask).not.toHaveBeenCalled();
    const pending = new AbortController();
    context.ask = vi.fn(() => {
      pending.abort(key);
      return new Promise<void>(() => {});
    });
    expect(
      (
        await run(
          upload,
          { sourcePath: "site" },
          { ...context, abort: pending.signal },
        )
      ).error,
    ).toContain("cancelled");
    expect(api.calls).toHaveLength(0);
  });

  it("does not send later files or commit after cancellation during a file transfer", async () => {
    await put("site/second.png", Buffer.from([255, 0, 128]));
    const abort = new AbortController();
    api.server.on("request", (req) => {
      if (req.method === "PUT") abort.abort(key);
    });
    expect(
      (
        await run(
          upload,
          { sourcePath: "site" },
          { ...context, abort: abort.signal },
        )
      ).error,
    ).toContain("cancelled");
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(api.calls.some((call) => call.url.endsWith("/commit"))).toBe(false);
  });

  it("cancels an in-flight request without committing", async () => {
    api.mode = "stall";
    const abort = new AbortController();
    const started = once(api.server, "request");
    const result = run(
      upload,
      { sourcePath: "site" },
      { ...context, abort: abort.signal },
    );
    await started;
    abort.abort(key);
    expect((await result).error).toContain("cancelled");
    expect(api.calls).toHaveLength(1);
  });

  it.each(["stall", "stall-body"])(
    "times out %s without continuing the upload",
    async (mode) => {
      api.mode = mode;
      const hooks = await plugin({} as PluginInput, {
        apiBaseUrl: api.origin,
        uploadKey: key,
        requestTimeoutMs: 50,
      });
      expect(
        (await run(hooks.tool!.artifact_upload!, { sourcePath: "site" })).error,
      ).toContain("timed out");
      expect(api.calls).toHaveLength(1);
    },
  );

  it.each(["error", "redirect", "bad-session", "large-response"])(
    "does not reflect credentials in %s responses or follow redirects",
    async (mode) => {
      api.mode = mode;
      const logs = vi.spyOn(console, "error");
      expect((await run(upload, { sourcePath: "site" })).error).toBeTruthy();
      expect(api.calls).toHaveLength(1);
      expect(logs).not.toHaveBeenCalled();
    },
  );

  it("ignores server-supplied dashboard URLs containing credentials", async () => {
    api.mode = "echo-url";
    expect((await run(upload, { sourcePath: "site" })).dashboardUrl).toBe(
      `${api.origin}/inventory/artifacts/artifact-1`,
    );
  });

  it.each([
    "http://example.com",
    "http://127.0.0.1.example.com",
    "http://localhost",
    "file:///tmp",
    `https://${key}@example.com`,
    `https://example.com/?key=${key}`,
    `https://example.com/#${key}`,
    `https://example.com/${key}`,
  ])("rejects unsafe API setting %s", async (apiBaseUrl) => {
    const hooks = await plugin({} as PluginInput, {
      apiBaseUrl,
      uploadKey: key,
    });
    expect(
      (await run(hooks.tool!.artifact_upload!, { sourcePath: "site" })).error,
    ).toBeTruthy();
    expect(context.ask).not.toHaveBeenCalled();
    expect(api.calls).toHaveLength(0);
  });

  it("requires endpoint and upload key, and supports environment settings with option precedence", async () => {
    vi.stubEnv("OPENCODE_PANES_API_URL", "");
    vi.stubEnv("OPENCODE_PANES_UPLOAD_KEY", "");
    const hooks = await plugin({} as PluginInput);
    expect((await run(hooks.tool!.artifact_dashboard!, {})).error).toContain(
      "OPENCODE_PANES_API_URL",
    );
    vi.stubEnv("OPENCODE_PANES_API_URL", api.origin);
    expect(
      (await run(hooks.tool!.artifact_upload!, { sourcePath: "site" })).error,
    ).toContain("OPENCODE_PANES_UPLOAD_KEY");
    vi.stubEnv("OPENCODE_PANES_UPLOAD_KEY", key);
    expect(
      (await run(hooks.tool!.artifact_upload!, { sourcePath: "site" })).version,
    ).toBe(1);
    vi.stubEnv("OPENCODE_PANES_API_URL", "https://wrong.example");
    vi.stubEnv("OPENCODE_PANES_UPLOAD_KEY", "wrong-key");
    expect((await run(upload, { sourcePath: "site" })).version).toBe(1);
  });

  it.each(["https://panes.example", "http://[::1]:8080"])(
    "returns the dashboard for safe origin %s without needing an upload key",
    async (apiBaseUrl) => {
      vi.stubEnv("OPENCODE_PANES_UPLOAD_KEY", "");
      const hooks = await plugin({} as PluginInput, { apiBaseUrl });
      expect(await run(hooks.tool!.artifact_dashboard!, {})).toEqual({
        dashboardUrl: `${apiBaseUrl}/inventory`,
      });
      expect(api.calls).toHaveLength(0);
    },
  );

  it("returns only authenticated dashboard paths, without publishing or making dashboard requests", async () => {
    expect(await run(dashboard, {})).toEqual({
      dashboardUrl: `${api.origin}/inventory`,
    });
    expect(await run(dashboard, { artifactId: "artifact-1" })).toEqual({
      dashboardUrl: `${api.origin}/inventory/artifacts/artifact-1`,
    });
    expect(
      (await run(dashboard, { artifactId: "../share?secret" })).error,
    ).toBeTruthy();
    expect(api.calls).toHaveLength(0);
    await run(upload, { sourcePath: "site" });
    expect(api.calls.every((call) => call.url.startsWith("/api/uploads"))).toBe(
      true,
    );
  });
});

function changeDuringRead(mutate: () => Promise<void>) {
  const originalOpen = vi.mocked(open).getMockImplementation()!;
  let changed = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (!changed && args[0] === join(root, "site/middle.bin")) {
      const read = handle.read;
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
        changed = true;
        await mutate();
        return Reflect.apply(read, handle, readArgs);
      });
    }
    return handle;
  });
}

async function tree(path: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const entry of (await readdir(path)).sort()) {
    const child = join(path, entry);
    const info = await stat(child);
    result.push({
      path: relative(root, child),
      mtime: info.mtimeMs,
      ctime: info.ctimeMs,
      data: info.isDirectory()
        ? await tree(child)
        : (await readFile(child)).toString("base64"),
    });
  }
  return result;
}

async function mockApi() {
  const state = {
    mode: "normal",
    origin: "",
    versions: 0,
    calls: [] as {
      method: string;
      url: string;
      authorization: string | undefined;
    }[],
    requests: [] as UploadRequest[],
    received: new Map<string, Buffer>(),
    onCreate: async () => {},
  };
  const sessions = new Map<
    string,
    { id: string; request: UploadRequest; version: number }
  >();
  const server = createServer(async (req, res) => {
    const url = req.url!;
    state.calls.push({
      method: req.method!,
      url,
      authorization: req.headers.authorization,
    });
    if (state.mode === "stall") return;
    if (state.mode === "stall-body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"uploadId":');
      return;
    }
    if (state.mode === "error") {
      res.writeHead(500).end(key);
      return;
    }
    if (state.mode === "redirect") {
      res.writeHead(307, { Location: `${state.origin}/leak?key=${key}` }).end();
      return;
    }
    if (state.mode === "bad-session") {
      json(res, {
        uploadId: `../${key}`,
        artifactId: key,
        complete: false,
        dashboardUrl: key,
      });
      return;
    }
    if (state.mode === "large-response") {
      res.end(JSON.stringify(key.repeat(10_000)));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end(key);
      return;
    }
    if (req.method === "POST" && url === "/api/uploads") {
      const parsed = uploadRequestSchema.safeParse(
        JSON.parse(bytes.toString()),
      );
      if (!parsed.success) {
        res.writeHead(400).end("Invalid request");
        return;
      }
      // Keep original property order to check the exact idempotency payload.
      const request = JSON.parse(bytes.toString()) as UploadRequest;
      state.requests.push(request);
      let session = sessions.get(request.idempotencyKey);
      if (!session) {
        session = { id: `upload-${sessions.size + 1}`, request, version: 0 };
        sessions.set(request.idempotencyKey, session);
      }
      await state.onCreate();
      json(res, {
        uploadId: session.id,
        artifactId: "artifact-1",
        complete: session.version > 0,
        dashboardUrl: `${state.origin}/inventory?key=${key}`,
      });
      return;
    }
    const match = /^\/api\/uploads\/(upload-\d+)\/(.+)$/u.exec(url);
    const session = [...sessions.values()].find(
      (value) => value.id === match?.[1],
    );
    if (!match || !session) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "PUT" && match[2]!.startsWith("files/")) {
      if (state.mode === "fail-put") {
        res.writeHead(503).end(key);
        return;
      }
      const path = decodeURIComponent(match[2]!.slice(6));
      const file = session.request.files.find((value) => value.path === path);
      if (
        !file ||
        file.size !== bytes.length ||
        file.sha256 !== digest(bytes)
      ) {
        res.writeHead(400).end("Invalid file");
        return;
      }
      state.received.set(`${session.id}/${path}`, bytes);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && match[2] === "commit") {
      if (
        session.request.files.some(
          (file) => !state.received.has(`${session.id}/${file.path}`),
        )
      ) {
        res.writeHead(409).end();
        return;
      }
      if (!session.version) session.version = ++state.versions;
      // Simulate a lost success response after committing: retry must not add a version.
      if (state.mode === "fail-commit") {
        res.writeHead(503).end(key);
        return;
      }
      json(res, {
        artifactId: "artifact-1",
        version: session.version,
        dashboardUrl: `${state.origin}/inventory?key=${key}`,
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test API address");
  state.origin = `http://127.0.0.1:${address.port}`;
  return Object.assign(state, { server });
}

function json(res: ServerResponse, value: unknown) {
  res
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
}
