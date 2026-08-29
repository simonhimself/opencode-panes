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
