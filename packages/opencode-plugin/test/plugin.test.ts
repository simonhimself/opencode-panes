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

import {
  MAX_ARTIFACT_SOURCE_BYTES,
  artifactManifestSchema,
  type ArtifactType,
} from "@opencode-panes/contracts";
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodePanesPlugin, type PanesPluginOptions } from "../src/index.js";

const LOCAL_API = "http://127.0.0.1:5173";
const REMOTE_API = "https://panes.example";
const OWNER_TOKEN = "owner-secret-token";
const WORKSPACE_TOKEN = "workspace-secret-token";
const SOURCE = "<h1>Hello</h1>";
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

describe("artifact tool", () => {
  it("instructs models to preserve the complete credentialed viewer URL", async () => {
    const plugin = await OpenCodePanesPlugin(
      {} as Parameters<typeof OpenCodePanesPlugin>[0],
      {},
    );
    const definition = plugin.tool?.artifact as ToolDefinition | undefined;

    expect(definition?.description).toContain(
      "present viewerUrl exactly as returned, including its fragment",
    );
  });

  it("creates an artifact with the session ID and persists its owner token", async () => {
    const fetchMock = mockFetch(createResponse());
    const { context, ask } = toolContext();
    const result = await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${LOCAL_API}/api/artifacts`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Example",
      type: "html",
      source: SOURCE,
      sessionId: "session-1",
    });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(ask).toHaveBeenCalledWith({
      permission: "artifact_upload",
      patterns: [LOCAL_API],
      always: [LOCAL_API],
      metadata: {
        endpoint: LOCAL_API,
        operation: "create",
        title: "Example",
      },
    });
    expect(result).toMatchObject({
      title: "Created Example",
      metadata: {
        artifactId: "artifact-1",
        title: "Example",
        version: 1,
        viewerUrl: viewerUrl(LOCAL_API),
      },
    });
    expect(structuredResult(result).attachments).toBeUndefined();

    const stateFile = await onlyStateFile();
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    expect(state).toMatchObject({
      apiOrigin: LOCAL_API,
      artifactId: "artifact-1",
      ownerToken: OWNER_TOKEN,
      viewerUrl: viewerUrl(LOCAL_API),
    });
    if (process.platform !== "win32") {
      expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    }
  });

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
      `${LOCAL_API}/api/adopt/legacy/legacy-artifact-1`,
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
  });

  it("updates with the persisted token and never exposes that token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse()))
      .mockResolvedValueOnce(jsonResponse(revisionResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const { context, ask } = toolContext();

    await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
    );
    const result = await executeArtifact(
      {
        artifactId: "artifact-1",
        title: "Example",
        type: "html",
        source: "<h1>Version two</h1>",
      },
      context,
    );

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toBe(`${LOCAL_API}/api/artifacts/artifact-1/revisions`);
    expect(String(url)).not.toContain(WORKSPACE_TOKEN);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${OWNER_TOKEN}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      source: "<h1>Version two</h1>",
    });
    expect(structuredResult(result).metadata).toMatchObject({
      operation: "updated",
      artifactId: "artifact-1",
      version: 2,
      viewerUrl: viewerUrl(LOCAL_API),
    });
    expect(ask).toHaveBeenNthCalledWith(2, {
      permission: "artifact_upload",
      patterns: [LOCAL_API],
      always: [LOCAL_API],
      metadata: {
        endpoint: LOCAL_API,
        operation: "update",
        title: "Example",
      },
    });
    expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
  });

  it("returns only non-source artifact metadata", async () => {
    mockFetch(createResponse());
    const result = await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      toolContext().context,
    );

    const structured = structuredResult(result);
    const expected = {
      artifactId: "artifact-1",
      version: 1,
      title: "Example",
      type: "html",
      viewerUrl: viewerUrl(LOCAL_API),
      operation: "created",
      autoOpen: "disabled",
    };
    expect(structured.metadata).toEqual(expected);
    expect(JSON.parse(structured.output)).toEqual(expected);
    expect(structured.attachments).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SOURCE);
  });

  it("sends the optional creation key only on artifact creation", async () => {
    const createKey = "protected-create-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse()))
      .mockResolvedValueOnce(jsonResponse(revisionResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext();

    const created = await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
      { createApiKey: createKey },
    );
    await executeArtifact(
      {
        artifactId: "artifact-1",
        title: "Example",
        type: "html",
        source: "<h1>Version two</h1>",
      },
      context,
      { createApiKey: createKey },
    );

    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-panes-create-key",
      ),
    ).toBe(createKey);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has(
        "x-panes-create-key",
      ),
    ).toBe(false);
    expect(JSON.stringify(created)).not.toContain(createKey);
  });

  it("redacts the creation key from API errors", async () => {
    const createKey = "protected-create-key";
    mockFetch(
      {
        error: {
          code: "FORBIDDEN",
          message: `Rejected ${createKey}`,
          issues: [{ path: ["header"], message: `Received ${createKey}` }],
        },
      },
      403,
    );

    const creation = executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      toolContext().context,
      { createApiKey: createKey },
    );
    await expect(creation).rejects.toThrow("Rejected [redacted]");
    await expect(creation).rejects.not.toThrow(createKey);
  });

  it("rejects malformed successful API responses", async () => {
    mockFetch({ artifact: { id: "artifact-1" } });

    await expect(
      executeArtifact(
        { title: "Example", type: "html", source: SOURCE },
        toolContext().context,
      ),
    ).rejects.toThrow("Panes API returned a malformed success response");
  });

  it.each([
    [
      "another origin",
      `${REMOTE_API}/artifacts/artifact-1#workspaceToken=${WORKSPACE_TOKEN}`,
    ],
    [
      "credentials",
      `http://user:pass@127.0.0.1:5173/artifacts/artifact-1#workspaceToken=${WORKSPACE_TOKEN}`,
    ],
    [
      "another path",
      `${LOCAL_API}/shared/artifact-1#workspaceToken=${WORKSPACE_TOKEN}`,
    ],
    [
      "another artifact",
      `${LOCAL_API}/artifacts/artifact-2#workspaceToken=${WORKSPACE_TOKEN}`,
    ],
    [
      "a query",
      `${LOCAL_API}/artifacts/artifact-1?next=evil#workspaceToken=${WORKSPACE_TOKEN}`,
    ],
    ["no fragment", `${LOCAL_API}/artifacts/artifact-1`],
    [
      "another fragment key",
      `${LOCAL_API}/artifacts/artifact-1#token=${WORKSPACE_TOKEN}`,
    ],
    ["an extra fragment key", `${viewerUrl(LOCAL_API)}&next=evil`],
    ["a duplicate token", `${viewerUrl(LOCAL_API)}&workspaceToken=other-token`],
  ])("rejects a create viewer URL with %s", async (_case, maliciousUrl) => {
    const response = createResponse();
    response.viewerUrl = maliciousUrl;
    mockFetch(response);

    await expect(
      executeArtifact(
        { title: "Example", type: "html", source: SOURCE },
        toolContext().context,
      ),
    ).rejects.toThrow("Panes API returned a malformed success response");
    await expect(stat(join(stateHome, "opencode-panes"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("reports authorization loss without leaking the rejected token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "UNAUTHORIZED",
              message: `Rejected ${OWNER_TOKEN}`,
            },
          },
          401,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext();
    await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
    );

    const update = executeArtifact(
      {
        artifactId: "artifact-1",
        title: "Example",
        type: "html",
        source: "changed",
      },
      context,
    );
    await expect(update).rejects.toThrow(
      "Panes authorization failed for artifact artifact-1",
    );
    await expect(update).rejects.not.toThrow(OWNER_TOKEN);
  });

  it("rejects source over the UTF-8 byte limit before fetching", async () => {
    const fetchMock = mockFetch(createResponse());
    const oversized = "é".repeat(MAX_ARTIFACT_SOURCE_BYTES / 2 + 1);

    await expect(
      executeArtifact(
        { title: "Too large", type: "html", source: oversized },
        toolContext().context,
      ),
    ).rejects.toThrow(`${MAX_ARTIFACT_SOURCE_BYTES}-byte UTF-8 limit`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails an update when no local owner token exists", async () => {
    const fetchMock = mockFetch(revisionResponse());

    await expect(
      executeArtifact(
        {
          artifactId: "unknown-artifact",
          title: "Unknown",
          type: "code",
          source: "content",
        },
        toolContext().context,
      ),
    ).rejects.toThrow("No local owner token was found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["title", { title: "Renamed", type: "html" }, 'stored title "Example"'],
    ["type", { title: "Example", type: "svg" }, 'stored type "html"'],
  ] as const)(
    "rejects an immutable %s change before permission or upload",
    async (_field, metadata, message) => {
      const fetchMock = mockFetch(createResponse());
      const { context, ask } = toolContext();
      await executeArtifact(
        { title: "Example", type: "html", source: SOURCE },
        context,
      );

      await expect(
        executeArtifact(
          {
            artifactId: "artifact-1",
            ...metadata,
            source: "changed",
          },
          context,
        ),
      ).rejects.toThrow(message);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(ask).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["another origin", `${REMOTE_API}/artifacts/artifact-1`],
    ["credentials", "http://user:pass@127.0.0.1:5173/artifacts/artifact-1"],
    ["another path", `${LOCAL_API}/shared/artifact-1`],
    ["another artifact", `${LOCAL_API}/artifacts/artifact-2`],
    ["a query", `${LOCAL_API}/artifacts/artifact-1?next=evil`],
    [
      "an unexpected fragment",
      `${LOCAL_API}/artifacts/artifact-1#workspaceToken=other-token`,
    ],
    ["an extra fragment", `${viewerUrl(LOCAL_API)}&next=evil`],
  ])("rejects an update viewer URL with %s", async (_case, maliciousUrl) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse()))
      .mockResolvedValueOnce(jsonResponse(revisionResponse(maliciousUrl)));
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext();
    await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
    );

    await expect(
      executeArtifact(
        {
          artifactId: "artifact-1",
          title: "Example",
          type: "html",
          source: "changed",
        },
        context,
      ),
    ).rejects.toThrow("Panes API returned a malformed success response");
  });

  it("accepts an update URL only when its credentialed URL matches stored state", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse()))
      .mockResolvedValueOnce(
        jsonResponse(revisionResponse(viewerUrl(LOCAL_API))),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext();
    await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
    );
    const result = await executeArtifact(
      {
        artifactId: "artifact-1",
        title: "Example",
        type: "html",
        source: "changed",
      },
      context,
    );

    expect(structuredResult(result).metadata?.viewerUrl).toBe(
      viewerUrl(LOCAL_API),
    );
  });

  it("rejects an update response for another artifact", async () => {
    const response = revisionResponse(
      `${LOCAL_API}/artifacts/artifact-2`,
      "artifact-2",
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createResponse()))
      .mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);
    const { context } = toolContext();
    await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
    );

    await expect(
      executeArtifact(
        {
          artifactId: "artifact-1",
          title: "Example",
          type: "html",
          source: "changed",
        },
        context,
      ),
    ).rejects.toThrow("Panes API returned a malformed success response");
  });

  it("asks for remote upload permission with an always pattern", async () => {
    const fetchMock = mockFetch(createResponse(REMOTE_API));
    const { context, ask } = toolContext();
    await executeArtifact(
      { title: "Remote", type: "html", source: SOURCE },
      context,
      { apiBaseUrl: REMOTE_API },
    );

    expect(ask).toHaveBeenCalledWith({
      permission: "artifact_upload",
      patterns: [REMOTE_API],
      always: [REMOTE_API],
      metadata: {
        endpoint: REMOTE_API,
        operation: "create",
        title: "Remote",
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    "http://localhost:5173",
    "http://preview.localhost:5173",
    "http://127.0.0.2:5173",
    "http://[::1]:5173",
  ])("permits HTTP for loopback origin %s", async (origin) => {
    mockFetch(createResponse(origin));
    const { context, ask } = toolContext();
    await executeArtifact(
      { title: "Example", type: "html", source: SOURCE },
      context,
      { apiBaseUrl: origin },
    );

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "artifact_upload",
        patterns: [origin],
        always: [origin],
      }),
    );
  });

  it.each([
    "http://panes.example",
    "http://192.168.1.20:5173",
    "http://0.0.0.0:5173",
    "http://[::]:5173",
  ])("rejects non-loopback HTTP origin %s", async (origin) => {
    await expect(
      OpenCodePanesPlugin({} as Parameters<typeof OpenCodePanesPlugin>[0], {
        apiBaseUrl: origin,
      }),
    ).rejects.toThrow("must use HTTPS");
  });

  it("uses a separate permission for auto-open and tolerates rejection", async () => {
    mockFetch(createResponse(REMOTE_API));
    const ask = vi
      .fn<ToolContext["ask"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("rejected"));
    const { context } = toolContext({}, ask);
    const result = await executeArtifact(
      { title: "Remote", type: "html", source: SOURCE },
      context,
      { apiBaseUrl: REMOTE_API, autoOpen: true },
    );

    expect(ask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ permission: "artifact_open" }),
    );
    expect(structuredResult(result).metadata).toMatchObject({
      autoOpen: "permission-denied",
    });
  });
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

async function executeArtifact(
  args: {
    artifactId?: string;
    title: string;
    type: ArtifactType;
    source: string;
  },
  context: ToolContext,
  options: PanesPluginOptions = {},
) {
  const plugin = await OpenCodePanesPlugin(
    {} as Parameters<typeof OpenCodePanesPlugin>[0],
    { ...options },
  );
  const definition = plugin.tool?.artifact as ToolDefinition | undefined;
  if (!definition) throw new Error("artifact tool was not registered");
  return definition.execute(args, context);
}

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

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

function createResponse(origin = LOCAL_API) {
  return {
    artifact: {
      id: "artifact-1",
      title: origin === REMOTE_API ? "Remote" : "Example",
      type: "html",
      currentRevisionId: "revision-1",
      createdAt: "2026-08-17T12:00:00.000Z",
      updatedAt: "2026-08-17T12:00:00.000Z",
    },
    revision: {
      id: "revision-1",
      artifactId: "artifact-1",
      version: 1,
      source: SOURCE,
      createdAt: "2026-08-17T12:00:00.000Z",
    },
    ownerToken: OWNER_TOKEN,
    viewerUrl: viewerUrl(origin),
  };
}

function revisionResponse(
  returnedViewerUrl = `${LOCAL_API}/artifacts/artifact-1`,
  artifactId = "artifact-1",
) {
  return {
    artifactId,
    revision: {
      id: "revision-2",
      artifactId,
      version: 2,
      source: "<h1>Version two</h1>",
      createdAt: "2026-08-17T12:05:00.000Z",
    },
    viewerUrl: returnedViewerUrl,
  };
}

function viewerUrl(origin: string) {
  return `${origin}/artifacts/artifact-1#workspaceToken=${WORKSPACE_TOKEN}`;
}

function structuredResult(result: ToolResult) {
  if (typeof result === "string") throw new Error("expected structured result");
  return result;
}

async function onlyStateFile() {
  let directory = join(stateHome, "opencode-panes");
  for (const segment of ["origins", undefined, "artifacts"] as const) {
    if (segment) directory = join(directory, segment);
    else {
      const entries = await readdir(directory);
      expect(entries).toHaveLength(1);
      directory = join(directory, entries[0] as string);
    }
  }
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  return join(directory, files[0] as string);
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
