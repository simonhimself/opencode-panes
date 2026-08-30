import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodePanesPlugin } from "../src/index.js";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "opencode-panes-discovery-"));
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(project, { recursive: true, force: true });
});

describe("local artifact discovery and recovery", () => {
  it("discovers a finalized artifact in a later plugin session and reopens it without a Draft", async () => {
    const context = toolContext();
    const prepared = await execute(
      "artifact_prepare",
      { title: "Reopen me" },
      context,
    );
    const artifactId = metadata(prepared).artifactId as string;
    await writeFile(
      join(metadata(prepared).draftPath as string, "index.html"),
      "<h1>hello</h1>",
    );
    const finalized = await execute(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );

    const discovered = await execute("artifact_discover", {}, toolContext());
    expect(metadata(discovered)).toMatchObject({
      operation: "discovered",
      resolution: "all",
      artifacts: [
        expect.objectContaining({
          artifactId,
          slug: "reopen-me",
          latestRevision: 1,
        }),
      ],
    });

    const reopened = await execute(
      "artifact_reopen",
      { artifactId, revision: 1 },
      toolContext(),
    );
    expect(metadata(reopened)).toMatchObject({
      operation: "reopened",
      artifactId,
      version: 1,
    });
    expect(metadata(reopened).previewUrl).not.toBe(
      metadata(finalized).previewUrl,
    );
    expect(
      await readdir(join(project, "artifacts", "reopen-me")),
    ).not.toContain("draft");
    expect(
      (
        await stat(join(project, "artifacts", "reopen-me", "v1", "index.html"))
      ).isFile(),
    ).toBe(true);

    const preparedReopen = await execute(
      "artifact_prepare",
      { artifactId, revision: 1 },
      toolContext(),
    );
    expect(metadata(preparedReopen)).toMatchObject({
      operation: "reopened",
      version: 1,
    });
    expect(
      await readdir(join(project, "artifacts", "reopen-me")),
    ).not.toContain("draft");
  });

  it("returns choices for an ambiguous name without mutating either artifact", async () => {
    const context = toolContext();
    for (const slug of ["first", "second"]) {
      const prepared = await execute(
        "artifact_prepare",
        { title: "Same name", slug },
        context,
      );
      await writeFile(
        join(metadata(prepared).draftPath as string, "index.html"),
        `<h1>${slug}</h1>`,
      );
    }
    const before = await Promise.all(
      ["first", "second"].map(async (slug) =>
        readFile(
          join(project, "artifacts", slug, "draft", "index.html"),
          "utf8",
        ),
      ),
    );

    const result = await execute(
      "artifact_discover",
      { query: "Same name" },
      toolContext(),
    );

    expect(metadata(result)).toMatchObject({
      operation: "discovered",
      resolution: "ambiguous",
      choices: [
        expect.objectContaining({ slug: "first" }),
        expect.objectContaining({ slug: "second" }),
      ],
    });
    expect(
      await Promise.all(
        ["first", "second"].map(async (slug) =>
          readFile(
            join(project, "artifacts", slug, "draft", "index.html"),
            "utf8",
          ),
        ),
      ),
    ).toEqual(before);
  });

  it("blocks a live filesystem lock and recovers a stale lock only after its process is gone", async () => {
    const context = toolContext();
    const prepared = await execute(
      "artifact_prepare",
      { title: "Locked" },
      context,
    );
    const artifactId = metadata(prepared).artifactId as string;
    await writeFile(
      join(metadata(prepared).draftPath as string, "index.html"),
      "<h1>one</h1>",
    );
    await execute(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const artifactDirectory = join(project, "artifacts", "locked");
    const lockPath = join(artifactDirectory, ".panes-lock.json");

    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        ownerId: "other-process",
        createdAt: new Date().toISOString(),
      }),
    );
    await expect(
      execute("artifact_prepare", { artifactId }, toolContext()),
    ).rejects.toThrow("locked");

    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 999999,
        ownerId: "gone-process",
        createdAt: new Date().toISOString(),
      }),
    );
    const recovered = await execute(
      "artifact_prepare",
      { artifactId },
      toolContext(),
    );
    expect(metadata(recovered).operation).toBe("prepared");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits on fresh partial locks and reclaims only stale malformed locks", async () => {
    const context = toolContext();
    const prepared = await execute(
      "artifact_prepare",
      { title: "Malformed lock" },
      context,
    );
    const artifactId = metadata(prepared).artifactId as string;
    await writeFile(
      join(metadata(prepared).draftPath as string, "index.html"),
      "<h1>one</h1>",
    );
    await execute(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const lockPath = join(
      project,
      "artifacts",
      "malformed-lock",
      ".panes-lock.json",
    );

    await writeFile(lockPath, "");
    let settled = false;
    const waiting = execute(
      "artifact_prepare",
      { artifactId },
      context,
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await rm(lockPath);
    await waiting;
    expect(settled).toBe(true);

    await writeFile(lockPath, "{");
    const stale = new Date(Date.now() - 2 * 60 * 1000);
    await utimes(lockPath, stale, stale);
    const recovered = await execute(
      "artifact_prepare",
      { artifactId },
      context,
    );
    expect(metadata(recovered).operation).toBe("prepared");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a finalized revision as changed until Git-style restoration makes the next scan valid", async () => {
    const context = toolContext();
    const prepared = await execute(
      "artifact_prepare",
      { title: "Restorable" },
      context,
    );
    const artifactId = metadata(prepared).artifactId as string;
    await writeFile(
      join(metadata(prepared).draftPath as string, "index.html"),
      "<h1>original</h1>",
    );
    await execute(
      "artifact_finalize",
      { artifactId, entryPath: "index.html", adapter: "browser" },
      context,
    );
    const revisionPath = join(
      project,
      "artifacts",
      "restorable",
      "v1",
      "index.html",
    );
    await writeFile(revisionPath, "<h1>checkout changed</h1>");

    const changed = await execute(
      "artifact_discover",
      { query: artifactId },
      toolContext(),
    );
    expect(metadata(changed).artifacts).toEqual([
      expect.objectContaining({ artifactId, integrity: "modified" }),
    ]);

    await writeFile(revisionPath, "<h1>original</h1>");
    const restored = await execute(
      "artifact_discover",
      { query: artifactId },
      toolContext(),
    );
    expect(metadata(restored).artifacts).toEqual([
      expect.objectContaining({ artifactId, integrity: "valid" }),
    ]);
  });
});

async function execute(
  name:
    | "artifact_prepare"
    | "artifact_finalize"
    | "artifact_discover"
    | "artifact_reopen",
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

function metadata(result: ToolResult) {
  if (typeof result === "string" || !result.metadata)
    throw new Error("expected metadata result");
  return result.metadata as Record<string, any>;
}
