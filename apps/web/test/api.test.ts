import {
  MAX_ARTIFACT_SOURCE_BYTES,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  createArtifactResponseSchema,
  errorEnvelopeSchema,
} from "@opencode-panes/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker, { logUnexpectedError } from "../worker";

const ORIGIN = "https://panes.example";

interface RevisionList {
  artifactId: string;
  revisions: Array<{ id: string; version: number; source: string }>;
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

  it("atomically classifies first creation and bounds it as read-only", async () => {
    const created = await createArtifact("exact first source");
    const classification = await env.DB.prepare(
      "SELECT migrated_at, private_expires_at FROM legacy_artifacts WHERE artifact_id = ?",
    )
      .bind(created.artifact.id)
      .first<{ migrated_at: string; private_expires_at: string }>();
    expect(classification).toEqual({
      migrated_at: created.revision.createdAt,
      private_expires_at: new Date(
        Date.parse(created.revision.createdAt) + 30 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    const revision = await api(
      `/api/artifacts/${created.artifact.id}/revisions`,
      jsonRequest({ source: "must not be stored" }, created.ownerToken),
    );
    expect(revision.status).toBe(409);
    expect(errorEnvelopeSchema.parse(await revision.json()).error.message).toBe(
      "Legacy artifacts are read-only",
    );

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?",
    )
      .bind(created.artifact.id)
      .first<{ count: number }>();
    expect(stored?.count).toBe(1);

    await env.DB.prepare(
      "UPDATE legacy_artifacts SET private_expires_at = ? WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", created.artifact.id)
      .run();
    expect(
      (
        await api(`/api/artifacts/${created.artifact.id}`, {
          headers: { Authorization: `Bearer ${created.ownerToken}` },
        })
      ).status,
    ).toBe(410);
  });

  it("optionally requires the production artifact creation key", async () => {
    const protectedEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
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
    expect(ownerRevision.status).toBe(409);
  });

  it("requires owner authorization and preserves the immutable first revision", async () => {
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

    const rejectedRevision = await api(
      `${artifactPath}/revisions`,
      jsonRequest({ source: "<h1>version two</h1>" }, created.ownerToken),
    );
    expect(rejectedRevision.status).toBe(409);

    const currentResponse = await api(artifactPath, {
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(currentResponse.status).toBe(200);
    const current = (await currentResponse.json()) as {
      artifact: { currentRevisionId: string };
      revision: { id: string; version: number; source: string };
    };
    expect(current.artifact.currentRevisionId).toBe(created.revision.id);
    expect(current.revision).toMatchObject({
      id: created.revision.id,
      version: 1,
      source: "<h1>version one</h1>",
    });

    const revisionsResponse = await api(`${artifactPath}/revisions`, {
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(revisionsResponse.status).toBe(200);
    const revisions = (await revisionsResponse.json()) as RevisionList;
    expect(revisions.revisions.map(({ version }) => version)).toEqual([1]);
    expect(revisions.revisions[0]?.source).toBe("<h1>version one</h1>");

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
    expect(publishResponse.status).toBe(409);

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
    expect(unpublishResponse.status).toBe(409);
  });

  it("keeps the first revision private because Legacy publication is disabled", async () => {
    const created = await createArtifact("<h1>private version one</h1>");
    const publishResponse = await api(
      `/api/artifacts/${created.artifact.id}/publish`,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(publishResponse.status).toBe(409);
    const shares = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM shares WHERE artifact_id = ?",
    )
      .bind(created.artifact.id)
      .first<{ count: number }>();
    expect(shares?.count).toBe(0);
  });

  it("rejects all Legacy publication attempts, including concurrent attempts", async () => {
    const created = await createArtifact();
    const publishPath = `/api/artifacts/${created.artifact.id}/publish`;

    const firstResponse = await api(
      publishPath,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(firstResponse.status).toBe(409);

    const idempotentResponse = await api(
      publishPath,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(idempotentResponse.status).toBe(409);

    const replacementResponse = await api(
      publishPath,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(replacementResponse.status).toBe(409);
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

    expect(responses.map(({ status }) => status).sort()).toEqual([409, 409]);

    const activeShares = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM shares WHERE artifact_id = ? AND revoked_at IS NULL",
    )
      .bind(created.artifact.id)
      .first<{ count: number }>();
    expect(activeShares?.count).toBe(0);
  });

  it("rejects Legacy unpublish without mutating historical shares", async () => {
    const created = await createArtifact();
    const publishResponse = await api(
      `/api/artifacts/${created.artifact.id}/publish`,
      jsonRequest({ revisionId: created.revision.id }, created.ownerToken),
    );
    expect(publishResponse.status).toBe(409);
    const unpublishPath = `/api/artifacts/${created.artifact.id}/unpublish`;

    const firstUnpublish = await api(unpublishPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(firstUnpublish.status).toBe(409);

    const secondUnpublish = await api(unpublishPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    expect(secondUnpublish.status).toBe(409);
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
