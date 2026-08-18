import { describe, expect, it } from "vitest";

import {
  ARTIFACT_TYPES,
  MAX_ARTIFACT_REVISIONS,
  MAX_ARTIFACT_SOURCE_BYTES,
  MAX_ARTIFACT_TOTAL_SOURCE_BYTES,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  artifactResponseSchema,
  artifactSourceSchema,
  createArtifactRequestSchema,
  createArtifactResponseSchema,
  createRevisionRequestSchema,
  errorEnvelopeSchema,
  revisionResponseSchema,
  shareResponseSchema,
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
