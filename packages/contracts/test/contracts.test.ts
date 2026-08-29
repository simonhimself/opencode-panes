import { describe, expect, it } from "vitest";

import {
  ARTIFACT_TYPES,
  artifactManifestSchema,
  artifactFilesSchema,
  artifactIdSchema,
  cloudManifestSchema,
  creatorLinkSchema,
  deriveCloudManifest,
  draftSchema,
  MAX_ARTIFACT_REVISIONS,
  MAX_ARTIFACT_SOURCE_BYTES,
  MAX_ARTIFACT_TOTAL_SOURCE_BYTES,
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_REVISION_BYTES,
  ownerCredentialSchema,
  publicationSchema,
  PUBLICATION_DURATIONS,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  artifactResponseSchema,
  artifactSourceSchema,
  approvedOriginsSchema,
  createArtifactRequestSchema,
  createArtifactResponseSchema,
  createRevisionRequestSchema,
  errorEnvelopeSchema,
  revisionResponseSchema,
  relativePathSchema,
  revisionNumberSchema,
  requestedOriginsSchema,
  syncStateSchema,
  shareResponseSchema,
  syncCreateRequestSchema,
  syncCreateResponseSchema,
  syncRevisionCommitRequestSchema,
  syncRevisionCommitResponseSchema,
  inventoryCreatorRotateResponseSchema,
  inventoryPublicationMutationRequestSchema,
  inventoryCloudDeletionRequestSchema,
  inventoryPublicationUnpublishRequestSchema,
  inventoryReconnectCodeRequestSchema,
  inventoryReconnectCodeResponseSchema,
  reconnectCodeSchema,
  RECONNECT_CODE_PREFIX,
  RECONNECT_CODE_TTL_MS,
  syncReconnectRequestSchema,
  syncReconnectResponseSchema,
  workspaceTokenSchema,
} from "../src/index.js";

const artifact = {
  id: "artifact-1",
  title: "Example artifact",
  type: "html",
  currentRevisionId: "revision-1",
  createdAt: "2026-08-17T12:00:00.000Z",
  updatedAt: "2026-08-17T12:00:00.000Z",
} as const;

const revision = {
  id: "revision-1",
  artifactId: artifact.id,
  version: 1,
  source: "<h1>Hello</h1>",
  createdAt: "2026-08-17T12:00:00.000Z",
} as const;

describe("artifact request contracts", () => {
  it.each(ARTIFACT_TYPES)("accepts the %s artifact type", (type) => {
    const result = createArtifactRequestSchema.parse({
      title: "  Example  ",
      type,
      source: "content",
      sessionId: "session-1",
    });

    expect(result.title).toBe("Example");
    expect(result.type).toBe(type);
  });

  it("rejects unsupported types and unknown fields", () => {
    expect(
      createArtifactRequestSchema.safeParse({
        title: "Example",
        type: "canvas",
        source: "content",
        sessionId: "session-1",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("keeps revision creation limited to source", () => {
    expect(
      createRevisionRequestSchema.safeParse({ source: "content" }).success,
    ).toBe(true);
    expect(
      createRevisionRequestSchema.safeParse({
        source: "content",
        title: "Changed title",
      }).success,
    ).toBe(false);
  });
});

describe("local-first artifact manifests", () => {
  it("accepts a multi-file manifest with a finalized browser revision", () => {
    const result = artifactManifestSchema.safeParse({
      schemaVersion: 1,
      projectId: "project-1",
      artifactId: "artifact-1",
      slug: "landing-page",
      title: "Landing page",
      revisions: [
        {
          id: "revision-1",
          version: 1,
          preview: { adapter: "browser", entryPath: "src/index.html" },
          approvedOrigins: [],
          files: [
            {
              kind: "file",
              path: "src/index.html",
              sha256: "a".repeat(64),
              byteSize: 42,
              mediaType: "text/html",
            },
            {
              kind: "directory",
              path: "src/assets",
              byteSize: 0,
            },
          ],
          createdAt: "2026-08-17T12:00:00.000Z",
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("normalizes relative POSIX paths and rejects unsafe or colliding entries", () => {
    expect(relativePathSchema.parse("./src//index.html")).toBe(
      "src/index.html",
    );
    expect(relativePathSchema.safeParse("/src/index.html").success).toBe(false);
    expect(relativePathSchema.safeParse("C:/src/index.html").success).toBe(
      false,
    );
    expect(relativePathSchema.safeParse("src/../index.html").success).toBe(
      false,
    );
    expect(relativePathSchema.safeParse("src\\index.html").success).toBe(false);
    expect(relativePathSchema.safeParse("src/\u0000index.html").success).toBe(
      false,
    );
    expect(relativePathSchema.safeParse("CON/index.html").success).toBe(false);
    expect(relativePathSchema.safeParse("src/file.").success).toBe(false);

    expect(
      artifactFilesSchema.safeParse([
        {
          kind: "file",
          path: "src/index.html",
          sha256: "a".repeat(64),
          byteSize: 1,
          mediaType: "text/html",
        },
        {
          kind: "file",
          path: "SRC/./index.html",
          sha256: "b".repeat(64),
          byteSize: 1,
          mediaType: "text/html",
        },
      ]).success,
    ).toBe(false);

    expect(
      artifactFilesSchema.safeParse([
        {
          kind: "file",
          path: "assets",
          sha256: "a".repeat(64),
          byteSize: 1,
          mediaType: "application/octet-stream",
        },
        {
          kind: "directory",
          path: "assets/images",
          byteSize: 0,
        },
      ]).success,
    ).toBe(false);
  });

  it("validates raw-byte hashes and unbounded local file sizes", () => {
    expect(
      artifactFilesSchema.safeParse([
        {
          kind: "file",
          path: "large.bin",
          sha256: "a".repeat(64),
          byteSize: MAX_ARTIFACT_SOURCE_BYTES + 1,
          mediaType: "application/octet-stream",
        },
      ]).success,
    ).toBe(true);
    expect(
      artifactFilesSchema.safeParse([
        {
          kind: "file",
          path: "bad.bin",
          sha256: "A".repeat(64),
          byteSize: 0,
          mediaType: "application/octet-stream",
        },
      ]).success,
    ).toBe(false);
    expect(
      artifactFilesSchema.safeParse([
        {
          kind: "file",
          path: "negative.bin",
          sha256: "a".repeat(64),
          byteSize: -1,
          mediaType: "application/octet-stream",
        },
      ]).success,
    ).toBe(false);
  });

  it("validates identifiers and revision numbers without a local count cap", () => {
    expect(artifactIdSchema.safeParse("artifact-1").success).toBe(true);
    expect(artifactIdSchema.safeParse("artifact-\u0000-1").success).toBe(false);
    expect(revisionNumberSchema.safeParse(1).success).toBe(true);
    expect(revisionNumberSchema.safeParse(0).success).toBe(false);
    expect(revisionNumberSchema.safeParse(1.5).success).toBe(false);
    expect(
      revisionNumberSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success,
    ).toBe(false);
  });

  it("keeps requested Draft origins separate from approved Revision origins", () => {
    expect(requestedOriginsSchema.parse(["https://api.example.com/"])).toEqual([
      "https://api.example.com",
    ]);
    expect(approvedOriginsSchema.parse(["http://localhost:8787"])).toEqual([
      "http://localhost:8787",
    ]);
    expect(
      requestedOriginsSchema.safeParse(["wss://api.example.com"]).success,
    ).toBe(false);
    expect(
      approvedOriginsSchema.safeParse(["https://api.example.com/path"]).success,
    ).toBe(false);
    expect(
      approvedOriginsSchema.safeParse(["https://ｅxample.com"]).success,
    ).toBe(false);
    expect(
      approvedOriginsSchema.safeParse(["https://example.com."]).success,
    ).toBe(false);
    expect(
      approvedOriginsSchema.safeParse(["https://xn--eample-9ua.com"]).success,
    ).toBe(false);
  });

  it("does not apply legacy revision-count limits to local manifests", () => {
    const revisions = Array.from({ length: 17 }, (_, index) => ({
      id: `revision-${index + 1}`,
      version: index + 1,
      preview: { adapter: "browser", entryPath: "index.html" },
      approvedOrigins: [],
      files: [
        {
          kind: "file",
          path: "index.html",
          sha256: "a".repeat(64),
          byteSize: 1,
          mediaType: "text/html",
        },
      ],
      createdAt: "2026-08-17T12:00:00.000Z",
    }));

    expect(
      artifactManifestSchema.safeParse({
        schemaVersion: 1,
        projectId: "project-1",
        artifactId: "artifact-1",
        slug: "many-revisions",
        title: "Many revisions",
        revisions,
      }).success,
    ).toBe(true);
  });
});

describe("local-first lifecycle contracts", () => {
  it("bounds reconnect codes and keeps recovery responses secret-minimal", () => {
    const reconnectCode = `${RECONNECT_CODE_PREFIX}${"a".repeat(32)}`;
    expect(RECONNECT_CODE_TTL_MS).toBe(10 * 60 * 1000);
    expect(reconnectCodeSchema.safeParse(reconnectCode).success).toBe(true);
    expect(reconnectCodeSchema.safeParse(`${reconnectCode}x`).success).toBe(
      false,
    );
    expect(
      inventoryReconnectCodeRequestSchema.safeParse({
        confirmation: "Recover owner credential for artifact-1",
      }).success,
    ).toBe(true);
    expect(
      inventoryReconnectCodeResponseSchema.safeParse({
        cloudArtifactId: "cloud-artifact-1",
        reconnectCode,
        expiresAt: "2026-08-29T12:10:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      inventoryReconnectCodeResponseSchema.safeParse({
        cloudArtifactId: "cloud-artifact-1",
        reconnectCode,
        expiresAt: "2026-08-29T12:10:00.000Z",
        ownerCredential: "owner-secret",
      }).success,
    ).toBe(false);
  });

  it("binds redemption to API, local, and cloud identities", () => {
    const reconnectCode = `${RECONNECT_CODE_PREFIX}${"b".repeat(32)}`;
    const request = syncReconnectRequestSchema.parse({
      apiOrigin: "https://panes.example/",
      localProjectId: "local-project-1",
      localArtifactId: "local-artifact-1",
      cloudProjectId: "cloud-project-1",
      cloudArtifactId: "cloud-artifact-1",
      reconnectCode,
      newOwnerCredential: "owner-secret",
    });
    expect(request.apiOrigin).toBe("https://panes.example");
    expect(
      syncReconnectRequestSchema.safeParse({
        ...request,
        extra: "not-allowed",
      }).success,
    ).toBe(false);
    expect(
      syncReconnectResponseSchema.safeParse({
        operation: "reconnected",
        apiOrigin: "https://panes.example",
        localProjectId: "local-project-1",
        localArtifactId: "local-artifact-1",
        cloudProjectId: "cloud-project-1",
        cloudArtifactId: "cloud-artifact-1",
        creationIdempotencyKey: "sync-reconnect-1",
        inventoryUrl: "https://panes.example/inventory",
        creatorLink: {
          status: "active",
          expiresAt: "2026-09-28T12:00:00.000Z",
        },
        publication: {
          status: "none",
          revisionVersion: null,
          expiresAt: null,
        },
        syncedRevisionManifests: [],
      }).success,
    ).toBe(true);
  });

  it("keeps authenticated inventory mutations strict and secret-minimal", () => {
    expect(
      inventoryCreatorRotateResponseSchema.safeParse({
        cloudArtifactId: "cloud-artifact-1",
        creatorUrl: "https://panes.example/creator/new-token",
        creatorExpiresAt: "2026-09-16T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      inventoryCreatorRotateResponseSchema.safeParse({
        cloudArtifactId: "cloud-artifact-1",
        creatorUrl: "https://panes.example/creator/new-token",
        creatorExpiresAt: "2026-09-16T12:00:00.000Z",
        creatorToken: "new-token",
      }).success,
    ).toBe(false);
    expect(
      inventoryPublicationMutationRequestSchema.safeParse({
        durationDays: 7,
      }).success,
    ).toBe(true);
    expect(
      inventoryPublicationUnpublishRequestSchema.safeParse({}).success,
    ).toBe(true);
    expect(
      inventoryPublicationUnpublishRequestSchema.safeParse({ token: "secret" })
        .success,
    ).toBe(false);
    expect(
      inventoryCloudDeletionRequestSchema.safeParse({
        confirmation: "DELETE cloud copy of Example",
      }).success,
    ).toBe(true);
    expect(
      inventoryCloudDeletionRequestSchema.safeParse({
        confirmation: "DELETE cloud copy of Example",
        artifactId: "cloud-artifact-1",
      }).success,
    ).toBe(false);
  });

  it("validates Draft, Sync, Owner, Creator, and Publication state", () => {
    expect(
      draftSchema.safeParse({
        artifactId: "artifact-1",
        baseRevision: null,
        requestedOrigins: ["https://api.example.com"],
        createdAt: "2026-08-17T12:00:00.000Z",
        updatedAt: "2026-08-17T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      syncStateSchema.safeParse({
        status: "pending",
        syncedRevisionVersions: [],
        updatedAt: "2026-08-17T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ownerCredentialSchema.safeParse({
        artifactId: "artifact-1",
        credential: "owner-secret",
        createdAt: "2026-08-17T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      creatorLinkSchema.safeParse({
        artifactId: "artifact-1",
        url: "https://panes.example/creator/creator-token",
        status: "active",
        createdAt: "2026-08-17T12:00:00.000Z",
        expiresAt: "2026-09-16T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      publicationSchema.safeParse({
        id: "publication-1",
        artifactId: "artifact-1",
        revisionVersion: 1,
        durationDays: 7,
        publicUrl: "https://panes.example/public/public-token",
        status: "active",
        createdAt: "2026-08-17T12:00:00.000Z",
        expiresAt: "2026-08-24T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(PUBLICATION_DURATIONS).toEqual([1, 7, 30]);
  });

  it("derives a cloud manifest from only the selected upload files", () => {
    const manifest = {
      schemaVersion: 1,
      projectId: "project-1",
      artifactId: "artifact-1",
      slug: "landing-page",
      title: "Landing page",
      revisions: [
        {
          id: "revision-1",
          version: 1,
          preview: { adapter: "browser", entryPath: "index.html" },
          approvedOrigins: [],
          files: [
            {
              kind: "file",
              path: "index.html",
              sha256: "a".repeat(64),
              byteSize: 42,
              mediaType: "text/html",
            },
            {
              kind: "file",
              path: ".env",
              sha256: "b".repeat(64),
              byteSize: 12,
              mediaType: "text/plain",
            },
          ],
          createdAt: "2026-08-17T12:00:00.000Z",
        },
      ],
    } as const;

    const cloudManifest = deriveCloudManifest(manifest, [
      { version: 1, paths: ["index.html"] },
    ]);

    expect(cloudManifestSchema.safeParse(cloudManifest).success).toBe(true);
    expect(cloudManifest.revisions[0]?.files.map((file) => file.path)).toEqual([
      "index.html",
    ]);
    expect(() =>
      deriveCloudManifest(manifest, [
        { version: 1, paths: ["index.html", "missing.js"] },
      ]),
    ).toThrow("outside revision v1");
  });

  it("validates first-Sync admission and commit envelopes", () => {
    const create = syncCreateRequestSchema.parse({
      projectId: "project-1",
      artifactId: "artifact-1",
      slug: "landing-page",
      title: "Landing page",
      idempotencyKey: "sync-1",
      ownerCredential: "owner-secret",
      creatorToken: "creator-secret",
    });
    expect(create.projectId).toBe("project-1");

    expect(
      syncCreateResponseSchema.safeParse({
        cloudProjectId: "project-1",
        cloudArtifactId: "cloud-artifact-1",
        ownerCredential: "owner-secret",
        creatorUrl: "https://panes.example/creator/creator-secret",
        inventoryUrl: "https://panes.example/inventory",
        creatorExpiresAt: "2026-09-16T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      syncRevisionCommitRequestSchema.safeParse({
        manifest: {
          schemaVersion: 1,
          projectId: "project-1",
          artifactId: "cloud-artifact-1",
          slug: "landing-page",
          title: "Landing page",
          revisions: [],
        },
      }).success,
    ).toBe(true);
    expect(
      syncRevisionCommitResponseSchema.safeParse({
        cloudArtifactId: "cloud-artifact-1",
        version: 1,
        committedAt: "2026-09-16T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("exports independent remote file and Revision limits", () => {
    expect(MAX_REMOTE_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_REMOTE_REVISION_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_REMOTE_REVISION_BYTES).toBeGreaterThan(MAX_REMOTE_FILE_BYTES);
  });
});

describe("artifact source validation", () => {
  it("exports conservative per-artifact storage limits", () => {
    expect(MAX_ARTIFACT_REVISIONS).toBe(16);
    expect(MAX_ARTIFACT_TOTAL_SOURCE_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_ARTIFACT_TOTAL_SOURCE_BYTES).toBeGreaterThanOrEqual(
      MAX_ARTIFACT_SOURCE_BYTES,
    );
  });

  it("accepts source at the UTF-8 byte limit", () => {
    expect(
      artifactSourceSchema.safeParse("a".repeat(MAX_ARTIFACT_SOURCE_BYTES))
        .success,
    ).toBe(true);
  });

  it("rejects source over the UTF-8 byte limit", () => {
    expect(
      artifactSourceSchema.safeParse("a".repeat(MAX_ARTIFACT_SOURCE_BYTES + 1))
        .success,
    ).toBe(false);
  });

  it("measures multibyte source as UTF-8 bytes", () => {
    expect(
      artifactSourceSchema.safeParse("é".repeat(MAX_ARTIFACT_SOURCE_BYTES / 2))
        .success,
    ).toBe(true);
    expect(
      artifactSourceSchema.safeParse(
        "é".repeat(MAX_ARTIFACT_SOURCE_BYTES / 2 + 1),
      ).success,
    ).toBe(false);
  });
});

describe("artifact response contracts", () => {
  it("validates private artifact and revision responses", () => {
    expect(
      artifactResponseSchema.safeParse({
        artifact,
        revision,
        viewerUrl: "http://localhost:5173/artifacts/artifact-1",
      }).success,
    ).toBe(true);

    expect(
      createArtifactResponseSchema.safeParse({
        artifact,
        revision,
        ownerToken: "owner-token",
        viewerUrl:
          "https://panes.example/artifacts/artifact-1#workspaceToken=workspace-token",
      }).success,
    ).toBe(true);

    expect(
      revisionResponseSchema.safeParse({
        artifactId: artifact.id,
        revision,
        viewerUrl: "https://panes.example/artifacts/artifact-1",
      }).success,
    ).toBe(true);
  });

  it("uses a parseable workspace capability fragment without changing the response shape", () => {
    const result = createArtifactResponseSchema.parse({
      artifact,
      revision,
      ownerToken: "owner-token",
      viewerUrl:
        "https://panes.example/artifacts/artifact-1#workspaceToken=workspace-token",
    });
    const url = new URL(result.viewerUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));

    expect(url.search).toBe("");
    expect(fragment.get(WORKSPACE_TOKEN_FRAGMENT_KEY)).toBe("workspace-token");
    expect(
      workspaceTokenSchema.safeParse(fragment.get(WORKSPACE_TOKEN_FRAGMENT_KEY))
        .success,
    ).toBe(true);
    expect(Object.keys(result).sort()).toEqual([
      "artifact",
      "ownerToken",
      "revision",
      "viewerUrl",
    ]);
  });

  it("validates immutable share metadata without an owner token", () => {
    const result = shareResponseSchema.safeParse({
      artifactId: artifact.id,
      revisionId: revision.id,
      version: revision.version,
      publicUrl: "https://panes.example/public/share-token",
      createdAt: "2026-08-17T12:30:00.000Z",
    });

    expect(result.success).toBe(true);
  });
});

describe("error envelope", () => {
  it("keeps error codes and validation issues machine-readable", () => {
    expect(
      errorEnvelopeSchema.safeParse({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: [{ path: ["source"], message: "Source is required" }],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown error codes and envelope fields", () => {
    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: "BAD_REQUEST", message: "Bad request" },
        status: 400,
      }).success,
    ).toBe(false);
  });
});
