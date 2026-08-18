import {
  MAX_ARTIFACT_REVISIONS,
  MAX_ARTIFACT_SOURCE_BYTES,
  MAX_ARTIFACT_TOTAL_SOURCE_BYTES,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  createArtifactResponseSchema,
  errorEnvelopeSchema,
  revisionResponseSchema,
  shareResponseSchema,
} from "@opencode-panes/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker, { logUnexpectedError } from "../worker";

const ORIGIN = "https://panes.example";

interface RevisionList {
  artifactId: string;
  revisions: Array<{ id: string; version: number; source: string }>;
}

interface PublicShare {
  artifact: { id: string; title: string; type: string };
  revision: {
    id: string;
    artifactId: string;
    version: number;
    source: string;
    createdAt: string;
  };
  publishedAt: string;
}

async function api(
  path: string,
  init?: RequestInit,
  workerEnv: Env = env,
): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv);
}

function jsonRequest(
  value: unknown,
  token?: string,
  extraHeaders?: HeadersInit,
): RequestInit {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, name) =>
      headers.set(name, value),
    );
  }
  return { method: "POST", headers, body: JSON.stringify(value) };
}

async function createArtifact(source = "<h1>version one</h1>") {
  const response = await api(
    "/api/artifacts",
    jsonRequest({
      title: "Test Artifact",
      type: "html",
      source,
      sessionId: "private-session-id",
    }),
  );
  expect(response.status).toBe(201);
  return createArtifactResponseSchema.parse(await response.json());
}

async function createRevision(
  artifactId: string,
  ownerToken: string,
  source: string,
) {
  const response = await api(
    `/api/artifacts/${artifactId}/revisions`,
    jsonRequest({ source }, ownerToken),
  );
  expect(response.status).toBe(201);
  return revisionResponseSchema.parse(await response.json());
}

function shareToken(publicUrl: string): string {
  const token = new URL(publicUrl).pathname.split("/").at(-1);
  if (!token) throw new Error("Public URL did not contain a share token");
  return token;
}

function workspaceToken(viewerUrl: string): string {
  const url = new URL(viewerUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get(WORKSPACE_TOKEN_FRAGMENT_KEY);
  if (!token) throw new Error("Viewer URL did not contain a workspace token");
  return token;
}

describe("artifact API", () => {
  it("strictly validates requests and enforces the UTF-8 source limit", async () => {
    const extraFieldResponse = await api(
      "/api/artifacts",
      jsonRequest({
        title: "Artifact",
        type: "html",
        source: "<p>valid</p>",
        sessionId: "session",
        unexpected: true,
      }),
    );

    expect(extraFieldResponse.status).toBe(400);
    expect(extraFieldResponse.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(
      errorEnvelopeSchema.parse(await extraFieldResponse.json()).error.code,
    ).toBe("VALIDATION_ERROR");

    const oversizedSource = "🙂".repeat(
      Math.floor(MAX_ARTIFACT_SOURCE_BYTES / 4) + 1,
    );
    const oversizedResponse = await api(
      "/api/artifacts",
      jsonRequest({
        title: "Artifact",
        type: "html",
        source: oversizedSource,
        sessionId: "session",
      }),
    );

    expect(oversizedResponse.status).toBe(413);
    expect(
      errorEnvelopeSchema.parse(await oversizedResponse.json()).error.code,
    ).toBe("SOURCE_TOO_LARGE");

    const boundaryResponse = await api(
      "/api/artifacts",
      jsonRequest({
        title: "Boundary Artifact",
        type: "code",
        source: "a".repeat(MAX_ARTIFACT_SOURCE_BYTES),
        sessionId: "session",
      }),
    );
    expect(boundaryResponse.status).toBe(201);

    const escapedSource = "\0".repeat(
      Math.floor((MAX_ARTIFACT_SOURCE_BYTES * 3) / 5),
    );
    expect(new TextEncoder().encode(escapedSource).byteLength).toBeLessThan(
      MAX_ARTIFACT_SOURCE_BYTES,
    );
    const amplifiedBodyResponse = await api(
      "/api/artifacts",
      jsonRequest({
        title: "Amplified JSON",
        type: "code",
        source: escapedSource,
        sessionId: "session",
      }),
    );
    expect(amplifiedBodyResponse.status).toBe(201);
  });

  it("enforces revision count and aggregate UTF-8 storage boundaries atomically", async () => {
    const countBounded = await createArtifact("0");
    let lastRevisionId = countBounded.revision.id;
    for (let version = 2; version <= MAX_ARTIFACT_REVISIONS; version += 1) {
      const revision = await createRevision(
        countBounded.artifact.id,
        countBounded.ownerToken,
        String(version),
      );
      lastRevisionId = revision.revision.id;
    }

    const countConflict = await api(
      `/api/artifacts/${countBounded.artifact.id}/revisions`,
      jsonRequest({ source: "one too many" }, countBounded.ownerToken),
    );
    expect(countConflict.status).toBe(409);
    expect(
      errorEnvelopeSchema.parse(await countConflict.json()).error.code,
    ).toBe("CONFLICT");

    const countState = await env.DB.prepare(
      `SELECT a.current_revision_id, COUNT(r.id) AS revision_count
       FROM artifacts a
       JOIN revisions r ON r.artifact_id = a.id
       WHERE a.id = ?
       GROUP BY a.id`,
    )
      .bind(countBounded.artifact.id)
      .first<{ current_revision_id: string; revision_count: number }>();
    expect(countState).toEqual({
      current_revision_id: lastRevisionId,
      revision_count: MAX_ARTIFACT_REVISIONS,
    });

    const aggregateBounded = await createArtifact(
      "a".repeat(MAX_ARTIFACT_SOURCE_BYTES),
    );
    const aggregateBoundary = await createRevision(
      aggregateBounded.artifact.id,
      aggregateBounded.ownerToken,
      "é".repeat(MAX_ARTIFACT_SOURCE_BYTES / 2),
    );
    const aggregateConflict = await api(
      `/api/artifacts/${aggregateBounded.artifact.id}/revisions`,
      jsonRequest({ source: "x" }, aggregateBounded.ownerToken),
    );
    expect(aggregateConflict.status).toBe(409);
    expect(
      errorEnvelopeSchema.parse(await aggregateConflict.json()).error.code,
    ).toBe("CONFLICT");

    const aggregateState = await env.DB.prepare(
      `SELECT a.current_revision_id,
              COUNT(r.id) AS revision_count,
              SUM(length(CAST(r.source AS BLOB))) AS source_bytes
       FROM artifacts a
       JOIN revisions r ON r.artifact_id = a.id
       WHERE a.id = ?
       GROUP BY a.id`,
    )
      .bind(aggregateBounded.artifact.id)
      .first<{
        current_revision_id: string;
        revision_count: number;
        source_bytes: number;
      }>();
    expect(aggregateState).toEqual({
      current_revision_id: aggregateBoundary.revision.id,
      revision_count: 2,
      source_bytes: MAX_ARTIFACT_TOTAL_SOURCE_BYTES,
    });
  });

  it("optionally requires the production artifact creation key", async () => {
    const protectedEnv: Env = {
      DB: env.DB,
      PANES_CREATE_API_KEY: "production-create-key",
    };
    const artifactPayload = {
      title: "Protected Artifact",
      type: "html",
      source: "<p>protected</p>",
      sessionId: "session",
    };

    const missing = await api(
      "/api/artifacts",
      jsonRequest(artifactPayload),
      protectedEnv,
    );
    expect(missing.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await missing.json()).error.code).toBe(
      "UNAUTHORIZED",
    );

    const wrong = await api(
      "/api/artifacts",
      jsonRequest(artifactPayload, undefined, {
        "X-Panes-Create-Key": "wrong-key",
      }),
      protectedEnv,
    );
    expect(wrong.status).toBe(401);

    const admitted = await api(
      "/api/artifacts",
      jsonRequest(artifactPayload, undefined, {
        "X-Panes-Create-Key": "production-create-key",
      }),
      protectedEnv,
    );
    expect(admitted.status).toBe(201);
    const created = createArtifactResponseSchema.parse(await admitted.json());

    const ownerRead = await api(
      `/api/artifacts/${created.artifact.id}`,
      { headers: { Authorization: `Bearer ${created.ownerToken}` } },
      protectedEnv,
    );
    expect(ownerRead.status).toBe(200);

    const ownerRevision = await api(
      `/api/artifacts/${created.artifact.id}/revisions`,
      jsonRequest({ source: "owner update" }, created.ownerToken),
      protectedEnv,
    );
    expect(ownerRevision.status).toBe(201);
  });

  it("requires owner authorization and increments immutable revisions", async () => {
    const created = await createArtifact();
    const artifactPath = `/api/artifacts/${created.artifact.id}`;
    const workspace = workspaceToken(created.viewerUrl);
    const viewer = new URL(created.viewerUrl);

    expect(viewer.pathname).toBe(`/artifacts/${created.artifact.id}`);
    expect(viewer.pathname).not.toContain(workspace);
    expect(viewer.search).toBe("");
    expect(viewer.hash).toBe(`#${WORKSPACE_TOKEN_FRAGMENT_KEY}=${workspace}`);

    const browserApiUrl = new URL(artifactPath, created.viewerUrl);
    expect(browserApiUrl.hash).toBe("");
    expect(browserApiUrl.href).not.toContain(workspace);
    const browserRequest = new Request(browserApiUrl, {
      headers: { Authorization: `Bearer ${workspace}` },
    });
    expect(new URL(browserRequest.url).hash).toBe("");
    expect((await worker.fetch(browserRequest, env)).status).toBe(200);

    const missingToken = await api(artifactPath);
    expect(missingToken.status).toBe(401);
    expect(
      errorEnvelopeSchema.parse(await missingToken.json()).error.code,
    ).toBe("UNAUTHORIZED");

    const wrongToken = await api(artifactPath, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongToken.status).toBe(403);

    const second = await createRevision(
      created.artifact.id,
      created.ownerToken,
      "<h1>version two</h1>",
    );
    expect(second.revision.version).toBe(2);

    const currentResponse = await api(artifactPath, {
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(currentResponse.status).toBe(200);
    const current = (await currentResponse.json()) as {
      artifact: { currentRevisionId: string };
      revision: { id: string; version: number; source: string };
    };
    expect(current.artifact.currentRevisionId).toBe(second.revision.id);
    expect(current.revision).toMatchObject({
      id: second.revision.id,
      version: 2,
      source: "<h1>version two</h1>",
    });

    const revisionsResponse = await api(`${artifactPath}/revisions`, {
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(revisionsResponse.status).toBe(200);
    const revisions = (await revisionsResponse.json()) as RevisionList;
    expect(revisions.revisions.map(({ version }) => version)).toEqual([2, 1]);
    expect(revisions.revisions[1]?.source).toBe("<h1>version one</h1>");

    const stored = await env.DB.prepare(
      "SELECT owner_token_hash, workspace_token_hash FROM artifacts WHERE id = ?",
    )
      .bind(created.artifact.id)
      .first<{ owner_token_hash: string; workspace_token_hash: string }>();
    expect(stored?.owner_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.workspace_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.owner_token_hash).not.toBe(created.ownerToken);
    expect(stored?.workspace_token_hash).not.toBe(workspace);
    expect(JSON.stringify(stored)).not.toContain(created.ownerToken);
    expect(JSON.stringify(stored)).not.toContain(workspace);
  });

  it("allows workspace read and publication access but forbids revisions", async () => {
    const created = await createArtifact();
    const artifactPath = `/api/artifacts/${created.artifact.id}`;
    const workspace = workspaceToken(created.viewerUrl);
    const workspaceHeaders = { Authorization: `Bearer ${workspace}` };

    const currentResponse = await api(artifactPath, {
      headers: workspaceHeaders,
    });
    expect(currentResponse.status).toBe(200);

    const revisionsResponse = await api(`${artifactPath}/revisions`, {
      headers: workspaceHeaders,
    });
    expect(revisionsResponse.status).toBe(200);

    const publishResponse = await api(
      `${artifactPath}/publish`,
      jsonRequest({ revisionId: created.revision.id }, workspace),
    );
    expect(publishResponse.status).toBe(201);
    const published = shareResponseSchema.parse(await publishResponse.json());
    const publicToken = shareToken(published.publicUrl);
    expect((await api(`/api/public/${publicToken}`)).status).toBe(200);

    const revisionResponse = await api(
      `${artifactPath}/revisions`,
      jsonRequest({ source: "workspace mutation" }, workspace),
    );
    expect(revisionResponse.status).toBe(403);
    expect(
      errorEnvelopeSchema.parse(await revisionResponse.json()).error.code,
    ).toBe("FORBIDDEN");

    const wrongTokenResponse = await api(artifactPath, {
      headers: { Authorization: "Bearer wrong-workspace-token" },
    });
    expect(wrongTokenResponse.status).toBe(403);

    const unpublishResponse = await api(`${artifactPath}/unpublish`, {
      method: "POST",
      headers: workspaceHeaders,
    });
    expect(unpublishResponse.status).toBe(204);
    expect((await api(`/api/public/${publicToken}`)).status).toBe(404);
  });

  it("pins a selected revision and isolates public data", async () => {
    const created = await createArtifact("<h1>private version one</h1>");
    const second = await createRevision(
      created.artifact.id,
      created.ownerToken,
      "<h1>private version two</h1>",
    );

    const publishResponse = await api(
      `/api/artifacts/${created.artifact.id}/publish`,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(publishResponse.status).toBe(201);
    const published = shareResponseSchema.parse(await publishResponse.json());
    expect(published.version).toBe(1);

    const token = shareToken(published.publicUrl);
    const publicResponse = await api(`/api/public/${token}`);
    expect(publicResponse.status).toBe(200);
    const publicShare = (await publicResponse.json()) as PublicShare;
    expect(publicShare.revision).toMatchObject({
      id: created.revision.id,
      version: 1,
      source: "<h1>private version one</h1>",
    });
    expect(Object.keys(publicShare.artifact).sort()).toEqual([
      "id",
      "title",
      "type",
    ]);

    const third = await createRevision(
      created.artifact.id,
      created.ownerToken,
      "<h1>private version three</h1>",
    );
    expect(third.revision.version).toBe(3);

    const stillPinned = (await (
      await api(`/api/public/${token}`)
    ).json()) as PublicShare;
    expect(stillPinned.revision.id).toBe(created.revision.id);

    const serializedPublicData = JSON.stringify(stillPinned);
    expect(serializedPublicData).not.toContain(created.ownerToken);
    expect(serializedPublicData).not.toContain(
      workspaceToken(created.viewerUrl),
    );
    expect(serializedPublicData).not.toContain("private-session-id");
    expect(serializedPublicData).not.toContain(second.revision.source);
    expect(serializedPublicData).not.toContain(third.revision.source);
    expect(serializedPublicData).not.toContain(created.viewerUrl);

    const storedShare = await env.DB.prepare(
      "SELECT token_hash FROM shares WHERE artifact_id = ? AND revoked_at IS NULL",
    )
      .bind(created.artifact.id)
      .first<{ token_hash: string }>();
    expect(storedShare?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedShare?.token_hash).not.toBe(token);
  });

  it("keeps same-revision publication idempotent and replaces another active share", async () => {
    const created = await createArtifact();
    const second = await createRevision(
      created.artifact.id,
      created.ownerToken,
      "<h1>version two</h1>",
    );
    const publishPath = `/api/artifacts/${created.artifact.id}/publish`;

    const firstResponse = await api(
      publishPath,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    const first = shareResponseSchema.parse(await firstResponse.json());
    const firstToken = shareToken(first.publicUrl);

    // The existing token remains active. A 204 avoids generating or exposing a replacement.
    const idempotentResponse = await api(
      publishPath,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(idempotentResponse.status).toBe(204);
    expect((await api(`/api/public/${firstToken}`)).status).toBe(200);

    const replacementResponse = await api(
      publishPath,
      jsonRequest({ revisionId: second.revision.id }, created.ownerToken),
    );
    expect(replacementResponse.status).toBe(201);
    const replacement = shareResponseSchema.parse(
      await replacementResponse.json(),
    );
    const replacementToken = shareToken(replacement.publicUrl);

    expect((await api(`/api/public/${firstToken}`)).status).toBe(404);
    const replacementPublic = (await (
      await api(`/api/public/${replacementToken}`)
    ).json()) as PublicShare;
    expect(replacementPublic.revision.id).toBe(second.revision.id);
  });

  it("allows only one concurrent same-revision publish to return a live URL", async () => {
    const created = await createArtifact();
    const publishPath = `/api/artifacts/${created.artifact.id}/publish`;

    const responses = await Promise.all([
      api(
        publishPath,
        jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
      ),
      api(
        publishPath,
        jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
      ),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 204]);
    const createdResponse = responses.find(({ status }) => status === 201);
    expect(createdResponse).toBeDefined();
    const published = shareResponseSchema.parse(await createdResponse?.json());
    expect(
      (await api(`/api/public/${shareToken(published.publicUrl)}`)).status,
    ).toBe(200);

    const activeShares = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM shares WHERE artifact_id = ? AND revoked_at IS NULL",
    )
      .bind(created.artifact.id)
      .first<{ count: number }>();
    expect(activeShares?.count).toBe(1);
  });

  it("revokes public access and makes unpublish idempotent", async () => {
    const created = await createArtifact();
    const publishResponse = await api(
      `/api/artifacts/${created.artifact.id}/publish`,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    const published = shareResponseSchema.parse(await publishResponse.json());
    const token = shareToken(published.publicUrl);
    const unpublishPath = `/api/artifacts/${created.artifact.id}/unpublish`;

    const firstUnpublish = await api(unpublishPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(firstUnpublish.status).toBe(204);
    expect((await api(`/api/public/${token}`)).status).toBe(404);

    const secondUnpublish = await api(unpublishPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(secondUnpublish.status).toBe(204);
  });

  it("allows only same-origin browser requests", async () => {
    const blocked = await api("/api/artifacts", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const preflight = await api("/api/artifacts", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Panes-Create-Key",
    );
  });

  it("redacts request and capability data from unexpected error logs", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const request = new Request(
      `${ORIGIN}/api/artifacts/private-artifact-token/revisions`,
      jsonRequest({ source: "private source body" }, "private-owner-token", {
        "X-Panes-Create-Key": "private-create-key",
      }),
    );

    logUnexpectedError(
      request,
      new Error("database failure containing private-source-value"),
    );

    expect(consoleError).toHaveBeenCalledOnce();
    const serialized = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(serialized)).toEqual({
      event: "worker.request.unexpected_error",
      errorName: "Error",
      method: "POST",
      route: "/api/artifacts/:artifactId/revisions",
    });
    expect(serialized).not.toContain("private-artifact-token");
    expect(serialized).not.toContain("private-owner-token");
    expect(serialized).not.toContain("private-create-key");
    expect(serialized).not.toContain("private source body");
    expect(serialized).not.toContain("private-source-value");
    consoleError.mockRestore();
  });
});
