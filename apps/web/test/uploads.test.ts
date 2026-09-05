import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  type UploadResult,
} from "@opencode-panes/contracts";
import {
  api,
  artifact,
  commit,
  inventory,
  manifest,
  ownerFixture,
  put,
  reset,
  SOURCES,
  start,
  uploaded,
  UPLOAD_HEADERS,
} from "./fixtures";
import { sha256 } from "../worker/security";

beforeEach(reset);

describe("immutable private uploads", () => {
  it("keeps incomplete uploads out of inventory; commits raw independent versions without sharing", async () => {
    const owner = await ownerFixture();
    const first = manifest();
    const session = await start(first);
    expect((await inventory(owner)).artifacts).toEqual([]);
    expect((await commit(session)).status).toBe(409);
    for (const [path, source] of Object.entries(SOURCES))
      expect((await put(session, path, source)).status).toBe(204);
    expect(await (await commit(session)).json()).toEqual({
      artifactId: session.artifactId,
      version: 1,
      dashboardUrl: session.dashboardUrl,
    });
    const a = await artifact(owner, session.artifactId);
    expect(a.share).toBeNull();
    expect(a.versions[0]).toMatchObject({
      id: session.uploadId,
      number: 1,
      entryPath: first.entryPath,
      fileCount: 4,
    });
    expect(
      new Uint8Array(
        await (await api(a.versions[0]!.previewUrl)).arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode(SOURCES[first.entryPath]));
    expect((await inventory(owner)).projects).toEqual([
      { id: first.project.id, name: first.project.name },
    ]);

    const secondSources: Record<string, string> = {
      ...SOURCES,
      "pages/index.html": "<h1>new version</h1>",
    };
    const second = await uploaded(
      manifest(
        {
          title: "New title",
          project: { id: first.project.id, name: "Renamed project" },
        },
        secondSources,
      ),
      secondSources,
    );
    expect(second.session.artifactId).toBe(session.artifactId);
    const updated = await artifact(owner, session.artifactId);
    expect(updated.title).toBe("New title");
    expect(updated.share).toBeNull();
    expect(updated.versions.map((version) => version.number)).toEqual([2, 1]);
    expect(
      new Uint8Array(
        await (await api(updated.versions[1]!.previewUrl)).arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode(SOURCES[first.entryPath]));
    expect(await (await api(updated.versions[0]!.previewUrl)).text()).toBe(
      secondSources[first.entryPath],
    );
    expect((await inventory(owner)).projects[0]!.name).toBe("Renamed project");
    const objects = await env.PRIVATE_ARTIFACTS.list({
      prefix: `library/${session.artifactId}/`,
    });
    expect(objects.objects).toHaveLength(8);
  });

  it("resumes concurrent start/file/commit retries and rejects changed idempotency payloads", async () => {
    const input = manifest();
    const sessions = await Promise.all(
      Array.from({ length: 4 }, () => start(input)),
    );
    expect(new Set(sessions.map((session) => session.uploadId)).size).toBe(1);
    const session = sessions[0]!;
    for (const [path, source] of Object.entries(SOURCES)) {
      const results = await Promise.all([
        put(session, path, source),
        put(session, path, source),
      ]);
      expect(results.map((result) => result.status)).toEqual([204, 204]);
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => commit(session)),
    );
    for (const response of results)
      expect((await response.json<UploadResult>()).version).toBe(1);
    expect(
      (await start({ ...input, files: [...input.files].reverse() })).complete,
    ).toBe(true);
    const conflict = await api("/api/uploads", {
      method: "POST",
      headers: UPLOAD_HEADERS,
      body: JSON.stringify({ ...input, title: "Changed" }),
    });
    expect(conflict.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM library_versions",
      ).first("count"),
    ).toBe(1);
  });

  it("allocates unique consecutive numbers for distinct concurrent uploads of the same artifact", async () => {
    const sessions = await Promise.all([
      start(manifest()),
      start(manifest()),
      start(manifest()),
    ]);
    for (const session of sessions)
      for (const [path, source] of Object.entries(SOURCES))
        await put(session, path, source);
    const results = await Promise.all(sessions.map(commit));
    const numbers = await Promise.all(
      results.map(
        async (response) => (await response.json<UploadResult>()).version,
      ),
    );
    expect(numbers.sort()).toEqual([1, 2, 3]);
    expect(new Set(sessions.map((session) => session.artifactId)).size).toBe(1);
  });

  it("never overwrites committed bytes, including an already-running PUT racing commit", async () => {
    const session = await start(manifest());
    for (const [path, source] of Object.entries(SOURCES))
      await put(session, path, source);
    const before = await env.PRIVATE_ARTIFACTS.head(
      `library/${session.artifactId}/${session.uploadId}/pages/index.html`,
    );
    let release!: () => void;
    let reading!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading();
          await wait;
          controller.enqueue(
            new TextEncoder().encode(SOURCES["pages/index.html"]),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const latePut = put(session, "pages/index.html", body);
    await started;
    expect((await commit(session)).status).toBe(200);
    release();
    expect((await latePut).status).toBe(204);
    expect((await put(session, "pages/index.html", "evil")).status).toBe(400);
    const after = await env.PRIVATE_ARTIFACTS.head(
      `library/${session.artifactId}/${session.uploadId}/pages/index.html`,
    );
    expect(after!.version).toBe(before!.version);
  });

  it("checks file size and SHA before storage and rechecks actual bytes on commit", async () => {
    const sources = { "index.html": "1234" };
    const session = await start(manifest({ entryPath: "index.html" }, sources));
    expect((await put(session, "index.html", "4321")).status).toBe(400);
    expect((await put(session, "index.html", "123")).status).toBe(400);
    expect((await put(session, "index.html", "12345")).status).toBe(413);
    expect(
      (
        await env.PRIVATE_ARTIFACTS.list({
          prefix: `library/${session.artifactId}/`,
        })
      ).objects,
    ).toHaveLength(0);
    await put(session, "index.html", "1234");
    const key = `library/${session.artifactId}/${session.uploadId}/index.html`;
    await env.PRIVATE_ARTIFACTS.put(key, "4321");
    expect((await commit(session)).status).toBe(409);
    expect((await put(session, "index.html", "1234")).status).toBe(409);
    expect(await (await env.PRIVATE_ARTIFACTS.get(key))!.text()).toBe("4321");
  });

  it("bounds streamed files and JSON without Content-Length and cancels overflow", async () => {
    const session = await start(
      manifest({ entryPath: "index.html" }, { "index.html": "x" }),
    );
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2));
      },
      cancel,
    });
    expect((await put(session, "index.html", stream)).status).toBe(413);
    expect(cancel).toHaveBeenCalled();
    const json = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
      },
    });
    expect(
      (
        await api("/api/uploads", {
          method: "POST",
          headers: UPLOAD_HEADERS,
          body: json,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await api("/api/uploads", {
          method: "POST",
          headers: { ...UPLOAD_HEADERS, "Content-Length": "2000000" },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await api("/api/uploads", {
          method: "POST",
          headers: UPLOAD_HEADERS,
          body: new Uint8Array([255]),
        })
      ).status,
    ).toBe(400);
  });

  it.each([
    "../index.html",
    "/index.html",
    "a//b.html",
    "a\\b.html",
    "a/%2e.html",
    "a?x.html",
    "a#x.html",
    "a\u0000.html",
    ".env",
    ".git/index.html",
    "node_modules/index.html",
    "private.key",
  ])("rejects unsafe or excluded manifest path %s", async (path) => {
    const input = manifest();
    input.files.push({
      path,
      mediaType: "text/plain",
      size: 0,
      sha256: sha256(""),
    });
    expect(
      (
        await api("/api/uploads", {
          method: "POST",
          headers: UPLOAD_HEADERS,
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(400);
  });

  it("rejects malformed manifests, duplicate paths, missing entry and all upload limits", async () => {
    const input = manifest();
    const file = input.files[0]!;
    const cases = [
      { ...input, unknown: true },
      { ...input, entryPath: "index.tsx" },
      { ...input, entryPath: "missing.html" },
      { ...input, files: [file, file] },
      { ...input, files: [{ ...file, size: MAX_FILE_BYTES + 1 }] },
      {
        ...input,
        files: Array.from({ length: MAX_FILES + 1 }, (_, n) => ({
          ...file,
          path: `${n}.html`,
        })),
      },
      {
        ...input,
        entryPath: "0.html",
        files: Array.from({ length: 5 }, (_, n) => ({
          ...file,
          path: `${n}.html`,
          size: MAX_FILE_BYTES,
        })),
      },
      { ...input, files: [{ ...file, sha256: "bad" }] },
      {
        ...input,
        files: [{ ...file, mediaType: "text/html\r\nSet-Cookie: evil" }],
      },
    ];
    for (const body of cases)
      expect(
        (
          await api("/api/uploads", {
            method: "POST",
            headers: UPLOAD_HEADERS,
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM library_uploads",
      ).first("count"),
    ).toBe(0);
  });

  it("accepts empty files and keeps artifacts separate by stable project/source identity", async () => {
    const sources = { "index.html": "", "empty.txt": "" };
    const one = await uploaded(
      manifest({ entryPath: "index.html" }, sources),
      sources,
    );
    const two = await uploaded(
      manifest({ artifactKey: "other", entryPath: "index.html" }, sources),
      sources,
    );
    const three = await uploaded(
      manifest(
        {
          project: { id: "other", name: "Another project" },
          entryPath: "index.html",
        },
        sources,
      ),
      sources,
    );
    expect(
      new Set([one, two, three].map((item) => item.session.artifactId)).size,
    ).toBe(3);
  });
});
