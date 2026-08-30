import {
  creatorWorkspaceResponseSchema,
  publicationSchema,
  publicPublicationResponseSchema,
  syncCreateResponseSchema,
} from "@opencode-panes/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const ORIGIN = "https://panes.example";

function jsonRequest(value: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  };
}

async function api(path: string, init?: RequestInit, workerEnv: Env = env) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv);
}

async function syncedArtifact(
  inputFiles: Array<{
    path: string;
    bytes: Uint8Array;
    mediaType: string;
  }> = [
    {
      path: "index.html",
      bytes: new TextEncoder().encode("<h1>publication</h1>"),
      mediaType: "text/html",
    },
  ],
) {
  const slug = `publication-${crypto.randomUUID()}`;
  const create = await api(
    "/api/sync/artifacts",
    jsonRequest({
      projectId: `publication-project-${crypto.randomUUID()}`,
      artifactId: `publication-artifact-${crypto.randomUUID()}`,
      slug,
      title: "Publication test",
      idempotencyKey: `publication-${crypto.randomUUID()}`,
      ownerCredential: "publication-owner",
      creatorToken: `publication-creator-${crypto.randomUUID()}`,
    }),
  );
  const artifact = syncCreateResponseSchema.parse(await create.json());
  const revision = {
    id: `revision-${crypto.randomUUID()}`,
    version: 1,
    preview: { adapter: "browser" as const, entryPath: "index.html" },
    approvedOrigins: [],
    files: await Promise.all(
      inputFiles.map(async ({ path, bytes, mediaType }) => ({
        kind: "file" as const,
        path,
        sha256: await hash(bytes),
        byteSize: bytes.byteLength,
        mediaType,
      })),
    ),
    createdAt: "2026-08-29T12:00:00.000Z",
  };
  const manifest = {
    schemaVersion: 1 as const,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.cloudArtifactId,
    slug,
    title: "Publication test",
    revisions: [revision],
  };
  for (const file of revision.files) {
    const input = inputFiles.find((candidate) => candidate.path === file.path);
    if (!input)
      throw new Error(`publication test file is missing: ${file.path}`);
    const upload = await api(
      `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/files/${encodePath(file.path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer publication-owner",
          "Content-Type": file.mediaType,
          "X-Panes-File-SHA256": file.sha256,
          "X-Panes-File-Byte-Size": String(file.byteSize),
        },
        body: input.bytes.buffer as ArrayBuffer,
      },
    );
    expect(upload.status).toBe(204);
  }
  const commit = await api(
    `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/1/commit`,
    jsonRequest({ manifest }, "publication-owner"),
  );
  expect(commit.status).toBe(201);
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/lease/release`,
        {
          method: "POST",
          headers: { Authorization: "Bearer publication-owner" },
        },
      )
    ).status,
  ).toBe(204);
  return {
    ...artifact,
    creatorToken: artifact.creatorUrl.split("/").at(-1)!,
    initialRevision: revision,
    revisionId: revision.id,
    slug,
  };
}

async function syncRevision(
  artifact: Awaited<ReturnType<typeof syncedArtifact>>,
  version: number,
  source: string,
) {
  const revision = {
    id: `revision-${crypto.randomUUID()}`,
    version,
    preview: { adapter: "browser" as const, entryPath: "index.html" },
    approvedOrigins: [],
    files: [
      {
        kind: "file" as const,
        path: "index.html",
        sha256: await hash(source),
        byteSize: new TextEncoder().encode(source).byteLength,
        mediaType: "text/html",
      },
    ],
    createdAt: "2026-08-29T12:00:00.000Z",
  };
  const file = revision.files[0];
  const bytes = new TextEncoder().encode(source);
  if (!file) throw new Error("revision test file is missing");
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/${version}/files/index.html`,
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer publication-owner",
            "Content-Type": "text/html",
            "X-Panes-File-SHA256": file.sha256,
            "X-Panes-File-Byte-Size": String(bytes.byteLength),
          },
          body: bytes,
        },
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/lease/release`,
        {
          method: "POST",
          headers: { Authorization: "Bearer publication-owner" },
        },
      )
    ).status,
  ).toBe(204);
  const manifest = {
    schemaVersion: 1 as const,
    projectId: artifact.cloudProjectId,
    artifactId: artifact.cloudArtifactId,
    slug: artifact.slug,
    title: "Publication test",
    revisions: [artifact.initialRevision, revision],
  };
  const commit = await api(
    `/api/sync/artifacts/${artifact.cloudArtifactId}/revisions/${version}/commit`,
    jsonRequest({ manifest }, "publication-owner"),
  );
  expect(commit.status).toBe(201);
  expect(
    (
      await api(
        `/api/sync/artifacts/${artifact.cloudArtifactId}/lease/release`,
        {
          method: "POST",
          headers: { Authorization: "Bearer publication-owner" },
        },
      )
    ).status,
  ).toBe(204);
}

describe("local-first publication lifecycle", () => {
  it("publishes one selected Revision with a defaultable explicit duration", async () => {
    const artifact = await syncedArtifact();
    const publish = await api(
      `/api/creator/${artifact.creatorToken}/publish`,
      jsonRequest({ revisionVersion: 1, durationDays: 7 }),
    );
    expect(publish.status).toBe(201);
    const publication = publicationSchema.parse(await publish.json());
    expect(publication).toMatchObject({
      artifactId: artifact.cloudArtifactId,
      revisionVersion: 1,
      durationDays: 7,
      status: "active",
    });
    expect(publication.publicUrl).toBeUndefined();

    const stored = await env.DB.prepare(
      "SELECT * FROM publications WHERE id = ?",
    )
      .bind(publication.id)
      .first<{
        token_hash: string;
        token_ciphertext: string;
        token_nonce: string;
        encryption_key_version: number;
      }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.token_ciphertext).toEqual(expect.any(String));
    expect(stored?.token_nonce).toMatch(/^[0-9a-f]{24}$/u);
    expect(stored?.encryption_key_version).toBe(1);
    const indexes = await env.DB.prepare(
      "PRAGMA index_list(publications)",
    ).all<{
      unique: number;
    }>();
    expect(indexes.results.some((index) => index.unique === 1)).toBe(true);
    const key = await crypto.subtle.importKey(
      "raw",
      hexBytes(
        "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      ),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: hexBytes(stored?.token_nonce ?? ""),
        additionalData: new TextEncoder().encode(
          `opencode-panes/publication/${publication.artifactId}/${publication.id}/key-v1`,
        ),
      },
      key,
      base64Bytes(stored?.token_ciphertext ?? ""),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(
      await storedPublicationToken(artifact.cloudArtifactId, publication.id),
    );
    expect(JSON.stringify(stored)).not.toContain(
      await storedPublicationToken(artifact.cloudArtifactId, publication.id),
    );
  });

  it("shares the selected Revision with a seven-day default and returns its Public URL", async () => {
    const artifact = await syncedArtifact();
    const share = await api(
      `/api/creator/${artifact.creatorToken}/share`,
      jsonRequest({ revisionVersion: 1 }),
    );
    expect(share.status).toBe(201);
    const publication = publicationSchema.parse(await share.json());
    expect(publication).toMatchObject({
      artifactId: artifact.cloudArtifactId,
      revisionVersion: 1,
      durationDays: 7,
      status: "active",
    });
    expect(publication.publicUrl).toMatch(
      /^https:\/\/panes\.example\/published\/[0-9a-f]{64}$/u,
    );
    const publicToken = publication.publicUrl?.split("/").at(-1);
    expect(publicToken).toBeDefined();
    const publicResponse = await api(`/api/publications/${publicToken}`);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).not.toContain(publicToken ?? "");
  });

  it("updates an active Share in place while preserving its URL, token, and expiry", async () => {
    const artifact = await syncedArtifact();
    await syncRevision(artifact, 2, "<h1>second</h1>");
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/share`,
          jsonRequest({ revisionVersion: 1 }),
        )
      ).json(),
    );
    const firstStored = await env.DB.prepare(
      "SELECT created_at, token_hash, token_ciphertext, token_nonce FROM publications WHERE id = ?",
    )
      .bind(first.id)
      .first<{
        created_at: string;
        token_hash: string;
        token_ciphertext: string;
        token_nonce: string;
      }>();
    const refreshed = await api(`/api/creator/${artifact.creatorToken}/share`, {
      method: "GET",
    });
    expect(refreshed.status).toBe(200);
    expect(publicationSchema.parse(await refreshed.json())).toMatchObject({
      id: first.id,
      publicUrl: first.publicUrl,
      revisionVersion: 1,
      expiresAt: first.expiresAt,
    });
    const updated = await api(
      `/api/creator/${artifact.creatorToken}/share`,
      jsonRequest({ revisionVersion: 2, durationDays: 30 }),
    );
    expect(updated.status).toBe(200);
    const second = publicationSchema.parse(await updated.json());
    expect(second).toMatchObject({
      id: first.id,
      revisionVersion: 2,
      durationDays: first.durationDays,
      expiresAt: first.expiresAt,
      publicUrl: first.publicUrl,
    });
    const secondStored = await env.DB.prepare(
      "SELECT created_at, token_hash, token_ciphertext, token_nonce FROM publications WHERE id = ?",
    )
      .bind(second.id)
      .first<typeof firstStored>();
    expect(secondStored).toEqual(firstStored);
    const activeRows = await env.DB.prepare(
      "SELECT id, revision_version FROM publications WHERE artifact_id = ? AND status = 'active'",
    )
      .bind(artifact.cloudArtifactId)
      .all<{ id: string; revision_version: number }>();
    expect(activeRows.results).toEqual([{ id: first.id, revision_version: 2 }]);

    const publicToken = second.publicUrl?.split("/").at(-1);
    const publicResponse = await api(`/api/publications/${publicToken}`);
    expect(publicResponse.status).toBe(200);
    const publicWorkspace = publicPublicationResponseSchema.parse(
      await publicResponse.json(),
    );
    expect(publicWorkspace.revision.version).toBe(2);
  });

  it("creates a new Share token after expiry or revocation", async () => {
    const artifact = await syncedArtifact();
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/share`,
          jsonRequest({ revisionVersion: 1 }),
        )
      ).json(),
    );
    await env.DB.prepare("UPDATE publications SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", first.id)
      .run();
    const afterExpiry = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/share`,
          jsonRequest({ revisionVersion: 1 }),
        )
      ).json(),
    );
    expect(afterExpiry.id).not.toBe(first.id);
    expect(afterExpiry.publicUrl).not.toBe(first.publicUrl);

    await api(`/api/creator/${artifact.creatorToken}/unpublish`, {
      method: "POST",
    });
    const afterRevoke = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/share`,
          jsonRequest({ revisionVersion: 1 }),
        )
      ).json(),
    );
    expect(afterRevoke.id).not.toBe(afterExpiry.id);
    expect(afterRevoke.publicUrl).not.toBe(afterExpiry.publicUrl);
  });

  it("does not report a successful Share when its Public URL cannot be recovered", async () => {
    const artifact = await syncedArtifact();
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/share`,
          jsonRequest({ revisionVersion: 1 }),
        )
      ).json(),
    );
    await env.DB.prepare(
      "UPDATE publications SET token_ciphertext = ? WHERE id = ?",
    )
      .bind("tampered", first.id)
      .run();
    const response = await api(
      `/api/creator/${artifact.creatorToken}/share`,
      jsonRequest({ revisionVersion: 1 }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(first.publicUrl ?? "");
  });

  it("rejects non-POST unpublish requests without revoking the active Share", async () => {
    const artifact = await syncedArtifact();
    const shared = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/share`,
          jsonRequest({ revisionVersion: 1 }),
        )
      ).json(),
    );

    const response = await api(
      `/api/creator/${artifact.creatorToken}/unpublish`,
      { method: "GET" },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");

    const active = await api(`/api/creator/${artifact.creatorToken}/share`, {
      method: "GET",
    });
    expect(active.status).toBe(200);
    expect(publicationSchema.parse(await active.json()).id).toBe(shared.id);
  });

  it("reuses same-active state without extending, and supports explicit actions", async () => {
    const artifact = await syncedArtifact();
    const path = `/api/creator/${artifact.creatorToken}/publish`;
    const first = publicationSchema.parse(
      await (
        await api(path, jsonRequest({ revisionVersion: 1, durationDays: 1 }))
      ).json(),
    );
    const replay = publicationSchema.parse(
      await (
        await api(path, jsonRequest({ revisionVersion: 1, durationDays: 30 }))
      ).json(),
    );
    expect(replay.id).toBe(first.id);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(first.publicUrl).toBeUndefined();
    expect(replay.publicUrl).toBeUndefined();
    const publicToken = await storedPublicationToken(
      artifact.cloudArtifactId,
      first.id,
    );

    const extended = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/extend`,
          jsonRequest({ durationDays: 1 }),
        )
      ).json(),
    );
    expect(Date.parse(extended.expiresAt)).toBe(
      Date.parse(first.expiresAt) + 24 * 60 * 60 * 1000,
    );
    expect(
      (
        await api(`/api/creator/${artifact.creatorToken}/unpublish`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    expect((await api(`/api/publications/${publicToken}`)).status).toBe(410);
    const workspace = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(workspace.publication).toBeNull();
    expect(workspace.publicationHistory?.[0]?.status).toBe("revoked");
  });

  it("keeps creator metadata operations independent from recoverable ciphertext", async () => {
    const artifact = await syncedArtifact();
    const publish = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    await env.DB.prepare(
      "UPDATE publications SET token_ciphertext = ? WHERE id = ?",
    )
      .bind("tampered", publish.id)
      .run();
    const sameActive = await api(
      `/api/creator/${artifact.creatorToken}/publish`,
      jsonRequest({ revisionVersion: 1, durationDays: 7 }),
    );
    expect(sameActive.status).toBe(200);
    expect(
      publicationSchema.parse(await sameActive.json()).publicUrl,
    ).toBeUndefined();
    const afterTamper = await env.DB.prepare(
      "SELECT id, status, token_hash FROM publications WHERE artifact_id = ?",
    )
      .bind(artifact.cloudArtifactId)
      .all<{ id: string; status: string; token_hash: string }>();
    expect(afterTamper.results).toHaveLength(1);
    expect(afterTamper.results[0]).toMatchObject({
      id: publish.id,
      status: "active",
    });

    const noKeyEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
    };
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
          noKeyEnv,
        )
      ).status,
    ).toBe(200);
    const extended = await api(
      `/api/creator/${artifact.creatorToken}/extend`,
      jsonRequest({ durationDays: 1 }),
    );
    expect(extended.status).toBe(200);
    expect(
      publicationSchema.parse(await extended.json()).publicUrl,
    ).toBeUndefined();
  });

  it("replaces another revision and republishes after revoke or expiry", async () => {
    const artifact = await syncedArtifact();
    await syncRevision(artifact, 2, "<h1>second</h1>");
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const firstStored = await env.DB.prepare(
      "SELECT token_nonce FROM publications WHERE id = ?",
    )
      .bind(first.id)
      .first<{ token_nonce: string }>();
    const firstToken = await storedPublicationToken(
      artifact.cloudArtifactId,
      first.id,
    );
    const replacement = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 2, durationDays: 1 }),
        )
      ).json(),
    );
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.revisionVersion).toBe(2);
    const replacementStored = await env.DB.prepare(
      "SELECT token_nonce FROM publications WHERE id = ?",
    )
      .bind(replacement.id)
      .first<{ token_nonce: string }>();
    expect(replacementStored?.token_nonce).toMatch(/^[0-9a-f]{24}$/u);
    expect(replacementStored?.token_nonce).not.toBe(firstStored?.token_nonce);
    expect((await api(`/api/publications/${firstToken}`)).status).toBe(410);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM publications WHERE artifact_id = ? AND status = 'active'",
        )
          .bind(artifact.cloudArtifactId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const republishedAfterRevoke = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/republish`,
          jsonRequest({ revisionVersion: 2, durationDays: 1 }),
        )
      ).json(),
    );
    expect(republishedAfterRevoke.id).not.toBe(replacement.id);
    await env.DB.prepare("UPDATE publications SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", republishedAfterRevoke.id)
      .run();
    const republished = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/republish`,
          jsonRequest({ revisionVersion: 2, durationDays: 30 }),
        )
      ).json(),
    );
    expect(republished.id).not.toBe(replacement.id);
    expect(replacement.publicUrl).toBeUndefined();
    expect(republished.publicUrl).toBeUndefined();
    const workspace = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    const historyStatuses = workspace.publicationHistory?.map(
      (item) => item.status,
    );
    expect(
      historyStatuses?.filter((status) => status === "active"),
    ).toHaveLength(1);
    expect(
      historyStatuses?.filter((status) => status === "expired"),
    ).toHaveLength(1);
    expect(
      historyStatuses?.filter((status) => status === "revoked"),
    ).toHaveLength(2);
  });

  it("keeps creator expiry independent from publication expiry and isolates legacy routes", async () => {
    const artifact = await syncedArtifact();
    const publication = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const token = await storedPublicationToken(
      artifact.cloudArtifactId,
      publication.id,
    );
    expect((await api(`/api/public/${token}`)).status).toBe(404);
    const privateSnapshot = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(privateSnapshot.publication?.publicUrl).toBeUndefined();
    await env.DB.prepare(
      "UPDATE creator_links SET expires_at = ? WHERE token_hash = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", await hash(artifact.creatorToken))
      .run();
    expect((await api(`/api/creator/${artifact.creatorToken}`)).status).toBe(
      410,
    );
    expect((await api(`/api/publications/${token}`)).status).toBe(200);

    const unknownToken = "a".repeat(64);
    const unknownResponse = await api(`/api/publications/${unknownToken}`);
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.text()).not.toContain(unknownToken);
  });

  it("keeps adopted provenance private after a committed publication", async () => {
    const artifact = await syncedArtifact();
    const provenance = {
      grantId: "adoption-grant-public-privacy",
      cloudArtifactId: artifact.cloudArtifactId,
      localProjectId: "adopted-local-project",
      localArtifactId: "adopted-local-artifact",
      localSlug: "adopted-local-slug",
      legacyArtifactId: "legacy-private-artifact",
      legacyRevisionId: "legacy-private-revision",
      legacyRevisionVersion: 1,
      legacyTitle: "Adopted publication",
      legacyType: "html" as const,
      createdAt: "2026-08-29T12:00:00.000Z",
    };
    await env.DB.prepare(
      `INSERT INTO legacy_adoption_provenance
        (grant_id, cloud_artifact_id, local_project_id, local_artifact_id,
         local_slug, legacy_artifact_id, legacy_revision_id,
         legacy_revision_version, legacy_title, legacy_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        provenance.grantId,
        provenance.cloudArtifactId,
        provenance.localProjectId,
        provenance.localArtifactId,
        provenance.localSlug,
        provenance.legacyArtifactId,
        provenance.legacyRevisionId,
        provenance.legacyRevisionVersion,
        provenance.legacyTitle,
        provenance.legacyType,
        provenance.createdAt,
      )
      .run();

    const publication = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const publicToken = await storedPublicationToken(
      artifact.cloudArtifactId,
      publication.id,
    );
    const creator = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(creator.legacyProvenance).toMatchObject({
      grantId: provenance.grantId,
      localProjectId: provenance.localProjectId,
      localArtifactId: provenance.localArtifactId,
      localSlug: provenance.localSlug,
    });

    const publicResponse = await api(`/api/publications/${publicToken}`);
    expect(publicResponse.status).toBe(200);
    const publicBody = await publicResponse.text();
    for (const value of [
      provenance.grantId,
      provenance.legacyArtifactId,
      provenance.legacyRevisionId,
      provenance.localProjectId,
      provenance.localArtifactId,
      provenance.localSlug,
    ]) {
      expect(publicBody).not.toContain(value);
    }
  });

  it("keeps creator metadata operations independent from ciphertext contents", async () => {
    const artifact = await syncedArtifact();
    const first = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const firstStored = await env.DB.prepare(
      "SELECT token_ciphertext, token_nonce FROM publications WHERE id = ?",
    )
      .bind(first.id)
      .first<{ token_ciphertext: string; token_nonce: string }>();
    await env.DB.prepare(
      "UPDATE publications SET status = 'revoked', revoked_at = ?, token_ciphertext = NULL, token_nonce = NULL, encryption_key_version = NULL WHERE id = ?",
    )
      .bind(new Date().toISOString(), first.id)
      .run();
    const second = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/republish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    await env.DB.prepare(
      "UPDATE publications SET token_ciphertext = ?, token_nonce = ? WHERE id = ?",
    )
      .bind(firstStored?.token_ciphertext, firstStored?.token_nonce, second.id)
      .run();
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM publications WHERE artifact_id = ? AND status = 'active'",
        )
          .bind(artifact.cloudArtifactId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    await env.DB.prepare(
      "UPDATE publications SET encryption_key_version = 2 WHERE id = ?",
    )
      .bind(second.id)
      .run();
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(200);
    const wrongKeyEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
      PUBLICATION_ENCRYPTION_KEY_V1:
        "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    };
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
          wrongKeyEnv,
        )
      ).status,
    ).toBe(200);
  });

  it("serializes competing mutations and exposes a deterministic busy response", async () => {
    const artifact = await syncedArtifact();
    await syncRevision(artifact, 2, "<h1>competing second</h1>");
    await env.DB.prepare(
      "UPDATE sync_artifacts SET publication_lease_owner = ?, publication_lease_expires_at = ? WHERE cloud_artifact_id = ?",
    )
      .bind(
        "test-held-lease",
        "2999-01-01T00:00:00.000Z",
        artifact.cloudArtifactId,
      )
      .run();
    expect(
      (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).status,
    ).toBe(409);
    await env.DB.prepare(
      "UPDATE sync_artifacts SET publication_lease_owner = NULL, publication_lease_expires_at = NULL WHERE cloud_artifact_id = ?",
    )
      .bind(artifact.cloudArtifactId)
      .run();

    const results = await Promise.all([
      api(
        `/api/creator/${artifact.creatorToken}/publish`,
        jsonRequest({ revisionVersion: 1, durationDays: 7 }),
      ),
      api(
        `/api/creator/${artifact.creatorToken}/publish`,
        jsonRequest({ revisionVersion: 2, durationDays: 7 }),
      ),
    ]);
    const statuses = results.map((response) => response.status);
    expect(statuses).toContain(201);
    expect(statuses.every((status) => status === 201 || status === 409)).toBe(
      true,
    );
    const committed = await Promise.all(
      results
        .filter((response) => response.status === 201)
        .map(async (response) =>
          publicationSchema.parse(await response.json()),
        ),
    );
    const rows = await env.DB.prepare(
      "SELECT status, revision_version FROM publications WHERE artifact_id = ? ORDER BY created_at ASC",
    )
      .bind(artifact.cloudArtifactId)
      .all<{ status: string; revision_version: number }>();
    expect(rows.results.filter((row) => row.status === "active")).toHaveLength(
      1,
    );
    expect(rows.results).toHaveLength(committed.length);
    const workspace = creatorWorkspaceResponseSchema.parse(
      await (await api(`/api/creator/${artifact.creatorToken}`)).json(),
    );
    expect(workspace.publication?.revisionVersion).toBe(
      rows.results.find((row) => row.status === "active")?.revision_version,
    );
    if (!workspace.publication)
      throw new Error("active publication is missing");
    expect(committed.map((publication) => publication.id)).toContain(
      workspace.publication.id,
    );
    const activeCommitted = committed.find(
      (publication) => publication.id === workspace.publication?.id,
    );
    if (!activeCommitted)
      throw new Error("active publication response is missing");
    const activeToken = await storedPublicationToken(
      artifact.cloudArtifactId,
      activeCommitted.id,
    );
    expect((await api(`/api/publications/${activeToken}`)).status).toBe(200);
  });

  it("isolates a public multi-file Revision and authenticates by hash only", async () => {
    const artifact = await syncedArtifact([
      {
        path: "index.html",
        bytes: new TextEncoder().encode(
          '<script src="assets/app.js"></script><img src="assets/logo.svg">',
        ),
        mediaType: "text/html",
      },
      {
        path: "assets/app.js",
        bytes: new TextEncoder().encode("document.body.dataset.ready = 'yes';"),
        mediaType: "text/javascript",
      },
      {
        path: "assets/data.bin",
        bytes: Uint8Array.from([0, 255, 1, 254]),
        mediaType: "application/octet-stream",
      },
    ]);
    await syncRevision(artifact, 2, "<h1>private later revision</h1>");
    const publication = publicationSchema.parse(
      await (
        await api(
          `/api/creator/${artifact.creatorToken}/publish`,
          jsonRequest({ revisionVersion: 1, durationDays: 7 }),
        )
      ).json(),
    );
    const token = await storedPublicationToken(
      artifact.cloudArtifactId,
      publication.id,
    );

    const workspaceResponse = await api(`/api/publications/${token}`);
    expect(workspaceResponse.status).toBe(200);
    expect(workspaceResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(workspaceResponse.headers.get("Referrer-Policy")).toBe(
      "no-referrer",
    );
    const workspace = (await workspaceResponse.json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(workspace).sort()).toEqual([
      "artifact",
      "expiresAt",
      "revision",
      "status",
    ]);
    expect(workspace.artifact).toEqual({
      slug: artifact.slug,
      title: "Publication test",
    });
    const publicRevision = workspace.revision as Record<string, unknown>;
    expect(publicRevision.version).toBe(1);
    expect(
      (publicRevision.files as Array<Record<string, unknown>>).map(
        (file) => file.path,
      ),
    ).toEqual(["index.html", "assets/app.js", "assets/data.bin"]);
    expect(JSON.stringify(workspace)).not.toContain(artifact.cloudArtifactId);
    expect(JSON.stringify(workspace)).not.toContain(artifact.cloudProjectId);
    expect(JSON.stringify(workspace)).not.toContain("object_key");

    const nested = await api(`/api/publications/${token}/files/assets/app.js`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("dataset.ready");
    expect(nested.headers.get("Content-Security-Policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(nested.headers.get("Content-Security-Policy")).toContain(
      "connect-src https:",
    );
    expect(nested.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(
      (await api(`/api/publications/${token}/files/assets/data.bin`)).status,
    ).toBe(200);
    expect(
      (
        await api(`/api/publications/${token}/files/assets/data.bin?download=1`)
      ).headers.get("Content-Disposition"),
    ).toContain("attachment");

    for (const path of [
      "v1/index.html",
      "v2/index.html",
      "../index.html",
      "%2e%2e/index.html",
      "assets%2Fapp.js",
      "missing.txt",
    ]) {
      expect(
        (await api(`/api/publications/${token}/files/${path}`)).status,
      ).toBe(404);
    }

    const noEncryptionKey: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
    };
    await env.DB.prepare(
      "UPDATE publications SET token_ciphertext = ? WHERE id = ?",
    )
      .bind("tampered-ciphertext", publication.id)
      .run();
    expect(
      (await api(`/api/publications/${token}`, undefined, noEncryptionKey))
        .status,
    ).toBe(200);
    expect(
      (
        await api(
          `/api/publications/${token}/files/assets/app.js`,
          undefined,
          noEncryptionKey,
        )
      ).status,
    ).toBe(200);

    await env.DB.prepare(
      "UPDATE publications SET status = 'revoked', revoked_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), publication.id)
      .run();
    expect((await api(`/api/publications/${token}`)).status).toBe(410);
  });
});

async function hash(value: Uint8Array): Promise<string>;
async function hash(value: string): Promise<string>;
async function hash(value: string | Uint8Array) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function storedPublicationToken(
  artifactId: string,
  publicationId: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT token_ciphertext, token_nonce FROM publications WHERE id = ?",
  )
    .bind(publicationId)
    .first<{ token_ciphertext: string; token_nonce: string }>();
  if (!row) throw new Error("Publication ciphertext is missing");
  const key = await crypto.subtle.importKey(
    "raw",
    hexBytes(
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    ),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: hexBytes(row.token_nonce),
      additionalData: new TextEncoder().encode(
        `opencode-panes/publication/${artifactId}/${publicationId}/key-v1`,
      ),
    },
    key,
    base64Bytes(row.token_ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function hexBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function base64Bytes(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
