import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
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
import { MAX_REMOTE_FILE_BYTES } from "@opencode-panes/contracts";

let project: string;
let stateHome: string;
let server: ReturnType<typeof createServer>;
let apiOrigin: string;
let verifiedProbe: boolean;
let failSync: boolean;
let failReconnect: boolean;
let cloudCopyExists: boolean;
let cloudDeleteCount: number;
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
  verifiedProbe = false;
  failSync = false;
  failReconnect = false;
  cloudCopyExists = false;
  cloudDeleteCount = 0;
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
  await rm(stateHome, { recursive: true, force: true });
});

describe("sync and publish intent tools", () => {
  it("publishes by syncing first, then only asks to open the Creator link", async () => {
    let askCount = 0;
    const ask = vi.fn<ToolContext["ask"]>(async () => {
      askCount += 1;
      if (askCount === 2) throw new Error("browser permission denied");
    });
    const context = toolContext(ask);
    const prepared = await prepareAndFinalize(context, "Publish intent", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    ask.mockResolvedValueOnce(undefined);
    ask.mockRejectedValueOnce(new Error("browser permission denied"));

    const plugin = await OpenCodePanesPlugin({} as never, {
      apiBaseUrl: apiOrigin,
      createApiKey: "admission-key",
    });
    const definition = plugin.tool?.artifact_publish as ToolDefinition;
    const result = await definition.execute(
      { artifactId: prepared.artifactId },
      context,
    );

    expect(resultMetadata(result)).toMatchObject({
      operation: "synced",
      artifactId: prepared.artifactId,
      openCreatorAfterSuccess: "permission-denied",
    });
    expect(requests.some(({ path }) => path.includes("/publish"))).toBe(false);
    expect(
      requests.some(
        ({ path, body }) =>
          path.includes("/publish") || body.toString().includes("durationDays"),
      ),
    ).toBe(false);
    expect(
      requests.some(({ body }) => body.toString().includes("revisionVersion")),
    ).toBe(false);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "artifact_open" }),
    );
  });

  it("sends the admission key only on first Sync creation", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "First Sync", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });

    await executeSync({ artifactId: prepared.artifactId }, context);
    const createRequests = requests.filter(
      ({ path }) => path === "/api/sync/artifacts",
    );
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]?.headers["x-panes-create-key"]).toEqual(
      "admission-key",
    );

    for (const request of requests.filter(
      ({ path }) => path !== "/api/sync/artifacts",
    )) {
      expect(request.headers["x-panes-create-key"]).toBeUndefined();
      expect(request.body.toString("utf8")).not.toContain("admission-key");
    }
    const state = await readFile(await onlyStateFile(), "utf8");
    expect(state).not.toContain("admission-key");
    expect(
      JSON.stringify(
        resultMetadata(
          await executeSync({ artifactId: prepared.artifactId }, context),
        ),
      ),
    ).not.toContain("admission-key");
  });

  it("passes the configured timeout to a local-first Sync request", async () => {
    const context = toolContext();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal("fetch", fetchMock);
    const plugin = await OpenCodePanesPlugin({} as never, {
      apiBaseUrl: apiOrigin,
      requestTimeoutMs: 100,
    });
    const definition = plugin.tool?.artifact_adopt_legacy as ToolDefinition;
    await expect(
      definition.execute(
        {
          artifactId: "legacy-timeout",
          adoptionCode: "panes-adopt-legacy-" + "a".repeat(32),
          slug: "timeout",
        },
        context,
      ),
    ).rejects.toThrow("Could not reach the Panes API at http://127.0.0.1");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
  });

  it("reconnects from the canonical local manifest after protected state loss", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(
      context,
      "Reconnect me",
      {
        "index.html": Buffer.from("<h1>one</h1>"),
        "local-secret.txt": Buffer.from("must remain local"),
      },
      ["empty-dir"],
    );
    await writeFile(
      join(project, "artifacts", "reconnect-me", ".panesignore"),
      "local-secret.txt\n",
    );
    await executeSync({ artifactId: prepared.artifactId }, context);
    const firstCommit = requests.find(({ path }) => path.endsWith("/commit"));
    expect(String(firstCommit?.body)).not.toContain("local-secret.txt");
    await prepareAndFinalize(context, prepared.artifactId, {
      "index.html": Buffer.from("<h1>two</h1>"),
      "local-secret.txt": Buffer.from("still local"),
    });
    const statePath = await onlyStateFile();
    await rm(statePath);

    const plugin = await OpenCodePanesPlugin({} as never, {
      apiBaseUrl: apiOrigin,
      createApiKey: "admission-key",
    });
    const definition = plugin.tool?.artifact_reconnect as ToolDefinition;
    const result = await definition.execute(
      {
        artifactId: prepared.artifactId,
        reconnectCode: "panes-reconnect-0123456789abcdef0123456789abcdef",
      },
      context,
    );
    const metadata = resultMetadata(result);
    expect(metadata).toMatchObject({
      operation: "reconnected",
      artifactId: prepared.artifactId,
      creatorLinkStatus: "unavailable",
      creatorLifecycleStatus: "active",
      syncedRevisionVersions: [1],
      publication: {
        status: "none",
        revisionVersion: null,
        expiresAt: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("panes-reconnect-");
    expect(JSON.stringify(result)).not.toContain("owner-credential");
    expect(String(metadata.guidance)).toContain(
      "explicit Creator-link rotation",
    );
    expect(
      requests.filter(({ path }) => path.endsWith("/reconnect")),
    ).toHaveLength(1);
    const state = JSON.parse(await readFile(await onlyStateFile(), "utf8")) as {
      ownerCredential?: string;
      creatorUrl?: string;
      creatorLinkStatus?: string;
      syncedRevisionManifests?: Array<{
        version: number;
        files: Array<{ path: string }>;
      }>;
    };
    expect(state.ownerCredential).toMatch(/^sync-owner-/u);
    expect(state.creatorUrl).toBeUndefined();
    expect(state.creatorLinkStatus).toBe("unavailable");
    expect(state.syncedRevisionManifests?.[0]?.version).toBe(1);
    expect(
      state.syncedRevisionManifests?.[0]?.files.map(({ path }) => path),
    ).toEqual(["empty-dir", "index.html"]);

    requests = [];
    const nextSync = await executeSync(
      { artifactId: prepared.artifactId },
      context,
    );
    expect(resultMetadata(nextSync)).toMatchObject({ syncedVersion: 2 });
    const secondCommit = requests.find(({ path }) => path.endsWith("/commit"));
    expect(secondCommit).toBeDefined();
    expect(String(secondCommit?.body)).not.toContain("local-secret.txt");
    expect(
      requests.some(
        ({ method, path, body }) =>
          method === "PUT" &&
          (path.includes("local-secret.txt") ||
            body.toString().includes("still local")),
      ),
    ).toBe(false);
    const secondManifest = JSON.parse(String(secondCommit?.body)).manifest as {
      revisions: Array<{ version: number; files: Array<{ path: string }> }>;
    };
    expect(secondManifest.revisions.map(({ version }) => version)).toEqual([
      1, 2,
    ]);
    expect(secondManifest.revisions[0]?.files.map(({ path }) => path)).toEqual([
      "empty-dir",
      "index.html",
    ]);

    requests = [];
    const publish = await OpenCodePanesPlugin({} as never, {
      apiBaseUrl: apiOrigin,
      createApiKey: "admission-key",
    });
    const publishDefinition = publish.tool?.artifact_publish as ToolDefinition;
    expect(
      resultMetadata(
        await publishDefinition.execute(
          { artifactId: prepared.artifactId },
          context,
        ),
      ),
    ).toMatchObject({
      creatorLinkStatus: "unavailable",
      openCreatorAfterSuccess: "failed",
    });
    expect(requests.some(({ path }) => path.endsWith("/creator/rotate"))).toBe(
      false,
    );

    requests = [];
    const rotated = await executeSync(
      { artifactId: prepared.artifactId, rotateCreatorLink: true },
      context,
    );
    expect(resultMetadata(rotated)).toMatchObject({
      creatorLinkStatus: "available",
      creatorUrl: `${apiOrigin}/creator/creator-rotated`,
    });
    expect(
      requests.filter(({ path }) => path.endsWith("/creator/rotate")),
    ).toHaveLength(1);
    const rotatedState = JSON.parse(
      await readFile(await onlyStateFile(), "utf8"),
    ) as { creatorUrl?: string; creatorLinkStatus?: string };
    expect(rotatedState).toMatchObject({
      creatorUrl: `${apiOrigin}/creator/creator-rotated`,
      creatorLinkStatus: "available",
    });
  });

  it("redacts reconnect code and generated Owner credential from API errors", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Reconnect error", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await executeSync({ artifactId: prepared.artifactId }, context);
    await rm(await onlyStateFile());
    failReconnect = true;
    const reconnectCode = "panes-reconnect-0123456789abcdef0123456789abcdef";
    await expect(
      (
        await OpenCodePanesPlugin({} as never, {
          apiBaseUrl: apiOrigin,
          createApiKey: "admission-key",
        })
      ).tool?.artifact_reconnect?.execute(
        { artifactId: prepared.artifactId, reconnectCode },
        context,
      ),
    ).rejects.toThrow("[redacted]");
    const reconnectRequest = requests.find(({ path }) =>
      path.endsWith("/reconnect"),
    );
    const reconnectPayload = JSON.parse(
      reconnectRequest?.body.toString("utf8") ?? "{}",
    ) as { newOwnerCredential?: string };
    const error = await (async () => {
      try {
        await (
          await OpenCodePanesPlugin({} as never, {
            apiBaseUrl: apiOrigin,
            createApiKey: "admission-key",
          })
        ).tool?.artifact_reconnect?.execute(
          { artifactId: prepared.artifactId, reconnectCode },
          context,
        );
      } catch (value) {
        return String(value);
      }
      return "";
    })();
    expect(error).not.toContain(reconnectCode);
    expect(error).not.toContain(reconnectPayload.newOwnerCredential ?? "");
  });

  it("stops the publish intent on full Sync failure before opening or publishing", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Failed publish", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    failSync = true;
    const plugin = await OpenCodePanesPlugin({} as never, {
      apiBaseUrl: apiOrigin,
      createApiKey: "admission-key",
    });
    const definition = plugin.tool?.artifact_publish as ToolDefinition;
    await expect(
      definition.execute({ artifactId: prepared.artifactId }, context),
    ).rejects.toThrow("HTTP 503");
    expect(requests.some(({ path }) => path.includes("/publish"))).toBe(false);
    expect(context.ask).not.toHaveBeenCalledWith(
      expect.objectContaining({ permission: "artifact_open" }),
    );
  });

  it.each([
    "sync-after-checkpoint",
    "sync-after-create",
    "sync-after-ownership",
    "sync-after-mapping",
  ])("recovers the same identity after %s", async (phase) => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Checkpoint matrix", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await expect(
      executeSync({ artifactId: prepared.artifactId }, context, {
        failureInjector: (failurePhase) => {
          if (failurePhase === phase) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    requests = [];
    await executeSync({ artifactId: prepared.artifactId }, context);
    const creations = requests.filter(
      ({ path }) => path === "/api/sync/artifacts",
    );
    expect(creations).toHaveLength(
      phase === "sync-after-checkpoint" || phase === "sync-after-create"
        ? 1
        : 0,
    );
  });

  it("does not send bytes when the Worker verifies a matching temporary upload", async () => {
    verifiedProbe = true;
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Verified resume", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await executeSync({ artifactId: prepared.artifactId }, context);
    expect(requests.filter(({ method }) => method === "HEAD")).not.toHaveLength(
      0,
    );
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(0);
  });

  it("passes explicit Creator-link rotation through the registered Sync tool", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Rotate Creator", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    const result = await executeSync(
      { artifactId: prepared.artifactId, rotateCreatorLink: true },
      context,
    );
    expect(String(resultMetadata(result).creatorUrl)).toContain(
      "/creator/creator-rotated",
    );
    expect(
      requests.filter(({ path }) => path.endsWith("/creator/rotate")),
    ).toHaveLength(1);
  });

  it("does not delete the cloud copy when a canonical local Artifact is removed", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Delete local", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await executeSync({ artifactId: prepared.artifactId }, context);
    const cloudRequests = requests.length;

    await rm(join(project, "artifacts", "delete-local"), {
      recursive: true,
      force: true,
    });
    const plugin = await OpenCodePanesPlugin({} as never, {});
    const prepare = plugin.tool?.artifact_prepare as ToolDefinition;
    await prepare.execute({ title: "New local Artifact" }, context);

    expect(requests).toHaveLength(cloudRequests);
    expect(cloudDeleteCount).toBe(0);
    expect(cloudCopyExists).toBe(true);
    expect(requests.some(({ path }) => path.endsWith("/commit"))).toBe(true);
  });

  it("uploads every finalized Revision, commits exact bytes, and reports complete history", async () => {
    const context = toolContext();
    const first = await prepareAndFinalize(context, "Sync me", {
      "index.html": Buffer.from("<h1>one</h1>\r\n"),
      "assets/payload.bin": Buffer.from([0, 255, 1, 254]),
      "bom.txt": Buffer.from([0xef, 0xbb, 0xbf, 0x66, 0x6f, 0x6f, 0x0d, 0x0a]),
      "empty.bin": Buffer.alloc(0),
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
      syncedVersion: 2,
      pendingVersions: [],
      openCreatorAfterSuccess: "disabled",
    });
    expect(String(metadata.creatorUrl)).toContain("/creator/");
    expect(String(metadata.inventoryUrl)).toContain("/inventory");
    expect(
      requests.filter(({ path }) => path === "/api/sync/artifacts"),
    ).toHaveLength(1);
    const fileRequests = requests.filter(({ method }) => method === "PUT");
    expect(fileRequests.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/files/assets%2Fpayload.bin"),
        expect.stringContaining("/files/index.html"),
        expect.stringContaining("/revisions/2/files/index.html"),
        expect.stringContaining("/revisions/2/files/assets%2Fpayload.bin"),
      ]),
    );
    expect(fileRequests).toHaveLength(8);
    expect(
      fileRequests.find(({ path }) =>
        path.includes("/revisions/1/files/index.html"),
      )?.body,
    ).toEqual(Buffer.from("<h1>one</h1>\r\n"));
    expect(
      fileRequests.find(({ path }) =>
        path.includes("/revisions/1/files/assets%2Fpayload.bin"),
      )?.body,
    ).toEqual(Buffer.from([0, 255, 1, 254]));
    expect(
      fileRequests.find(({ path }) =>
        path.includes("/revisions/1/files/bom.txt"),
      )?.body,
    ).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x66, 0x6f, 0x6f, 0x0d, 0x0a]));
    expect(
      fileRequests.find(({ path }) =>
        path.includes("/revisions/1/files/empty.bin"),
      )?.body,
    ).toEqual(Buffer.alloc(0));
    expect(
      fileRequests.find(({ path }) =>
        path.includes("/revisions/2/files/index.html"),
      )?.body,
    ).toEqual(Buffer.from("<h1>two</h1>"));
    const commits = requests.filter(({ path }) => path.endsWith("/commit"));
    expect(commits).toHaveLength(2);
    const firstManifest = JSON.parse(String(commits[0]?.body)).manifest as {
      revisions: Array<{ files: Array<{ path: string }> }>;
    };
    expect(firstManifest.revisions).toHaveLength(1);
    expect(firstManifest.revisions[0]?.files.map(({ path }) => path)).toEqual([
      "assets",
      "assets/payload.bin",
      "bom.txt",
      "empty.bin",
      "index.html",
    ]);
    const finalManifest = JSON.parse(String(commits[1]?.body)).manifest as {
      revisions: Array<{ version: number }>;
    };
    expect(finalManifest.revisions.map(({ version }) => version)).toEqual([
      1, 2,
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

  it("applies artifact-root Gitignore rules while keeping mandatory exclusions excluded", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Custom ignore", {
      "index.html": Buffer.from("<h1>one</h1>"),
      "secret.txt": Buffer.from("secret"),
      "keep.secret": Buffer.from("keep"),
      ".env": Buffer.from("SECRET=never-upload"),
      "node_modules/pkg.js": Buffer.from("dependency"),
    });
    await writeFile(
      join(project, "artifacts", "custom-ignore", ".panesignore"),
      "*.secret\n!keep.secret\nsecret.txt\n!.env\n",
    );

    await executeSync({ artifactId: prepared.artifactId }, context);
    const commit = requests.find(({ path }) => path.endsWith("/commit"));
    const cloudManifest = JSON.parse(String(commit?.body)).manifest as {
      revisions: Array<{ files: Array<{ path: string }> }>;
    };
    expect(cloudManifest.revisions[0]?.files.map(({ path }) => path)).toEqual([
      "index.html",
      "keep.secret",
    ]);
    expect(String(commit?.body)).not.toContain("secret.txt");
    expect(String(commit?.body)).not.toContain(".env");
    expect(String(commit?.body)).not.toContain("node_modules");
  });

  it("does not count an ignored oversized file or disclose its metadata", async () => {
    const context = toolContext();
    const ignoredBytes = Buffer.alloc(MAX_REMOTE_FILE_BYTES + 1, 7);
    const prepared = await prepareAndFinalize(context, "Ignored limit", {
      "index.html": Buffer.from("<h1>visible</h1>"),
      "ignored.bin": ignoredBytes,
    });
    const ignoredHash = createHash("sha256").update(ignoredBytes).digest("hex");
    await writeFile(
      join(project, "artifacts", "ignored-limit", ".panesignore"),
      "ignored.bin\n",
    );

    await executeSync({ artifactId: prepared.artifactId }, context);
    const commit = requests.find(({ path }) => path.endsWith("/commit"));
    expect(String(commit?.body)).not.toContain("ignored.bin");
    expect(String(commit?.body)).not.toContain(ignoredHash);
    expect(String(commit?.body)).not.toContain(String(ignoredBytes.byteLength));
    expect(
      requests.filter(
        ({ method, path }) => method === "PUT" && path.includes("ignored.bin"),
      ),
    ).toHaveLength(0);
  });

  it("preserves an earlier filtered cloud Revision when ignore rules change", async () => {
    const context = toolContext();
    const first = await prepareAndFinalize(context, "Changing ignore", {
      "index.html": Buffer.from("<h1>one</h1>"),
      "retained.txt": Buffer.from("keep in v1"),
      "v1-ignored.txt": Buffer.from("omit in v1"),
    });
    const panesIgnorePath = join(
      project,
      "artifacts",
      "changing-ignore",
      ".panesignore",
    );
    await writeFile(panesIgnorePath, "v1-ignored.txt\nv2-ignored.txt\n");
    await executeSync({ artifactId: first.artifactId }, context);
    const firstCommit = JSON.parse(
      String(requests.find(({ path }) => path.endsWith("/commit"))?.body),
    ).manifest as { revisions: Array<{ files: Array<{ path: string }> }> };

    await prepareAndFinalize(context, first.artifactId, {
      "index.html": Buffer.from("<h1>two</h1>"),
      "v2-ignored.txt": Buffer.from("omit in v2"),
    });
    await writeFile(
      panesIgnorePath,
      "retained.txt\nv1-ignored.txt\nv2-ignored.txt\n",
    );
    requests = [];
    await executeSync({ artifactId: first.artifactId }, context);
    const secondCommit = JSON.parse(
      String(requests.find(({ path }) => path.endsWith("/commit"))?.body),
    ).manifest as { revisions: Array<{ files: Array<{ path: string }> }> };
    expect(secondCommit.revisions[0]).toEqual(firstCommit.revisions[0]);
    expect(secondCommit.revisions[1]?.files.map(({ path }) => path)).toEqual([
      "index.html",
    ]);
    expect(
      requests.filter(
        ({ method, path }) =>
          method === "PUT" && path.includes("/revisions/1/"),
      ),
    ).toHaveLength(0);
  });

  it("fails clearly when committed state lacks filtered Revision metadata", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Missing metadata", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await executeSync({ artifactId: prepared.artifactId }, context);

    expect(
      await updateStoredSyncState((state) => {
        delete state.syncedRevisionManifests;
      }),
    ).toBe(true);

    await expect(
      executeSync({ artifactId: prepared.artifactId }, context),
    ).rejects.toThrow(/lacks filtered metadata/i);
  });

  it("fails clearly when committed state metadata does not correlate", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Corrupt metadata", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await executeSync({ artifactId: prepared.artifactId }, context);

    expect(
      await updateStoredSyncState((state) => {
        state.syncedRevisionManifests = [];
      }),
    ).toBe(true);

    await expect(
      executeSync({ artifactId: prepared.artifactId }, context),
    ).rejects.toThrow(/does not correlate/i);
  });

  it("keeps an earlier committed Revision visible when a later Sync attempt fails", async () => {
    const context = toolContext();
    const first = await prepareAndFinalize(context, "Partial history", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });
    await prepareAndFinalize(context, first.artifactId, {
      "index.html": Buffer.from("<h1>two</h1>"),
    });

    await expect(
      executeSync({ artifactId: first.artifactId }, context, {
        failureInjector: (phase) => {
          if (phase === "sync-after-commit") throw new Error("later failure");
        },
      }),
    ).rejects.toThrow("later failure");
    expect(
      requests.filter(({ path }) => path.endsWith("/commit")),
    ).toHaveLength(1);

    requests = [];
    const retry = await executeSync({ artifactId: first.artifactId }, context);
    expect(resultMetadata(retry)).toMatchObject({
      syncedVersion: 2,
      pendingVersions: [],
    });
    expect(
      requests
        .filter(({ method }) => method === "PUT")
        .every(({ path }) => path.includes("/revisions/2/")),
    ).toBe(true);
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

  it("uses a fresh session after a successful release", async () => {
    const context = toolContext();
    const prepared = await prepareAndFinalize(context, "Rotate sessions", {
      "index.html": Buffer.from("<h1>one</h1>"),
    });

    await executeSync({ artifactId: prepared.artifactId }, context);
    const firstSession = requests.find(
      ({ headers }) => typeof headers["x-panes-sync-session"] === "string",
    )?.headers["x-panes-sync-session"];
    expect(firstSession).toEqual(expect.any(String));

    await prepareAndFinalize(context, prepared.artifactId, {
      "index.html": Buffer.from("<h1>two</h1>"),
    });
    requests = [];
    await executeSync({ artifactId: prepared.artifactId }, context);
    const secondSession = requests.find(
      ({ headers }) => typeof headers["x-panes-sync-session"] === "string",
    )?.headers["x-panes-sync-session"];

    expect(secondSession).toEqual(expect.any(String));
    expect(secondSession).not.toBe(firstSession);
  });
});

async function prepareAndFinalize(
  context: ToolContext,
  artifactOrTitle: string,
  files: Record<string, Buffer>,
  directories: string[] = [],
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
  for (const path of directories) {
    await mkdir(join(preparedMetadata.draftPath as string, path), {
      recursive: true,
    });
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
  options: {
    failureInjector?: (phase: string) => void;
    requestTimeoutMs?: number;
  } = {},
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

function toolContext(ask = vi.fn().mockResolvedValue(undefined)): ToolContext {
  return {
    sessionID: "session-sync",
    messageID: "message-sync",
    agent: "build",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask,
  };
}

function resultMetadata(result: ToolResult) {
  if (typeof result === "string" || !result.metadata)
    throw new Error("expected metadata");
  return result.metadata as Record<string, unknown>;
}

async function onlyStateFile(): Promise<string> {
  const stateRoot = join(stateHome, "opencode-panes");
  const stateFiles = (await readdir(stateRoot, { recursive: true }))
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(stateRoot, file));
  if (stateFiles.length !== 1) {
    throw new Error(`expected one state file, found ${stateFiles.length}`);
  }
  return stateFiles[0] as string;
}

async function updateStoredSyncState(
  update: (state: Record<string, unknown>) => void,
) {
  const stateRoot = join(stateHome, "opencode-panes");
  const stateFiles = await readdir(stateRoot, { recursive: true });
  for (const file of stateFiles) {
    if (!file.endsWith(".json")) continue;
    const statePath = join(stateRoot, file);
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    if (!Array.isArray(state.syncedRevisionVersions)) continue;
    update(state);
    await writeFile(statePath, JSON.stringify(state));
    return true;
  }
  return false;
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
  if (path.endsWith("/reconnect")) {
    const payload = JSON.parse(body.toString("utf8")) as {
      localProjectId: string;
      localArtifactId: string;
      cloudProjectId: string;
      cloudArtifactId: string;
      newOwnerCredential: string;
      reconnectCode: string;
    };
    const createRequest = requests.find(
      ({ path: requestPath }) => requestPath === "/api/sync/artifacts",
    );
    const commitRequest = [...requests]
      .reverse()
      .find(({ path: requestPath }) => requestPath.endsWith("/commit"));
    const createPayload = createRequest
      ? (JSON.parse(createRequest.body.toString("utf8")) as {
          idempotencyKey: string;
        })
      : undefined;
    const commitPayload = commitRequest
      ? (JSON.parse(commitRequest.body.toString("utf8")) as {
          manifest: { revisions: unknown[] };
        })
      : undefined;
    if (failReconnect) {
      response.statusCode = 409;
      response.end(
        JSON.stringify({
          error: {
            code: "CONFLICT",
            message: `${payload.reconnectCode} ${payload.newOwnerCredential}`,
          },
        }),
      );
      return;
    }
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        operation: "reconnected",
        apiOrigin,
        localProjectId: payload.localProjectId,
        localArtifactId: payload.localArtifactId,
        cloudProjectId: payload.cloudProjectId,
        cloudArtifactId: payload.cloudArtifactId,
        creationIdempotencyKey:
          createPayload?.idempotencyKey ?? "idempotency-sync-me",
        inventoryUrl: `${apiOrigin}/inventory`,
        creatorLink: {
          status: "active",
          expiresAt: "2026-09-28T12:00:00.000Z",
        },
        publication: {
          status: "none",
          revisionVersion: null,
          expiresAt: null,
        },
        syncedRevisionManifests: commitPayload?.manifest.revisions ?? [],
      }),
    );
    expect(payload.reconnectCode).toMatch(/^panes-reconnect-/u);
    expect(payload.newOwnerCredential).not.toBe(payload.reconnectCode);
    return;
  }
  if (path === "/api/sync/artifacts") {
    if (failSync) {
      response.statusCode = 503;
      response.end(
        JSON.stringify({ error: { message: "simulated Sync failure" } }),
      );
      return;
    }
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
  if (request.method === "HEAD") {
    if (verifiedProbe) response.setHeader("x-panes-upload-verified", "true");
    response.statusCode = 204;
    response.end();
    return;
  }
  if (path.endsWith("/creator/rotate")) {
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        cloudArtifactId: "cloud-artifact-1",
        creatorToken: "creator-rotated",
        creatorUrl: `${apiOrigin}/creator/creator-rotated`,
        creatorExpiresAt: "2026-10-28T12:00:00.000Z",
      }),
    );
    return;
  }
  if (path.endsWith("/commit")) {
    cloudCopyExists = true;
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
  if (request.method === "DELETE") {
    cloudDeleteCount += 1;
    cloudCopyExists = false;
  }
  response.statusCode = 204;
  response.end();
}
