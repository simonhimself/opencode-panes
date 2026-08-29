import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenCodePanesPlugin } from "../src/index.js";

let project: string;
let stateHome: string;
let server: ReturnType<typeof createServer>;
let apiOrigin: string;
let requests: Array<{
  method: string;
  path: string;
  body: Buffer;
  headers: IncomingMessage["headers"];
}>;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "opencode-panes-sync-project-"));
  stateHome = await mkdtemp(join(tmpdir(), "opencode-panes-sync-state-"));
  requests = [];
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  server = createServer(
    (request, response) => void handleRequest(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not start");
  apiOrigin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
  await rm(stateHome, { recursive: true, force: true });
});

describe("artifact_sync tool", () => {
  it("uploads only the earliest finalized Revision, commits exact bytes, and reports pending history", async () => {
    const context = toolContext();
    const first = await prepareAndFinalize(context, "Sync me", {
      "index.html": Buffer.from("<h1>one</h1>\r\n"),
      "assets/payload.bin": Buffer.from([0, 255, 1, 254]),
      ".env": Buffer.from("SECRET=never-upload"),
      ".git/config": Buffer.from("git internals"),
      "node_modules/pkg/index.js": Buffer.from("dependency"),
      ".cache/build.txt": Buffer.from("cache"),
    });
    const artifactId = first.artifactId;
    await prepareAndFinalize(context, artifactId, {
      "index.html": Buffer.from("<h1>two</h1>"),
    });

    const result = await executeSync({ artifactId }, context);
    const metadata = resultMetadata(result);
    expect(metadata).toMatchObject({
      operation: "synced",
      artifactId,
      syncedVersion: 1,
      pendingVersions: [2],
      openCreatorAfterSuccess: "disabled",
    });
    expect(String(metadata.creatorUrl)).toContain("/creator/");
    expect(String(metadata.inventoryUrl)).toContain("/inventory");
    expect(
      requests.filter(({ path }) => path === "/api/sync/artifacts"),
    ).toHaveLength(1);
    const fileRequests = requests.filter(({ method }) => method === "PUT");
    expect(fileRequests.map(({ path }) => path).sort()).toEqual([
      expect.stringContaining("/files/assets%2Fpayload.bin"),
      expect.stringContaining("/files/index.html"),
    ]);
    expect(
      fileRequests
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ body }) => body),
    ).toEqual([Buffer.from([0, 255, 1, 254]), Buffer.from("<h1>one</h1>\r\n")]);
    const commit = requests.find(({ path }) => path.endsWith("/commit"));
    expect(commit).toBeDefined();
    const cloudManifest = JSON.parse(String(commit?.body)).manifest as {
      revisions: Array<{ files: Array<{ path: string }> }>;
    };
    expect(cloudManifest.revisions[0]?.files.map(({ path }) => path)).toEqual([
      "assets",
      "assets/payload.bin",
      "index.html",
    ]);

    const localManifest = JSON.parse(
      await readFile(
        join(project, "artifacts", "sync-me", "artifact.json"),
        "utf8",
      ),
    ) as { cloud?: { cloudArtifactId: string }; revisions: unknown[] };
    expect(localManifest.cloud?.cloudArtifactId).toBe("cloud-artifact-1");
    expect(localManifest.revisions).toHaveLength(2);
    const stateFiles = await readdir(join(stateHome, "opencode-panes"), {
      recursive: true,
    });
    expect(stateFiles.join("\n")).not.toContain("owner-credential");
    expect(JSON.stringify(result)).not.toContain("owner-credential");
  });

  it("fails closed for a custom ignore file before contacting the API", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Custom ignore", {
      "index.html": Buffer.from("<h1>one</h1>"),
      ".panesignore": Buffer.from("secret.txt"),
    });
    requests = [];
    await expect(
      executeSync({ artifactId: prepared.artifactId }, context),
    ).rejects.toThrow(/\.panesignore|ignore/i);
    expect(requests).toHaveLength(0);
  });

  it("recovers cloud identity from the protected checkpoint", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Recover me", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });

    await expect(
      executeSync({ artifactId: prepared.artifactId }, context, {
        failureInjector: (phase) => {
          if (phase === "sync-after-ownership")
            throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");

    const firstCreation = requests.find(
      ({ path }) => path === "/api/sync/artifacts",
    );
    expect(firstCreation).toBeDefined();
    requests = [];

    const result = await executeSync(
      { artifactId: prepared.artifactId },
      context,
    );
    expect(resultMetadata(result)).toMatchObject({
      operation: "synced",
      syncedVersion: 1,
    });
    expect(
      requests.filter(({ path }) => path === "/api/sync/artifacts"),
    ).toHaveLength(0);
  });
});

async function prepareAndFinalize(
  context: ToolContext,
  artifactOrTitle: string,
  files: Record<string, Buffer>,
) {
  const plugin = await OpenCodePanesPlugin({} as never, {});
  const prepare = plugin.tool?.artifact_prepare as ToolDefinition;
  const finalize = plugin.tool?.artifact_finalize as ToolDefinition;
  const args = artifactOrTitle.startsWith("artifact-")
    ? { artifactId: artifactOrTitle }
    : { title: artifactOrTitle };
  const prepared = await prepare.execute(args, context);
  const preparedMetadata = resultMetadata(prepared);
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(preparedMetadata.draftPath as string, path)), {
      recursive: true,
    });
    await writeFile(join(preparedMetadata.draftPath as string, path), bytes);
  }
  const finalized = await finalize.execute(
    {
      artifactId: preparedMetadata.artifactId,
      entryPath: "index.html",
      adapter: "browser",
    },
    context,
  );
  return {
    artifactId: preparedMetadata.artifactId as string,
    version: resultMetadata(finalized).version as number,
  };
}

async function executeSync(
  args: Record<string, unknown>,
  context: ToolContext,
  options: { failureInjector?: (phase: string) => void } = {},
) {
  const plugin = await OpenCodePanesPlugin({} as never, {
    apiBaseUrl: apiOrigin,
    createApiKey: "admission-key",
    ...options,
  });
  const definition = plugin.tool?.artifact_sync as ToolDefinition | undefined;
  if (!definition) throw new Error("artifact_sync was not registered");
  return definition.execute(args, context);
}

function toolContext(): ToolContext {
  return {
    sessionID: "session-sync",
    messageID: "message-sync",
    agent: "build",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
  };
}

function resultMetadata(result: ToolResult) {
  if (typeof result === "string" || !result.metadata)
    throw new Error("expected metadata");
  return result.metadata as Record<string, unknown>;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const path = request.url ?? "/";
  requests.push({
    method: request.method ?? "GET",
    path,
    body,
    headers: request.headers,
  });
  response.setHeader("content-type", "application/json");
  if (path === "/api/sync/artifacts") {
    const payload = JSON.parse(body.toString("utf8")) as {
      creatorToken: string;
    };
    response.statusCode = 201;
    response.end(
      JSON.stringify({
        cloudProjectId: "project-sync",
        cloudArtifactId: "cloud-artifact-1",
        ownerCredential: "owner-credential-sync",
        creatorUrl: `${apiOrigin}/creator/${encodeURIComponent(payload.creatorToken)}`,
        inventoryUrl: `${apiOrigin}/inventory`,
        creatorExpiresAt: "2026-09-28T12:00:00.000Z",
      }),
    );
    return;
  }
  if (path.endsWith("/commit")) {
    response.statusCode = 201;
    response.end(
      JSON.stringify({
        cloudArtifactId: "cloud-artifact-1",
        version: 1,
        committedAt: "2026-08-29T12:00:00.000Z",
      }),
    );
    return;
  }
  response.statusCode = 204;
  response.end();
}
