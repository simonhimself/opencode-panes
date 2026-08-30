import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
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
  project = await mkdtemp(join(tmpdir(), "opencode-panes-import-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

describe("artifact_import tool", () => {
  it("copies a directory exactly, including binary bytes and empty directories", async () => {
    const source = join(project, "incoming");
    await mkdir(join(source, "assets", "empty"), { recursive: true });
    const html = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x68, 0x31, 0x3e, 0x0a]);
    const binary = Buffer.from([0x00, 0xff, 0x01, 0xfe]);
    await writeFile(join(source, "index.html"), html);
    await writeFile(join(source, "assets", "payload.bin"), binary);

    const plugin = await createPlugin();
    const result = await execute(plugin, {
      sourcePath: source,
      title: "Imported Site",
      slug: "imported-site",
    });
    const metadata = toolMetadata(result);

    expect(metadata.operation).toBe("imported");
    expect(metadata.verificationReceipt).toEqual(expect.any(String));
    expect(
      await readFile(join(metadata.draftPath as string, "index.html")),
    ).toEqual(html);
    expect(
      await readFile(
        join(metadata.draftPath as string, "assets", "payload.bin"),
      ),
    ).toEqual(binary);
    expect(
      await stat(join(metadata.draftPath as string, "assets", "empty")),
    ).toMatchObject({ isDirectory: expect.any(Function) });
    const finalized = await execute(
      plugin,
      {
        artifactId: metadata.artifactId,
        entryPath: "index.html",
        adapter: "browser",
      },
      "artifact_finalize",
    );
    expect(toolMetadata(finalized)).toMatchObject({
      operation: "finalized",
      version: 1,
    });
    expect(
      await stat(
        join(project, "artifacts", "imported-site", "v1", "assets", "empty"),
      ),
    ).toMatchObject({ isDirectory: expect.any(Function) });
    expect(await readFile(join(source, "index.html"))).toEqual(html);
    expect(await readFile(join(source, "assets", "payload.bin"))).toEqual(
      binary,
    );
  });

  it("supports a one-file source convenience flow through normal finalization", async () => {
    const plugin = await createPlugin();
    const imported = await execute(plugin, {
      title: "Convenience",
      source: "",
      filename: "notes/empty file.txt",
    });
    const metadata = toolMetadata(imported);

    expect(metadata.verificationReceipt).toBeUndefined();
    expect(
      await stat(join(metadata.draftPath as string, "notes", "empty file.txt")),
    ).toMatchObject({ isFile: expect.any(Function) });

    const finalized = await execute(
      plugin,
      {
        artifactId: metadata.artifactId,
        entryPath: "notes/empty file.txt",
        adapter: "renderer",
        renderer: "code",
      },
      "artifact_finalize",
    );
    expect(toolMetadata(finalized)).toMatchObject({
      operation: "finalized",
      version: 1,
    });
    expect(
      await readFile(
        join(
          project,
          "artifacts",
          "convenience",
          "v1",
          "notes",
          "empty file.txt",
        ),
      ),
    ).toEqual(Buffer.alloc(0));
  });

  it("requires an explicit collision choice and never changes the source", async () => {
    const source = join(project, "index.html");
    await writeFile(source, "<h1>replacement</h1>\n");
    const plugin = await createPlugin();
    const first = await execute(plugin, {
      sourcePath: source,
      title: "Collision",
      slug: "collision",
      destinationPath: "index.html",
    });
    const artifactId = toolMetadata(first).artifactId;
    await execute(
      plugin,
      {
        artifactId,
        entryPath: "index.html",
        adapter: "browser",
      },
      "artifact_finalize",
    );

    await expect(
      execute(plugin, {
        artifactId,
        sourcePath: source,
        destinationPath: "index.html",
      }),
    ).rejects.toThrow("collision");
    const replaced = await execute(plugin, {
      artifactId,
      sourcePath: source,
      destinationPath: "index.html",
      collision: "replace",
    });
    expect(toolMetadata(replaced).operation).toBe("imported");
    expect(await readFile(source, "utf8")).toBe("<h1>replacement</h1>\n");
  });

  it("deletes a source only with a confirmed, current verification receipt", async () => {
    const source = join(project, "remove-me.txt");
    await writeFile(source, "keep until confirmed\n");
    const plugin = await createPlugin();
    const imported = await execute(plugin, {
      sourcePath: source,
      title: "Receipt",
      slug: "receipt",
    });
    const importedMetadata = toolMetadata(imported);
    const args = {
      artifactId: importedMetadata.artifactId,
      sourcePath: source,
      verificationReceipt: importedMetadata.verificationReceipt,
      deleteSource: true,
    };

    await expect(execute(plugin, args)).rejects.toThrow("confirmation");
    expect(await stat(source)).toMatchObject({ isFile: expect.any(Function) });

    await execute(plugin, { ...args, confirmDeletion: true });
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      execute(plugin, { ...args, confirmDeletion: true }),
    ).rejects.toThrow("receipt");
  });

  it("refuses receipt deletion after the source changes", async () => {
    const source = join(project, "changed.txt");
    await writeFile(source, "before\n");
    const plugin = await createPlugin();
    const imported = await execute(plugin, {
      sourcePath: source,
      title: "Changed",
      slug: "changed",
    });
    const metadata = toolMetadata(imported);
    await writeFile(source, "after\n");

    await expect(
      execute(plugin, {
        artifactId: metadata.artifactId,
        sourcePath: source,
        verificationReceipt: metadata.verificationReceipt,
        deleteSource: true,
        confirmDeletion: true,
      }),
    ).rejects.toThrow("changed");
    expect(await readFile(source, "utf8")).toBe("after\n");
  });

  it("rejects symlink sources without creating an import Draft", async () => {
    const source = join(project, "real.txt");
    const link = join(project, "link.txt");
    await writeFile(source, "not through a link");
    await symlink(source, link);
    const plugin = await createPlugin();

    await expect(
      execute(plugin, { sourcePath: link, title: "Symlink", slug: "symlink" }),
    ).rejects.toThrow("symlink");
    await expect(
      stat(join(project, "artifacts", "symlink")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires a receipt and does not allow it to be reused", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-29T12:00:00.000Z") });
    try {
      const source = join(project, "expires.txt");
      await writeFile(source, "short lived\n");
      const plugin = await createPlugin();
      const imported = await execute(plugin, {
        sourcePath: source,
        title: "Expires",
        slug: "expires",
      });
      const metadata = toolMetadata(imported);
      vi.advanceTimersByTime(5 * 60 * 1000);

      const deletion = {
        artifactId: metadata.artifactId,
        sourcePath: source,
        verificationReceipt: metadata.verificationReceipt,
        deleteSource: true,
        confirmDeletion: true,
      };
      await expect(execute(plugin, deletion)).rejects.toThrow("expired");
      expect(await stat(source)).toMatchObject({
        isFile: expect.any(Function),
      });
      await expect(execute(plugin, deletion)).rejects.toThrow("receipt");
    } finally {
      vi.useRealTimers();
    }
  });
});

async function createPlugin() {
  return OpenCodePanesPlugin(
    {} as Parameters<typeof OpenCodePanesPlugin>[0],
    {},
  );
}

async function execute(
  plugin: Awaited<ReturnType<typeof OpenCodePanesPlugin>>,
  args: Record<string, unknown>,
  toolName: "artifact_import" | "artifact_finalize" = "artifact_import",
) {
  const definition = plugin.tool?.[toolName] as ToolDefinition | undefined;
  if (!definition) throw new Error(`${toolName} was not registered`);
  return definition.execute(args, toolContext());
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

function toolMetadata(result: ToolResult) {
  if (typeof result === "string" || !result.metadata) {
    throw new Error("expected structured tool result");
  }
  return result.metadata as Record<string, unknown>;
}
