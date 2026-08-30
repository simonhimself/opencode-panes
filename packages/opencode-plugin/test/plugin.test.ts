import { execFile } from "node:child_process";
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
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { artifactManifestSchema } from "@opencode-panes/contracts";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodePanesPlugin } from "../src/index.js";

const execFileAsync = promisify(execFile);

let stateHome: string;
let temporaryDirectory: string;

beforeEach(async () => {
  stateHome = await mkdtemp(join(tmpdir(), "opencode-panes-test-"));
  temporaryDirectory = await mkdtemp(join(tmpdir(), "opencode-panes-project-"));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(stateHome, { recursive: true, force: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Legacy adoption tool", () => {
  it("adopts a Legacy payload into an unchanged finalized local v1", async () => {
    const repository = await gitRepository();
    const source = "\uFEFF<html>\r\n\0café</html>\r\n";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        apiOrigin: string;
        localProjectId: string;
        localArtifactId: string;
        slug: string;
      };
      return jsonResponse({
        operation: "legacy-adopted",
        apiOrigin: request.apiOrigin,
        localProjectId: request.localProjectId,
        localArtifactId: request.localArtifactId,
        slug: request.slug,
        title: "Adopted example",
        type: "html",
        source,
        provenance: {
          grantId: "adoption-grant-1",
          localProjectId: request.localProjectId,
          localArtifactId: request.localArtifactId,
          localSlug: request.slug,
          legacyArtifactId: "legacy-artifact-1",
          legacyRevisionId: "legacy-revision-1",
          legacyRevisionVersion: 1,
          legacyTitle: "Adopted example",
          legacyType: "html",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext({
      directory: repository,
      worktree: repository,
    });
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const definition = plugin.tool?.artifact_adopt_legacy as
      ToolDefinition | undefined;
    if (!definition) throw new Error("Legacy adoption tool was not registered");

    const result = await definition.execute(
      {
        artifactId: "legacy-artifact-1",
        adoptionCode: "panes-adopt-legacy-" + "a".repeat(32),
        slug: "adopted-example",
      },
      context,
    );

    const artifact = JSON.parse(
      await readFile(
        join(repository, "artifacts", "adopted-example", "artifact.json"),
        "utf8",
      ),
    ) as ReturnType<typeof artifactManifestSchema.parse>;
    expect(artifact.revisions).toHaveLength(1);
    expect(artifact.legacyProvenance?.legacyArtifactId).toBe(
      "legacy-artifact-1",
    );
    expect(
      await readFile(
        join(repository, "artifacts", "adopted-example", "v1", "index.html"),
        "utf8",
      ),
    ).toBe(source);
    expect(structuredResult(result).metadata).toMatchObject({
      operation: "finalized",
      version: 1,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:5173/api/adopt/legacy/legacy-artifact-1",
    );
  });

  it("reuses a digest-only adoption checkpoint after an interrupted redemption", async () => {
    const repository = await gitRepository();
    const source = "\uFEFF<html>\r\n\0retry</html>\r\n";
    const fetchMock = mockConsumedLegacyAdoptionFetch(source, "artifact-retry");
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext({
      directory: repository,
      worktree: repository,
    });
    const failureInjector = (phase: string) => {
      if (phase === "adopt-after-redeem") {
        throw new Error("simulated interruption");
      }
    };
    const firstPlugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      { failureInjector },
    );
    const firstDefinition = firstPlugin.tool?.artifact_adopt_legacy as
      ToolDefinition | undefined;
    if (!firstDefinition)
      throw new Error("Legacy adoption tool was not registered");

    await expect(
      firstDefinition.execute(
        {
          artifactId: "legacy-artifact-retry",
          adoptionCode: "panes-adopt-legacy-" + "b".repeat(32),
          slug: "retry-example",
        },
        context,
      ),
    ).rejects.toThrow("simulated interruption");
    expect(
      await stat(join(repository, "artifacts", "retry-example")),
    ).toBeTruthy();

    const checkpointFiles = await findFiles(join(stateHome, "opencode-panes"));
    expect(checkpointFiles).toHaveLength(1);
    const checkpointContents = await readFile(
      checkpointFiles[0] as string,
      "utf8",
    );
    expect(checkpointContents).not.toContain("panes-adopt-legacy-");
    expect(JSON.parse(checkpointContents)).toMatchObject({
      phase: "redeemed",
      slug: "retry-example",
    });

    const retryPlugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const retryDefinition = retryPlugin.tool?.artifact_adopt_legacy as
      ToolDefinition | undefined;
    if (!retryDefinition)
      throw new Error("Legacy adoption tool was not registered");
    await retryDefinition.execute(
      {
        artifactId: "legacy-artifact-retry",
        adoptionCode: "panes-adopt-legacy-" + "b".repeat(32),
        slug: "retry-example",
      },
      context,
    );
    const manifest = JSON.parse(
      await readFile(
        join(repository, "artifacts", "retry-example", "artifact.json"),
        "utf8",
      ),
    ) as { artifactId: string };
    expect(manifest.artifactId).toBe(JSON.parse(checkpointContents).artifactId);
    expect(await findFiles(join(stateHome, "opencode-panes"))).toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as { localArtifactId: string };
    const secondRequest = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { localArtifactId: string };
    expect(secondRequest.localArtifactId).toBe(firstRequest.localArtifactId);
    expect(
      await readFile(
        join(repository, "artifacts", "retry-example", "v1", "index.html"),
        "utf8",
      ),
    ).toBe(source);
    await expect(
      retryDefinition.execute(
        {
          artifactId: "legacy-artifact-retry",
          adoptionCode: "panes-adopt-legacy-" + "b".repeat(32),
          slug: "hijacked-retry",
        },
        context,
      ),
    ).rejects.toThrow("already bound");
  });

  it("recovers when redemption succeeds but its response is lost", async () => {
    const repository = await gitRepository();
    const source = "<h1>response loss</h1>\r\n";
    const fetchMock = mockConsumedLegacyAdoptionFetch(source, "response-loss");
    const context = toolContext({
      directory: repository,
      worktree: repository,
    }).context;
    const firstPlugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {
        failureInjector: (phase: string) => {
          if (phase === "adopt-after-redemption-response")
            throw new Error("simulated response loss");
        },
      },
    );
    const firstDefinition = firstPlugin.tool
      ?.artifact_adopt_legacy as ToolDefinition;
    const args = {
      artifactId: "legacy-response-loss",
      adoptionCode: "panes-adopt-legacy-" + "f".repeat(32),
      slug: "response-loss",
    };
    await expect(firstDefinition.execute(args, context)).rejects.toThrow(
      "simulated response loss",
    );
    const checkpointFiles = await findFiles(join(stateHome, "opencode-panes"));
    expect(checkpointFiles).toHaveLength(1);
    const checkpoint = JSON.parse(
      await readFile(checkpointFiles[0] as string, "utf8"),
    ) as { artifactId: string; phase: string; slug: string };
    expect(checkpoint).toMatchObject({
      phase: "planned",
      slug: args.slug,
    });

    const retryPlugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const retryDefinition = retryPlugin.tool
      ?.artifact_adopt_legacy as ToolDefinition;
    const result = await retryDefinition.execute(args, context);
    const manifest = JSON.parse(
      await readFile(
        join(repository, "artifacts", args.slug, "artifact.json"),
        "utf8",
      ),
    ) as { artifactId: string; slug: string; revisions: unknown[] };
    expect(manifest).toMatchObject({
      artifactId: checkpoint.artifactId,
      slug: checkpoint.slug,
    });
    expect(manifest.revisions).toHaveLength(1);
    expect(structuredResult(result).metadata?.version).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await findFiles(join(stateHome, "opencode-panes"))).toEqual([]);
    expect(
      (await readdir(join(repository, "artifacts", args.slug))).filter(
        (entry) => entry.includes("journal") || entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("recovers an orphaned adoption manifest temp file after interruption", async () => {
    const repository = await gitRepository();
    const source = "\uFEFF<html>\r\n\0manifest-retryé</html>\r\n";
    const fetchMock = mockLegacyAdoptionFetch(source, "manifest-retry");
    let interrupted = true;
    const context = toolContext({
      directory: repository,
      worktree: repository,
    }).context;
    const firstPlugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {
        failureInjector: (phase: string) => {
          if (phase === "adopt-after-manifest-temp-write" && interrupted) {
            interrupted = false;
            throw new Error("simulated manifest interruption");
          }
        },
      },
    );
    const firstDefinition = firstPlugin.tool?.artifact_adopt_legacy as
      ToolDefinition | undefined;
    if (!firstDefinition)
      throw new Error("Legacy adoption tool was not registered");
    const args = {
      artifactId: "legacy-manifest-retry",
      adoptionCode: "panes-adopt-legacy-" + "c".repeat(32),
      slug: "manifest-retry",
    };

    await expect(firstDefinition.execute(args, context)).rejects.toThrow(
      "simulated manifest interruption",
    );
    const artifactDirectory = join(repository, "artifacts", "manifest-retry");
    const interruptedEntries = await readdir(artifactDirectory);
    expect(
      interruptedEntries.some(
        (entry) =>
          entry.startsWith(".artifact.json.adopt-") && entry.endsWith(".tmp"),
      ),
    ).toBe(true);

    const retryPlugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const retryDefinition = retryPlugin.tool?.artifact_adopt_legacy as
      ToolDefinition | undefined;
    if (!retryDefinition)
      throw new Error("Legacy adoption tool was not registered");
    const result = await retryDefinition.execute(args, context);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (await readdir(artifactDirectory)).filter(
        (entry) =>
          entry.startsWith(".artifact.json.adopt-") ||
          entry.includes("journal"),
      ),
    ).toEqual([]);
    expect(
      await readFile(join(artifactDirectory, "v1", "index.html"), "utf8"),
    ).toBe(source);
    expect(structuredResult(result).metadata?.version).toBe(1);
  });

  it("serializes concurrent same-code adoption calls onto one local binding", async () => {
    const repository = await gitRepository();
    const fetchMock = mockLegacyAdoptionFetch(
      "<h1>concurrent</h1>\r\n",
      "concurrent",
    );
    const context = toolContext({
      directory: repository,
      worktree: repository,
    }).context;
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const definition = plugin.tool?.artifact_adopt_legacy as ToolDefinition;
    const args = {
      artifactId: "legacy-concurrent",
      adoptionCode: "panes-adopt-legacy-" + "d".repeat(32),
      slug: "concurrent",
    };

    const [first, second] = await Promise.all([
      definition.execute(args, context),
      definition.execute(args, context),
    ]);
    const firstMetadata = structuredResult(first).metadata;
    const secondMetadata = structuredResult(second).metadata;
    expect(firstMetadata?.artifactId).toBe(secondMetadata?.artifactId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      await readFile(
        join(repository, "artifacts", "concurrent", "v1", "index.html"),
        "utf8",
      ),
    ).toBe("<h1>concurrent</h1>\r\n");
  });

  it("serializes the global adoption checkpoint across project roots", async () => {
    const firstRepository = await gitRepository("git@example.com:first.git");
    const secondRepository = await gitRepository("git@example.com:second.git");
    let releaseFirstRedemption!: () => void;
    let firstRedemptionStarted!: () => void;
    const firstStarted = new Promise<void>(
      (resolve) => (firstRedemptionStarted = resolve),
    );
    const release = new Promise<void>(
      (resolve) => (releaseFirstRedemption = resolve),
    );
    let requestCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        apiOrigin: string;
        localProjectId: string;
        localArtifactId: string;
        slug: string;
      };
      requestCount += 1;
      if (requestCount === 1) {
        firstRedemptionStarted();
        await release;
      }
      return jsonResponse({
        operation: "legacy-adopted",
        apiOrigin: request.apiOrigin,
        localProjectId: request.localProjectId,
        localArtifactId: request.localArtifactId,
        slug: request.slug,
        title: "Cross-project adoption",
        type: "html",
        source: "<h1>cross-project</h1>",
        provenance: {
          grantId: "adoption-grant-cross-project",
          localProjectId: request.localProjectId,
          localArtifactId: request.localArtifactId,
          localSlug: request.slug,
          legacyArtifactId: "legacy-cross-project",
          legacyRevisionId: "revision-cross-project",
          legacyRevisionVersion: 1,
          legacyTitle: "Cross-project adoption",
          legacyType: "html",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const definition = plugin.tool?.artifact_adopt_legacy as ToolDefinition;
    const args = {
      artifactId: "legacy-cross-project",
      adoptionCode: "panes-adopt-legacy-" + "9".repeat(32),
      slug: "cross-project",
    };
    const first = definition.execute(
      args,
      toolContext({
        directory: firstRepository,
        worktree: firstRepository,
      }).context,
    );
    await firstStarted;
    const second = definition.execute(
      args,
      toolContext({
        directory: secondRepository,
        worktree: secondRepository,
      }).context,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstRedemption();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toMatchObject({
      message: expect.stringContaining("already bound"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      await stat(join(firstRepository, "artifacts", "cross-project", "v1")),
    ).toMatchObject({ isDirectory: expect.any(Function) });
    await expect(
      stat(join(secondRepository, "artifacts", "cross-project")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps expired completed adoptions and evicts the oldest cache entry", async () => {
    vi.useFakeTimers();
    try {
      const repository = await gitRepository();
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          apiOrigin: string;
          localProjectId: string;
          localArtifactId: string;
          slug: string;
        };
        return jsonResponse({
          operation: "legacy-adopted",
          apiOrigin: request.apiOrigin,
          localProjectId: request.localProjectId,
          localArtifactId: request.localArtifactId,
          slug: request.slug,
          title: request.slug,
          type: "html",
          source: `<h1>${request.slug}</h1>`,
          provenance: {
            grantId: `adoption-grant-${request.slug}`,
            localProjectId: request.localProjectId,
            localArtifactId: request.localArtifactId,
            localSlug: request.slug,
            legacyArtifactId: `legacy-${request.slug}`,
            legacyRevisionId: `revision-${request.slug}`,
            legacyRevisionVersion: 1,
            legacyTitle: request.slug,
            legacyType: "html",
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const plugin = await OpenCodePanesPlugin(
        {} as Parameters<typeof OpenCodePanesPlugin>[0],
        {},
      );
      const definition = plugin.tool?.artifact_adopt_legacy as ToolDefinition;
      const argsFor = (index: number) => ({
        artifactId: `legacy-cache-${index}`,
        adoptionCode: `panes-adopt-legacy-${index.toString(16).padStart(2, "0")}${"a".repeat(30)}`,
        slug: `cache-${index}`,
      });
      for (let index = 0; index < 17; index += 1) {
        await definition.execute(
          argsFor(index),
          toolContext({ directory: repository, worktree: repository }).context,
        );
      }
      const callsAfterInitialAdoptions = fetchMock.mock.calls.length;
      await expect(
        definition.execute(
          argsFor(0),
          toolContext({ directory: repository, worktree: repository }).context,
        ),
      ).rejects.toThrow("does not match its checkpoint");
      await definition.execute(
        argsFor(1),
        toolContext({ directory: repository, worktree: repository }).context,
      );
      expect(fetchMock).toHaveBeenCalledTimes(callsAfterInitialAdoptions);

      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await expect(
        definition.execute(
          argsFor(1),
          toolContext({ directory: repository, worktree: repository }).context,
        ),
      ).rejects.toThrow("does not match its checkpoint");
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("maps every Legacy renderer to a finalized exact-byte local v1 preview", async () => {
    const repository = await gitRepository();
    const cases = [
      {
        type: "html" as const,
        filename: "index.html",
        source: "\uFEFF<html>\r\n\0café</html>\r\n",
        adapter: "browser" as const,
      },
      {
        type: "svg" as const,
        filename: "index.svg",
        source: "\uFEFF<svg>\r\n\0café</svg>\r\n",
        adapter: "browser" as const,
      },
      {
        type: "react" as const,
        filename: "App.tsx",
        source: "\uFEFFexport default function App(){return <p>café</p>}\r\n",
        adapter: "renderer" as const,
        renderer: "react" as const,
      },
      {
        type: "markdown" as const,
        filename: "README.md",
        source: "\uFEFF# café\r\n\0\r\n",
        adapter: "renderer" as const,
        renderer: "markdown" as const,
      },
      {
        type: "mermaid" as const,
        filename: "diagram.mmd",
        source: "\uFEFFflowchart TD\r\nA[café] --> B\r\n",
        adapter: "renderer" as const,
        renderer: "mermaid" as const,
      },
      {
        type: "code" as const,
        filename: "source.txt",
        source: "\uFEFFconst café = '\0';\r\n",
        adapter: "renderer" as const,
        renderer: "code" as const,
      },
    ];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        apiOrigin: string;
        localProjectId: string;
        localArtifactId: string;
        slug: string;
        code: string;
      };
      const selected = cases.find(({ type }) => request.slug === `all-${type}`);
      if (!selected) throw new Error("unknown adoption test case");
      return jsonResponse({
        operation: "legacy-adopted",
        apiOrigin: request.apiOrigin,
        localProjectId: request.localProjectId,
        localArtifactId: request.localArtifactId,
        slug: request.slug,
        title: `Legacy ${selected.type}`,
        type: selected.type,
        source: selected.source,
        provenance: {
          grantId: `adoption-grant-all-${selected.type}`,
          localProjectId: request.localProjectId,
          localArtifactId: request.localArtifactId,
          localSlug: request.slug,
          legacyArtifactId: `legacy-all-${selected.type}`,
          legacyRevisionId: `revision-all-${selected.type}`,
          legacyRevisionVersion: 1,
          legacyTitle: `Legacy ${selected.type}`,
          legacyType: selected.type,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const definition = plugin.tool?.artifact_adopt_legacy as ToolDefinition;
    const results: Array<{
      result: ToolResult;
      code: string;
      previewUrl: string;
    }> = [];
    for (const [index, selected] of cases.entries()) {
      const code = `panes-adopt-legacy-${index.toString(16)}${"e".repeat(31)}`;
      const result = await definition.execute(
        {
          artifactId: `legacy-all-${selected.type}`,
          adoptionCode: code,
          slug: `all-${selected.type}`,
        },
        toolContext({ directory: repository, worktree: repository }).context,
      );
      const metadata = structuredResult(result).metadata as {
        artifactId: string;
        preview: { adapter: string; renderer?: string };
        previewUrl: string;
      };
      expect(metadata.preview.adapter).toBe(selected.adapter);
      expect(metadata.preview.renderer).toBe(selected.renderer);
      results.push({ result, code, previewUrl: metadata.previewUrl });

      const manifest = JSON.parse(
        await readFile(
          join(
            repository,
            "artifacts",
            `all-${selected.type}`,
            "artifact.json",
          ),
          "utf8",
        ),
      ) as ReturnType<typeof artifactManifestSchema.parse>;
      expect(manifest.revisions).toHaveLength(1);
      expect(manifest.revisions[0]?.preview).toEqual({
        adapter: selected.adapter,
        entryPath: selected.filename,
        ...(selected.renderer ? { renderer: selected.renderer } : {}),
      });
      expect(
        await readFile(
          join(
            repository,
            "artifacts",
            `all-${selected.type}`,
            "v1",
            selected.filename,
          ),
        ),
      ).toEqual(Buffer.from(selected.source, "utf8"));
      const serialized = JSON.stringify({ manifest, result });
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain("owner-secret");
    }
    vi.unstubAllGlobals();
    for (const { previewUrl } of results) {
      expect((await fetch(previewUrl)).status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(cases.length);

    const adoptedArtifactId = structuredResult(results[0]!.result).metadata
      ?.artifactId as string;
    const prepared = await (
      plugin.tool?.artifact_prepare as ToolDefinition
    ).execute(
      { artifactId: adoptedArtifactId, requestedOrigins: [] },
      toolContext({ directory: repository, worktree: repository }).context,
    );
    const draftPath = structuredResult(prepared).metadata?.draftPath as string;
    await writeFile(join(draftPath, "index.html"), "<h1>v2</h1>\r\n");
    const finalized = await (
      plugin.tool?.artifact_finalize as ToolDefinition
    ).execute(
      {
        artifactId: adoptedArtifactId,
        entryPath: "index.html",
        adapter: "browser",
      },
      toolContext({ directory: repository, worktree: repository }).context,
    );
    expect(structuredResult(finalized).metadata).toMatchObject({
      artifactId: adoptedArtifactId,
      version: 2,
    });
    expect(
      await readFile(
        join(repository, "artifacts", "all-html", "v2", "index.html"),
        "utf8",
      ),
    ).toBe("<h1>v2</h1>\r\n");
  }, 10_000);
});

describe("artifact_prepare tool", () => {
  it("creates a Git-project artifact manifest and writable draft without fetching", async () => {
    const repository = await gitRepository(
      "git@github.com:Example/Prototype.git",
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executePrepare(
      { title: "Landing Page", requestedOrigins: [] },
      toolContext({ directory: repository, worktree: repository }).context,
    );

    const artifactDirectory = join(repository, "artifacts", "landing-page");
    const manifest = JSON.parse(
      await readFile(join(artifactDirectory, "artifact.json"), "utf8"),
    );
    const draft = JSON.parse(
      await readFile(join(artifactDirectory, "draft.json"), "utf8"),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(artifactManifestSchema.parse(manifest)).toMatchObject({
      schemaVersion: 1,
      projectId: "https://github.com/example/prototype",
      artifactId: manifest.artifactId,
      slug: "landing-page",
      title: "Landing Page",
      revisions: [],
    });
    expect(draft).toMatchObject({
      artifactId: manifest.artifactId,
      baseRevision: null,
      requestedOrigins: [],
    });
    expect(await stat(join(artifactDirectory, "draft"))).toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect(structuredResult(result).metadata).toMatchObject({
      operation: "created",
      artifactId: manifest.artifactId,
      projectId: "https://github.com/example/prototype",
      slug: "landing-page",
      draftPath: join(resolve(artifactDirectory), "draft"),
      baseRevision: null,
    });
  });

  it("uses the session directory for a non-Git session and persists generated project identity", async () => {
    const session = join(temporaryDirectory, "session");
    await mkdir(session, { recursive: true });
    const context = toolContext({
      directory: session,
      worktree: join(session, "missing"),
    });

    const first = await executePrepare({ title: "First" }, context.context);
    const firstMetadata = structuredResult(first).metadata;
    const second = await executePrepare({ title: "Second" }, context.context);
    const secondMetadata = structuredResult(second).metadata;

    expect(firstMetadata?.draftPath).toContain(join(session, "artifacts"));
    expect(secondMetadata?.projectId).toBe(firstMetadata?.projectId);
    expect(secondMetadata?.artifactId).not.toBe(firstMetadata?.artifactId);
    expect(
      await stat(join(session, "artifacts", ".panes-project.json")),
    ).toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it("copies the latest finalized revision into a new draft without changing the revision", async () => {
    const repository = await gitRepository();
    const artifactDirectory = join(repository, "artifacts", "existing");
    await mkdir(join(artifactDirectory, "v1", "assets"), { recursive: true });
    await writeFile(
      join(artifactDirectory, "v1", "index.html"),
      "<h1>Original</h1>\n",
    );
    await writeFile(
      join(artifactDirectory, "v1", "assets", "data.bin"),
      Buffer.from([0, 255, 1]),
    );
    await writeFile(
      join(artifactDirectory, "artifact.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: "project-1",
        artifactId: "artifact-1",
        slug: "existing",
        title: "Existing",
        revisions: [
          {
            id: "revision-1",
            version: 1,
            preview: { adapter: "browser", entryPath: "index.html" },
            approvedOrigins: [],
            files: [],
            createdAt: "2026-08-17T12:00:00.000Z",
          },
        ],
      })}\n`,
    );

    const result = await executePrepare(
      {
        artifactId: "artifact-1",
        requestedOrigins: ["https://api.example.com/"],
      },
      toolContext({ directory: repository, worktree: repository }).context,
    );

    const draftPath = structuredResult(result).metadata?.draftPath as string;
    expect(await readFile(join(draftPath, "index.html"), "utf8")).toBe(
      "<h1>Original</h1>\n",
    );
    expect(await readFile(join(draftPath, "assets", "data.bin"))).toEqual(
      Buffer.from([0, 255, 1]),
    );
    expect(
      await readFile(join(artifactDirectory, "v1", "index.html"), "utf8"),
    ).toBe("<h1>Original</h1>\n");
    expect(structuredResult(result).metadata).toMatchObject({
      operation: "prepared",
      artifactId: "artifact-1",
      baseRevision: 1,
      requestedOrigins: ["https://api.example.com"],
    });
  });

  it("requires an explicit choice for slug collisions and existing drafts", async () => {
    const repository = await gitRepository();
    const context = toolContext({
      directory: repository,
      worktree: repository,
    }).context;
    const created = await executePrepare({ title: "Collision" }, context);

    await expect(
      executePrepare(
        { title: "Collision", idempotencyKey: "different-request" },
        context,
      ),
    ).rejects.toThrow("already exists");

    const artifactId = structuredResult(created).metadata?.artifactId as string;
    await expect(
      executePrepare(
        { artifactId, requestedOrigins: ["https://different.example"] },
        context,
      ),
    ).rejects.toThrow("Draft already exists");

    const resumed = await executePrepare(
      { artifactId, requestedOrigins: [], draftAction: "resume" },
      context,
    );
    expect(structuredResult(resumed).metadata).toMatchObject({
      operation: "created",
      artifactId,
    });

    const resumedDraftPath = structuredResult(resumed).metadata
      ?.draftPath as string;
    await writeFile(join(resumedDraftPath, "discard-me.txt"), "temporary");
    const discarded = await executePrepare(
      { artifactId, requestedOrigins: [], draftAction: "discard" },
      context,
    );
    expect(structuredResult(discarded).metadata?.operation).toBe("prepared");
    await expect(
      stat(join(resumedDraftPath, "discard-me.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the existing state for a repeated idempotent request", async () => {
    const repository = await gitRepository();
    const context = toolContext({
      directory: repository,
      worktree: repository,
    }).context;
    const request = {
      title: "Repeatable",
      requestedOrigins: ["https://api.example.com"],
      idempotencyKey: "prepare-repeat-1",
    };

    const first = await executePrepare(request, context);
    const second = await executePrepare(request, context);

    expect(structuredResult(second).metadata).toEqual(
      structuredResult(first).metadata,
    );
    expect(await readdir(join(repository, "artifacts", "repeatable"))).toEqual(
      expect.arrayContaining(["artifact.json", "draft", "draft.json"]),
    );
  });
});

describe("plugin options", () => {
  it.each([99, 120_001, 1.5, "15000", null])(
    "rejects invalid requestTimeoutMs value %p",
    async (requestTimeoutMs) => {
      await expect(
        OpenCodePanesPlugin({} as Parameters<typeof OpenCodePanesPlugin>[0], {
          requestTimeoutMs: requestTimeoutMs as never,
        }),
      ).rejects.toThrow(
        "Panes plugin option requestTimeoutMs must be an integer from 100 to 120000",
      );
    },
  );

  it("accepts the supported requestTimeoutMs range", async () => {
    await expect(
      OpenCodePanesPlugin({} as Parameters<typeof OpenCodePanesPlugin>[0], {
        requestTimeoutMs: 100,
      }),
    ).resolves.toBeDefined();
    await expect(
      OpenCodePanesPlugin({} as Parameters<typeof OpenCodePanesPlugin>[0], {
        requestTimeoutMs: 120_000,
      }),
    ).resolves.toBeDefined();
  });
});

async function executePrepare(
  args: {
    artifactId?: string;
    title?: string;
    slug?: string;
    kind?: string;
    requestedOrigins?: string[];
    draftAction?: "resume" | "discard";
    idempotencyKey?: string;
  },
  context: ToolContext,
) {
  const plugin = await OpenCodePanesPlugin(
    {} as Parameters<typeof OpenCodePanesPlugin>[0],
    {},
  );
  const definition = plugin.tool?.artifact_prepare as
    ToolDefinition | undefined;
  if (!definition) throw new Error("artifact_prepare tool was not registered");
  return definition.execute(args, context);
}

function toolContext(
  overrides: Partial<Pick<ToolContext, "directory" | "worktree">> = {},
  ask = vi.fn<ToolContext["ask"]>().mockResolvedValue(),
) {
  const context: ToolContext = {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory: overrides.directory ?? "/project",
    worktree: overrides.worktree ?? "/project",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask,
  };
  return { context, ask };
}

async function gitRepository(remote?: string) {
  const repository = join(temporaryDirectory, `repo-${randomSuffix()}`);
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q", repository]);
  if (remote) {
    await execFileAsync("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      remote,
    ]);
  }
  return repository;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockLegacyAdoptionFetch(source: string, suffix: string) {
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      apiOrigin: string;
      localProjectId: string;
      localArtifactId: string;
      slug: string;
    };
    return jsonResponse({
      operation: "legacy-adopted",
      apiOrigin: request.apiOrigin,
      localProjectId: request.localProjectId,
      localArtifactId: request.localArtifactId,
      slug: request.slug,
      title: suffix,
      type: "html",
      source,
      provenance: {
        grantId: `adoption-grant-${suffix}`,
        localProjectId: request.localProjectId,
        localArtifactId: request.localArtifactId,
        localSlug: request.slug,
        legacyArtifactId: `legacy-${suffix}`,
        legacyRevisionId: `revision-${suffix}`,
        legacyRevisionVersion: 1,
        legacyTitle: suffix,
        legacyType: "html",
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockConsumedLegacyAdoptionFetch(source: string, suffix: string) {
  let binding:
    | { localProjectId: string; localArtifactId: string; slug: string }
    | undefined;
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      apiOrigin: string;
      localProjectId: string;
      localArtifactId: string;
      slug: string;
    };
    const nextBinding = {
      localProjectId: request.localProjectId,
      localArtifactId: request.localArtifactId,
      slug: request.slug,
    };
    if (
      binding &&
      (binding.localProjectId !== nextBinding.localProjectId ||
        binding.localArtifactId !== nextBinding.localArtifactId ||
        binding.slug !== nextBinding.slug)
    ) {
      return jsonResponse(
        {
          error: { code: "FORBIDDEN", message: "Adoption request is invalid" },
        },
        403,
      );
    }
    binding ??= nextBinding;
    return jsonResponse({
      operation: "legacy-adopted",
      apiOrigin: request.apiOrigin,
      localProjectId: request.localProjectId,
      localArtifactId: request.localArtifactId,
      slug: request.slug,
      title: suffix,
      type: "html",
      source,
      provenance: {
        grantId: `adoption-grant-${suffix}`,
        localProjectId: request.localProjectId,
        localArtifactId: request.localArtifactId,
        localSlug: request.slug,
        legacyArtifactId: `legacy-${suffix}`,
        legacyRevisionId: `revision-${suffix}`,
        legacyRevisionVersion: 1,
        legacyTitle: suffix,
        legacyType: "html",
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function structuredResult(result: ToolResult) {
  if (typeof result === "string") throw new Error("expected structured result");
  return result;
}

async function findFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
