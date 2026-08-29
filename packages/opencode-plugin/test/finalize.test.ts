import { createHash } from "node:crypto";
import { get } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactManifestSchema } from "@opencode-panes/contracts";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodePanesPlugin } from "../src/index.js";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "opencode-panes-finalize-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(project, { recursive: true, force: true });
});

describe("artifact_finalize tool", () => {
  it("finalizes a browser draft and serves its raw nested files over loopback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Site" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await mkdir(join(draftPath, "assets"));
    await writeFile(
      join(draftPath, "index.html"),
      '<script type="module" src="assets/app.js"></script>',
    );
    await writeFile(
      join(draftPath, "assets", "app.js"),
      "export const answer = 42;\n",
    );

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "./index.html", adapter: "browser" },
      context,
    );

    const resultMetadata = metadata(result);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resultMetadata).toMatchObject({
      operation: "finalized",
      artifactId,
      version: 1,
    });
    expect(resultMetadata.previewUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/preview\/[^/]+\/v1\/index\.html$/,
    );

    const preview = await getText(String(resultMetadata.previewUrl));
    expect(preview.status).toBe(200);
    expect(preview.contentType).toMatch(/^text\/html/);
    expect(preview.body).toBe(
      '<script type="module" src="assets/app.js"></script>',
    );
    const asset = await getText(
      `${String(resultMetadata.previewUrl).replace("index.html", "assets/app.js")}`,
    );
    expect(asset.status).toBe(200);
    expect(asset.contentType).toMatch(/^application\/javascript/);
    expect(asset.body).toBe("export const answer = 42;\n");

    const artifactDirectory = join(project, "artifacts", "site");
    const manifest = artifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
      ),
    );
    expect(manifest.revisions[0]).toMatchObject({
      version: 1,
      preview: { adapter: "browser", entryPath: "index.html" },
      approvedOrigins: [],
    });
    expect(manifest.revisions[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          path: "index.html",
          byteSize: Buffer.byteLength(
            '<script type="module" src="assets/app.js"></script>',
          ),
          mediaType: "text/html",
        }),
        expect.objectContaining({
          kind: "file",
          path: "assets/app.js",
          byteSize: Buffer.byteLength("export const answer = 42;\n"),
          mediaType: "application/javascript",
        }),
        expect.objectContaining({ kind: "directory", path: "assets" }),
      ]),
    );
    expect(
      await stat(join(artifactDirectory, "v1", "index.html")),
    ).toMatchObject({
      isFile: expect.any(Function),
    });
    expect(await readdir(artifactDirectory)).not.toContain("draft");
    expect(await readdir(artifactDirectory)).not.toContain(
      ".panes-finalize.json",
    );
  });

  it("serves a supported renderer through a generated wrapper without rewriting stored source", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Notes" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    const source = "# Hello\n\nThis is **markdown**.\n";
    await writeFile(join(draftPath, "README.md"), source);

    const result = await executeTool(
      "artifact_finalize",
      {
        artifactId,
        entryPath: "README.md",
        adapter: "renderer",
        renderer: "markdown",
      },
      context,
    );
    const previewUrl = metadata(result).previewUrl as string;
    const response = await getText(previewUrl);

    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/html/);
    expect(response.body).toContain('data-panes-renderer="markdown"');
    expect(response.body).toContain("# Hello");
    expect(
      await readFile(
        join(project, "artifacts", "notes", "v1", "README.md"),
        "utf8",
      ),
    ).toBe(source);
  });

  it.each([
    ["browser with a renderer", { adapter: "browser", renderer: "code" }],
    ["renderer without a renderer name", { adapter: "renderer" }],
    [
      "markdown with an HTML entry",
      { adapter: "renderer", renderer: "markdown" },
    ],
  ] as const)("rejects %s adapter combinations", async (_case, input) => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Invalid" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await writeFile(join(draftPath, "index.html"), "<h1>Invalid</h1>");

    await expect(
      executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", ...input },
        context,
      ),
    ).rejects.toThrow(/Artifact input is invalid|cannot use/);
  });

  it.each([
    "before-rename",
    "after-rename",
    "after-manifest",
    "before-cleanup",
  ] as const)(
    "recovers and returns the finalized preview after a %s interruption",
    async (phase) => {
      const context = toolContext();
      const prepare = await executeTool(
        "artifact_prepare",
        { title: `Crash ${phase}` },
        context,
      );
      const artifactId = metadata(prepare).artifactId as string;
      const draftPath = metadata(prepare).draftPath as string;
      await writeFile(join(draftPath, "index.html"), `<h1>${phase}</h1>`);

      vi.stubEnv("OPENCODE_PANES_TEST_CRASH_PHASE", phase);
      await expect(
        executeTool(
          "artifact_finalize",
          { artifactId, entryPath: "index.html", adapter: "browser" },
          context,
        ),
      ).rejects.toThrow(`Simulated finalization crash at ${phase}`);
      vi.unstubAllEnvs();

      const recovered = await executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", adapter: "browser" },
        context,
      );
      expect(metadata(recovered)).toMatchObject({
        operation: "finalized",
        version: 1,
      });
      expect(
        (await getText(metadata(recovered).previewUrl as string)).status,
      ).toBe(200);

      const artifactDirectory = join(project, "artifacts", `crash-${phase}`);
      const manifest = JSON.parse(
        await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
      );
      expect(manifest.revisions).toHaveLength(1);
      expect(await readdir(artifactDirectory)).not.toContain(
        ".panes-finalize.json",
      );
      expect(
        await stat(join(artifactDirectory, "v1", "index.html")),
      ).toMatchObject({
        isFile: expect.any(Function),
      });
    },
  );

  it("records raw binary bytes and blocks changed finalized history", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Immutable" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    const html = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x68, 0x31, 0x3e, 0x0a]);
    const binary = Buffer.from([0x00, 0xff, 0x01, 0xfe]);
    await mkdir(join(draftPath, "assets"));
    await writeFile(join(draftPath, "index.html"), html);
    await writeFile(join(draftPath, "assets", "payload.bin"), binary);

    const result = await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const artifactDirectory = join(project, "artifacts", "immutable");
    const manifest = artifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
      ),
    );
    expect(manifest.revisions[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "index.html",
          sha256: createHash("sha256").update(html).digest("hex"),
          byteSize: html.byteLength,
        }),
        expect.objectContaining({
          path: "assets/payload.bin",
          sha256: createHash("sha256").update(binary).digest("hex"),
          byteSize: binary.byteLength,
        }),
      ]),
    );

    const previewUrl = metadata(result).previewUrl as string;
    await writeFile(join(artifactDirectory, "v1", "index.html"), "changed");
    const changedPreview = await getText(previewUrl);
    expect(changedPreview.status).toBe(409);

    const next = await executeTool("artifact_prepare", { artifactId }, context);
    expect(next).toBeDefined();
    await expect(
      executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", adapter: "browser" },
        context,
      ),
    ).rejects.toThrow("no longer match artifact.json");
    await expect(stat(join(artifactDirectory, "v2"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an unexpected finalized Revision directory without changing the ledger", async () => {
    const context = toolContext();
    const prepare = await executeTool(
      "artifact_prepare",
      { title: "Gap" },
      context,
    );
    const artifactId = metadata(prepare).artifactId as string;
    const draftPath = metadata(prepare).draftPath as string;
    await writeFile(join(draftPath, "index.html"), "<h1>one</h1>");
    await executeTool(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const artifactDirectory = join(project, "artifacts", "gap");
    await mkdir(join(artifactDirectory, "v9"));
    const next = await executeTool("artifact_prepare", { artifactId }, context);
    await writeFile(
      join(metadata(next).draftPath as string, "index.html"),
      "<h1>two</h1>",
    );

    await expect(
      executeTool(
        "artifact_finalize",
        { artifactId, entryPath: "index.html", adapter: "browser" },
        context,
      ),
    ).rejects.toThrow("unexpected Revision directory");
    const manifest = JSON.parse(
      await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
    );
    expect(manifest.revisions).toHaveLength(1);
  });
});

async function executeTool(
  name: "artifact_prepare" | "artifact_finalize",
  args: Record<string, unknown>,
  context: ToolContext,
) {
  const plugin = await OpenCodePanesPlugin(
    {} as Parameters<typeof OpenCodePanesPlugin>[0],
    {},
  );
  const definition = plugin.tool?.[name] as ToolDefinition | undefined;
  if (!definition) throw new Error(`${name} was not registered`);
  return definition.execute(args, context);
}

function toolContext(): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
  };
}

function getText(url: string) {
  return new Promise<{ status: number; contentType: string; body: string }>(
    (resolve, reject) => {
      const request = get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      request.once("error", reject);
    },
  );
}

function metadata(result: ToolResult) {
  if (typeof result === "string" || !result.metadata) {
    throw new Error("expected metadata result");
  }
  return result.metadata as Record<string, unknown>;
}
