import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_ARTIFACT_SOURCE_BYTES,
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

let stateHome: string;

beforeEach(async () => {
  stateHome = await mkdtemp(join(tmpdir(), "opencode-panes-test-"));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(stateHome, { recursive: true, force: true });
});

describe("artifact tool", () => {
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
    const { context } = toolContext(ask);
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

function toolContext(ask = vi.fn<ToolContext["ask"]>().mockResolvedValue()) {
  const context: ToolContext = {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask,
  };
  return { context, ask };
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
