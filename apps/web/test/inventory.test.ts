import { exportJWK, generateKeyPair, SignJWT, errors, type JWK } from "jose";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { clearAccessJwksCache } from "../worker/access";
import {
  cloudDeletionConfirmation,
  deleteInventoryArtifact,
  deleteLegacyInventoryArtifact,
} from "../worker/deletion";
import {
  inventoryReconnectCodeResponseSchema,
  inventoryCreatorRotateResponseSchema,
  legacyAdoptionIssueResponseSchema,
  legacyAdoptionRedeemResponseSchema,
  creatorWorkspaceResponseSchema,
  inventoryResponseSchema,
  publicationSchema,
  syncReconnectResponseSchema,
} from "@opencode-panes/contracts";
import { loadInventory, reconnectCodeConfirmation } from "../worker/inventory";
import { readBoundedText } from "../worker/bounded-json";
import { privateRevisionObjectKey } from "../worker/storage";

const ORIGIN = "https://panes.example";
const RECONNECT_MANIFEST_V1_KEY =
  "private/manifests/636c6f75642d70726f6a6563742d6f6e65/636c6f75642d61727469666163742d6f6e65/v1.json";
const RECONNECT_MANIFEST_V2_KEY =
  "private/manifests/636c6f75642d70726f6a6563742d6f6e65/636c6f75642d61727469666163742d6f6e65/v2.json";
const KEY_MATERIAL =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

interface AccessMaterial {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  jwk: JWK;
  issuer: string;
  audience: string;
}

beforeEach(async () => {
  clearAccessJwksCache();
  vi.unstubAllGlobals();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM legacy_adoption_provenance"),
    env.DB.prepare("DELETE FROM legacy_adoption_grants"),
    env.DB.prepare(
      "DELETE FROM artifacts WHERE id LIKE 'inventory-legacy-%' OR id LIKE 'legacy-adoption-%'",
    ),
    env.DB.prepare("DELETE FROM artifact_deletion_objects"),
    env.DB.prepare("DELETE FROM artifact_deletion_tombstones"),
    env.DB.prepare("DELETE FROM publications"),
    env.DB.prepare("DELETE FROM creator_links"),
    env.DB.prepare("DELETE FROM revision_files"),
    env.DB.prepare("DELETE FROM local_revisions"),
    env.DB.prepare("DELETE FROM sync_artifacts"),
    env.DB.prepare("DELETE FROM local_artifacts"),
    env.DB.prepare("DELETE FROM projects"),
  ]);
});

describe("authenticated cloud inventory", () => {
  it("issues an Access-gated adoption code and redeems it once for the current Legacy revision", async () => {
    const material = await accessMaterial("adoption");
    stubJwks(material);
    const source = "\uFEFF<html>\r\n\0café</html>\r\n";
    const shareHash = await sha256Text("legacy-adoption-share");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO artifacts (id, owner_token_hash, workspace_token_hash, opencode_session_id, title, type, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "legacy-adoption-one",
        "a".repeat(64),
        "b".repeat(64),
        "legacy-session",
        "Adopt me",
        "html",
        "legacy-adoption-revision-2",
        "2026-08-29T12:00:00.000Z",
        "2026-08-29T12:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO revisions (id, artifact_id, version, source, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "legacy-adoption-revision-1",
        "legacy-adoption-one",
        1,
        "<html>old</html>",
        "2026-08-29T12:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO revisions (id, artifact_id, version, source, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        "legacy-adoption-revision-2",
        "legacy-adoption-one",
        2,
        source,
        "2026-08-29T12:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO shares (token_hash, artifact_id, revision_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(
        shareHash,
        "legacy-adoption-one",
        "legacy-adoption-revision-1",
        "2026-08-29T12:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO legacy_shares (token_hash, artifact_id, migrated_at, public_expires_at) VALUES (?, ?, ?, ?)",
      ).bind(
        shareHash,
        "legacy-adoption-one",
        "2026-08-29T12:00:00.000Z",
        "2099-08-29T12:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO legacy_artifacts (artifact_id, migrated_at, private_expires_at) VALUES (?, ?, ?)",
      ).bind(
        "legacy-adoption-one",
        "2026-08-29T12:00:00.000Z",
        "2099-08-29T12:00:00.000Z",
      ),
    ]);
    const accessHeaders = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
    };
    const staleIssue = await api(
      "/api/inventory/legacy/artifacts/legacy-adoption-one/adoption-code",
      { method: "POST", headers: accessHeaders },
      accessEnv(material),
    );
    const staleCode = legacyAdoptionIssueResponseSchema.parse(
      await staleIssue.json(),
    ).code;
    await env.DB.prepare(
      "UPDATE artifacts SET current_revision_id = ? WHERE id = ?",
    )
      .bind("legacy-adoption-revision-1", "legacy-adoption-one")
      .run();
    const staleRedeem = await api(
      "/api/adopt/legacy/legacy-adoption-one",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          code: staleCode,
          localProjectId: "stale-project",
          localArtifactId: "stale-artifact",
          slug: "stale-artifact",
        }),
      },
      accessEnv(material),
    );
    expect(staleRedeem.status).toBe(403);
    await env.DB.prepare(
      "UPDATE artifacts SET current_revision_id = ? WHERE id = ?",
    )
      .bind("legacy-adoption-revision-2", "legacy-adoption-one")
      .run();
    const issue = await api(
      "/api/inventory/legacy/artifacts/legacy-adoption-one/adoption-code",
      { method: "POST", headers: accessHeaders },
      accessEnv(material),
    );
    expect(issue.status).toBe(200);
    const issued = legacyAdoptionIssueResponseSchema.parse(await issue.json());
    expect(issued.source).toEqual({
      title: "Adopt me",
      type: "html",
      revisionVersion: 2,
    });
    expect(issued.code).toMatch(/^panes-adopt-legacy-[a-f0-9]{32}$/u);

    const redeem = await api(
      "/api/adopt/legacy/legacy-adoption-one",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          code: issued.code,
          localProjectId: "local-project-adopted",
          localArtifactId: "local-artifact-adopted",
          slug: "adopted-artifact",
        }),
      },
      accessEnv(material),
    );
    expect(redeem.status).toBe(200);
    const adoptedBody = await redeem.text();
    const adopted = legacyAdoptionRedeemResponseSchema.parse(
      JSON.parse(adoptedBody),
    );
    expect(adopted.source).toBe(source);
    expect(adopted.provenance.legacyRevisionId).toBe(
      "legacy-adoption-revision-2",
    );
    const grantBeforeRetry = await env.DB.prepare(
      "SELECT consumed_at, expires_at, local_project_id, local_artifact_id, local_slug FROM legacy_adoption_grants WHERE id = ?",
    )
      .bind(adopted.provenance.grantId)
      .first();
    const retry = await api(
      "/api/adopt/legacy/legacy-adoption-one",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          code: issued.code,
          localProjectId: "local-project-adopted",
          localArtifactId: "local-artifact-adopted",
          slug: "adopted-artifact",
        }),
      },
      accessEnv(material),
    );
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(adoptedBody);
    expect(
      await env.DB.prepare(
        "SELECT consumed_at, expires_at, local_project_id, local_artifact_id, local_slug FROM legacy_adoption_grants WHERE id = ?",
      )
        .bind(adopted.provenance.grantId)
        .first(),
    ).toEqual(grantBeforeRetry);

    const syncEnv = {
      ...accessEnv(material),
      PANES_CREATE_API_KEY: "sync-key",
    };
    const syncBody = {
      projectId: "local-project-adopted",
      artifactId: "local-artifact-adopted",
      slug: "adopted-artifact",
      title: "Adopt me",
      kind: "html",
      idempotencyKey: "adoption-sync-1",
      ownerCredential: "owner-adopted",
      creatorToken: "creator-adopted",
      legacyProvenance: adopted.provenance,
    };
    const provenanceMismatchCases = [
      {
        label: "project",
        body: {
          ...syncBody,
          projectId: "forged-project",
        },
      },
      {
        label: "artifact",
        body: {
          ...syncBody,
          artifactId: "forged-artifact",
        },
      },
      {
        label: "slug",
        body: {
          ...syncBody,
          slug: "forged-slug",
        },
      },
      {
        label: "revision",
        body: {
          ...syncBody,
          legacyProvenance: {
            ...adopted.provenance,
            legacyRevisionVersion: adopted.provenance.legacyRevisionVersion + 1,
          },
        },
      },
      {
        label: "revision-id",
        body: {
          ...syncBody,
          legacyProvenance: {
            ...adopted.provenance,
            legacyRevisionId: "forged-revision",
          },
        },
      },
      {
        label: "source-artifact",
        body: {
          ...syncBody,
          legacyProvenance: {
            ...adopted.provenance,
            legacyArtifactId: "forged-source-artifact",
          },
        },
      },
      {
        label: "title",
        body: {
          ...syncBody,
          legacyProvenance: {
            ...adopted.provenance,
            legacyTitle: "Forged title",
          },
        },
      },
      {
        label: "type",
        body: {
          ...syncBody,
          legacyProvenance: {
            ...adopted.provenance,
            legacyType: "svg" as const,
          },
        },
      },
      {
        label: "grant",
        body: {
          ...syncBody,
          legacyProvenance: {
            ...adopted.provenance,
            grantId: "missing-adoption-grant",
          },
        },
      },
    ];
    for (const mismatch of provenanceMismatchCases) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/api/sync/artifacts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Panes-Create-Key": "sync-key",
          },
          body: JSON.stringify({
            ...mismatch.body,
            idempotencyKey: `adoption-sync-mismatch-${mismatch.label}`,
          }),
        }),
        syncEnv,
      );
      expect(response.status, mismatch.label).toBe(409);
    }
    const forgedSync = await worker.fetch(
      new Request(`${ORIGIN}/api/sync/artifacts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Panes-Create-Key": "sync-key",
        },
        body: JSON.stringify({
          ...syncBody,
          idempotencyKey: "adoption-sync-forged",
          legacyProvenance: {
            ...adopted.provenance,
            localSlug: "forged-slug",
          },
        }),
      }),
      syncEnv,
    );
    expect(forgedSync.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM sync_artifacts WHERE local_artifact_id = ?",
      )
        .bind("local-artifact-adopted")
        .first(),
    ).toBeNull();
    const syncRequest = () =>
      worker.fetch(
        new Request(`${ORIGIN}/api/sync/artifacts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Panes-Create-Key": "sync-key",
          },
          body: JSON.stringify(syncBody),
        }),
        syncEnv,
      );
    const synced = await syncRequest();
    expect(synced.status).toBe(201);
    const syncedBody = (await synced.json()) as {
      cloudArtifactId: string;
    };
    expect(syncedBody.cloudArtifactId).not.toBe("legacy-adoption-one");
    const retriedSync = await syncRequest();
    expect(retriedSync.status).toBe(200);
    expect(
      ((await retriedSync.json()) as { cloudArtifactId: string })
        .cloudArtifactId,
    ).toBe(syncedBody.cloudArtifactId);

    const inventory = inventoryResponseSchema.parse(
      await (
        await api("/api/inventory", { headers: accessHeaders }, syncEnv)
      ).json(),
    );
    const cloud = inventory.projects
      .flatMap((project) => project.artifacts)
      .find((candidate) => candidate.artifactId === syncedBody.cloudArtifactId);
    expect(cloud?.legacyProvenance).toEqual(adopted.provenance);
    const creator = creatorWorkspaceResponseSchema.parse(
      await (
        await worker.fetch(
          new Request(`${ORIGIN}/api/creator/creator-adopted`),
          syncEnv,
        )
      ).json(),
    );
    expect(creator.legacyProvenance).toEqual(adopted.provenance);
    expect(
      await env.DB.prepare("SELECT 1 FROM legacy_adoption_grants WHERE id = ?")
        .bind(adopted.provenance.grantId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT current_revision_id FROM artifacts WHERE id = ?",
      )
        .bind("legacy-adoption-one")
        .first(),
    ).toEqual({ current_revision_id: "legacy-adoption-revision-2" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?",
      )
        .bind("legacy-adoption-one")
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare("SELECT 1 FROM legacy_shares WHERE artifact_id = ?")
        .bind("legacy-adoption-one")
        .first(),
    ).not.toBeNull();

    const reused = await api(
      "/api/adopt/legacy/legacy-adoption-one",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          code: issued.code,
          localProjectId: "other-project",
          localArtifactId: "other-artifact",
          slug: "other-artifact",
        }),
      },
      accessEnv(material),
    );
    expect(reused.status).toBe(403);

    const changedSlug = await api(
      "/api/adopt/legacy/legacy-adoption-one",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          code: issued.code,
          localProjectId: "local-project-adopted",
          localArtifactId: "local-artifact-adopted",
          slug: "changed-artifact",
        }),
      },
      accessEnv(material),
    );
    expect(changedSlug.status).toBe(403);
    expect(await changedSlug.text()).toContain("Adoption request is invalid");
  });

  it("rejects expired or revoked consumed grants and converges exact concurrent redemption", async () => {
    const expired = await seedAdoptionGrant("consumed-expired", {
      consumed: true,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const expiredResponse = await api(
      `/api/adopt/legacy/${expired.artifactId}`,
      redeemRequest(expired.code, expired.binding),
    );
    expect(expiredResponse.status).toBe(403);
    const lifecycleMaterial = await accessMaterial("adoption-lifecycle");
    stubJwks(lifecycleMaterial);
    const expiredSync = await worker.fetch(
      new Request(`${ORIGIN}/api/sync/artifacts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Panes-Create-Key": "sync-key",
        },
        body: JSON.stringify({
          projectId: expired.binding.localProjectId,
          artifactId: expired.binding.localArtifactId,
          slug: expired.binding.slug,
          title: "Adoption fixture",
          kind: "html",
          idempotencyKey: "expired-adoption-sync",
          ownerCredential: "expired-owner",
          creatorToken: "expired-creator",
          legacyProvenance: {
            grantId: expired.grantId,
            localProjectId: expired.binding.localProjectId,
            localArtifactId: expired.binding.localArtifactId,
            localSlug: expired.binding.slug,
            legacyArtifactId: expired.artifactId,
            legacyRevisionId: `${expired.artifactId}-revision`,
            legacyRevisionVersion: 1,
            legacyTitle: "Adoption fixture",
            legacyType: "html",
          },
        }),
      }),
      {
        ...accessEnv(lifecycleMaterial),
        PANES_CREATE_API_KEY: "sync-key",
      },
    );
    expect(expiredSync.status).toBe(409);

    const cleanupIssue = await api(
      `/api/inventory/legacy/artifacts/${expired.artifactId}/adoption-code`,
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(lifecycleMaterial, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
      },
      accessEnv(lifecycleMaterial),
    );
    expect(cleanupIssue.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT 1 FROM legacy_adoption_grants WHERE id = ?")
        .bind(expired.grantId)
        .first(),
    ).toBeNull();

    const revoked = await seedAdoptionGrant("consumed-revoked", {
      consumed: true,
      revokedAt: "2026-08-29T12:01:00.000Z",
    });
    const revokedResponse = await api(
      `/api/adopt/legacy/${revoked.artifactId}`,
      redeemRequest(revoked.code, revoked.binding),
    );
    expect(revokedResponse.status).toBe(403);

    const concurrent = await seedAdoptionGrant("concurrent", {});
    const [first, second] = await Promise.all([
      api(
        `/api/adopt/legacy/${concurrent.artifactId}`,
        redeemRequest(concurrent.code, concurrent.binding),
      ),
      api(
        `/api/adopt/legacy/${concurrent.artifactId}`,
        redeemRequest(concurrent.code, concurrent.binding),
      ),
    ]);
    const firstBody = await first.text();
    const secondBody = await second.text();
    expect(first.status, firstBody).toBe(200);
    expect(second.status, secondBody).toBe(200);
    expect(firstBody).toBe(secondBody);
    expect(
      await env.DB.prepare(
        "SELECT consumed_at, expires_at, local_project_id, local_artifact_id, local_slug FROM legacy_adoption_grants WHERE id = ?",
      )
        .bind(concurrent.grantId)
        .first(),
    ).toMatchObject({
      expires_at: concurrent.expiresAt,
      local_project_id: concurrent.binding.localProjectId,
      local_artifact_id: concurrent.binding.localArtifactId,
      local_slug: concurrent.binding.slug,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM legacy_adoption_grants WHERE legacy_artifact_id = ?",
      )
        .bind(concurrent.artifactId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE artifact_id = ?",
      )
        .bind(concurrent.artifactId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("issues one-time hashed reconnect codes with a bounded TTL and replaces only the Owner credential", async () => {
    const material = await accessMaterial("reconnect");
    stubJwks(material);
    await seedInventory();
    await seedReconnectManifests();
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const confirmation = reconnectCodeConfirmation(
      "cloud-artifact-one",
      "Inventory one",
    );
    const issue = () =>
      api(
        "/api/inventory/artifacts/cloud-artifact-one/reconnect-code",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ confirmation }),
        },
        accessEnv(material),
      );
    const first = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    expect(first.reconnectCode).toMatch(/^panes-reconnect-[a-f0-9]{32}$/u);
    expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(
      9 * 60_000,
    );
    expect(Date.parse(first.expiresAt) - Date.now()).toBeLessThanOrEqual(
      10 * 60_000,
    );
    const storedFirst = await env.DB.prepare(
      "SELECT code_hash, expires_at, consumed_at, revoked_at FROM owner_reconnect_codes WHERE artifact_id = ? ORDER BY created_at ASC LIMIT 1",
    )
      .bind("cloud-artifact-one")
      .first<{
        code_hash: string;
        expires_at: string;
        consumed_at: string | null;
        revoked_at: string | null;
      }>();
    expect(storedFirst).toMatchObject({
      code_hash: await sha256Text(first.reconnectCode),
      expires_at: first.expiresAt,
      consumed_at: null,
      revoked_at: null,
    });
    expect(JSON.stringify(storedFirst)).not.toContain(first.reconnectCode);

    const second = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    expect(second.reconnectCode).not.toBe(first.reconnectCode);
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM owner_reconnect_codes WHERE code_hash = ?",
      )
        .bind(await sha256Text(first.reconnectCode))
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: expect.any(String) });

    await env.DB.prepare(
      "UPDATE owner_reconnect_codes SET expires_at = ? WHERE code_hash = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", await sha256Text(second.reconnectCode))
      .run();
    const expired = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: second.reconnectCode,
          newOwnerCredential: "expired-owner",
        }),
      },
      accessEnv(material),
    );
    expect(expired.status).toBe(403);
    const third = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    const wrongArtifact = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-two",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "wrong-artifact-owner",
        }),
      },
      accessEnv(material),
    );
    expect(wrongArtifact.status).toBe(403);

    const manifestObject = await env.PRIVATE_ARTIFACTS.get(
      RECONNECT_MANIFEST_V2_KEY,
    );
    if (!manifestObject) throw new Error("reconnect manifest fixture missing");
    const originalManifest = await manifestObject.text();
    const corruptManifest = JSON.parse(originalManifest) as {
      revisions: Array<{ files: Array<{ sha256?: string }> }>;
    };
    const secondManifest = corruptManifest.revisions[1];
    const firstFile = secondManifest?.files[0];
    if (!firstFile) throw new Error("reconnect revision fixture missing");
    firstFile.sha256 = "0".repeat(64);
    await env.PRIVATE_ARTIFACTS.put(
      RECONNECT_MANIFEST_V2_KEY,
      JSON.stringify(corruptManifest),
    );
    const corruptR2 = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "corrupt-r2-owner",
        }),
      },
      accessEnv(material),
    );
    expect(corruptR2.status).toBe(409);
    await env.PRIVATE_ARTIFACTS.put(
      RECONNECT_MANIFEST_V2_KEY,
      originalManifest,
    );

    const v1ManifestObject = await env.PRIVATE_ARTIFACTS.get(
      RECONNECT_MANIFEST_V1_KEY,
    );
    if (!v1ManifestObject)
      throw new Error("reconnect v1 manifest fixture missing");
    const originalV1Manifest = await v1ManifestObject.text();
    const futureV1Manifest = JSON.parse(originalV1Manifest) as {
      revisions: unknown[];
    };
    const v2Manifest = JSON.parse(originalManifest) as {
      revisions: unknown[];
    };
    futureV1Manifest.revisions.push(v2Manifest.revisions[1]);
    await env.PRIVATE_ARTIFACTS.put(
      RECONNECT_MANIFEST_V1_KEY,
      JSON.stringify(futureV1Manifest),
    );
    const futureInV1 = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "future-v1-owner",
        }),
      },
      accessEnv(material),
    );
    expect(futureInV1.status).toBe(409);
    await env.PRIVATE_ARTIFACTS.put(
      RECONNECT_MANIFEST_V1_KEY,
      originalV1Manifest,
    );

    await env.PRIVATE_ARTIFACTS.put(
      privateRevisionObjectKey(
        "cloud-project-one",
        "cloud-artifact-one",
        "revision-one-v2",
        "index.html",
      ),
      "too-large",
      {
        httpMetadata: { contentType: "text/html" },
        customMetadata: { sha256: "e".repeat(64), byteSize: "3" },
      },
    );
    const wrongObjectSize = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "wrong-size-owner",
        }),
      },
      accessEnv(material),
    );
    expect(wrongObjectSize.status).toBe(409);
    await env.PRIVATE_ARTIFACTS.put(
      privateRevisionObjectKey(
        "cloud-project-one",
        "cloud-artifact-one",
        "revision-one-v2",
        "index.html",
      ),
      "two",
      {
        httpMetadata: { contentType: "text/html" },
        customMetadata: { sha256: "e".repeat(64), byteSize: "3" },
      },
    );

    await env.DB.prepare(
      "UPDATE revision_files SET sha256 = ? WHERE revision_id = ? AND path = ?",
    )
      .bind("0".repeat(64), "revision-one-v2", "index.html")
      .run();
    const corrupt = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "corrupt-owner",
        }),
      },
      accessEnv(material),
    );
    expect(corrupt.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT owner_token_hash FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ owner_token_hash: string }>(),
    ).toMatchObject({ owner_token_hash: "a".repeat(64) });
    expect(
      await env.DB.prepare(
        "SELECT consumed_at FROM owner_reconnect_codes WHERE code_hash = ?",
      )
        .bind(await sha256Text(third.reconnectCode))
        .first<{ consumed_at: string | null }>(),
    ).toMatchObject({ consumed_at: null });
    await env.DB.prepare(
      "UPDATE revision_files SET sha256 = ? WHERE revision_id = ? AND path = ?",
    )
      .bind("e".repeat(64), "revision-one-v2", "index.html")
      .run();

    const before = await env.DB.prepare(
      "SELECT owner_token_hash, creator_token_hash FROM sync_artifacts WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .first<{ owner_token_hash: string; creator_token_hash: string }>();
    const redeemed = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "replacement-owner-credential",
        }),
      },
      accessEnv(material),
    );
    expect(redeemed.status).toBe(200);
    const response = syncReconnectResponseSchema.parse(await redeemed.json());
    expect(response.creatorLink.status).toBe("active");
    expect(response.syncedRevisionManifests[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "directory", path: "empty-dir" }),
      ]),
    );
    expect(response.publication).toEqual({
      status: "active",
      revisionVersion: 2,
      expiresAt: "2026-09-05T12:00:00.000Z",
    });
    expect(
      response.syncedRevisionManifests.map((revision) => revision.version),
    ).toEqual([1, 2]);
    const after = await env.DB.prepare(
      "SELECT owner_token_hash, creator_token_hash FROM sync_artifacts WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .first<{ owner_token_hash: string; creator_token_hash: string }>();
    expect(after?.owner_token_hash).toBe(
      await sha256Text("replacement-owner-credential"),
    );
    expect(after?.owner_token_hash).not.toBe(before?.owner_token_hash);
    expect(after?.creator_token_hash).toBe(before?.creator_token_hash);
    expect(
      await env.DB.prepare(
        "SELECT consumed_at FROM owner_reconnect_codes WHERE code_hash = ?",
      )
        .bind(await sha256Text(third.reconnectCode))
        .first<{ consumed_at: string | null }>(),
    ).toMatchObject({ consumed_at: expect.any(String) });

    const oldOwner = await api(
      "/api/sync/artifacts/cloud-artifact-one/lease/release",
      {
        method: "POST",
        headers: { Authorization: "Bearer old-owner" },
      },
      accessEnv(material),
    );
    expect(oldOwner.status).toBe(403);
    const newOwner = await api(
      "/api/sync/artifacts/cloud-artifact-one/lease/release",
      {
        method: "POST",
        headers: { Authorization: "Bearer replacement-owner-credential" },
      },
      accessEnv(material),
    );
    expect(newOwner.status).toBe(204);

    const reused = await api(
      "/api/sync/artifacts/cloud-artifact-one/reconnect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiOrigin: ORIGIN,
          localProjectId: "local-project-one",
          localArtifactId: "local-artifact-one",
          cloudProjectId: "cloud-project-one",
          cloudArtifactId: "cloud-artifact-one",
          reconnectCode: third.reconnectCode,
          newOwnerCredential: "another-owner",
        }),
      },
      accessEnv(material),
    );
    expect(reused.status).toBe(403);

    const concurrent = inventoryReconnectCodeResponseSchema.parse(
      await (await issue()).json(),
    );
    const redeemConcurrently = (newOwnerCredential: string) =>
      api(
        "/api/sync/artifacts/cloud-artifact-one/reconnect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiOrigin: ORIGIN,
            localProjectId: "local-project-one",
            localArtifactId: "local-artifact-one",
            cloudProjectId: "cloud-project-one",
            cloudArtifactId: "cloud-artifact-one",
            reconnectCode: concurrent.reconnectCode,
            newOwnerCredential,
          }),
        },
        accessEnv(material),
      );
    const concurrentResults = await Promise.all([
      redeemConcurrently("concurrent-owner-a"),
      redeemConcurrently("concurrent-owner-b"),
    ]);
    expect(
      concurrentResults.filter((result) => result.status === 200),
    ).toHaveLength(1);
    expect(concurrentResults.some((result) => result.status !== 200)).toBe(
      true,
    );
  });

  it("deletes adopted cloud provenance with the confirmed cloud Artifact", async () => {
    await seedInventory();
    await env.DB.prepare(
      `INSERT INTO legacy_adoption_provenance
        (grant_id, cloud_artifact_id, local_project_id, local_artifact_id,
         local_slug, legacy_artifact_id, legacy_revision_id,
         legacy_revision_version, legacy_title, legacy_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "adoption-grant-cloud-delete",
        "cloud-artifact-one",
        "local-project-one",
        "local-artifact-one",
        "inventory-one",
        "legacy-source-one",
        "legacy-source-revision-one",
        1,
        "Legacy source",
        "html",
        "2026-08-29T12:00:00.000Z",
      )
      .run();
    const response = await deleteInventoryArtifact(
      new Request(`${ORIGIN}/api/inventory/artifacts/cloud-artifact-one`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      }),
      accessEnv(await accessMaterial("cloud-delete")),
      "cloud-artifact-one",
    );
    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM legacy_adoption_provenance WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
  });

  it("preserves completed provenance while revoking only unconsumed Legacy grants", async () => {
    const originalId = "legacy-adoption-preserve";
    const originalRevisionId = "legacy-adoption-preserve-revision";
    const now = "2026-08-29T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO artifacts (id, owner_token_hash, workspace_token_hash, opencode_session_id, title, type, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        originalId,
        "a".repeat(64),
        "b".repeat(64),
        "preserve-session",
        "Preserve me",
        "html",
        originalRevisionId,
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO revisions (id, artifact_id, version, source, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(originalRevisionId, originalId, 1, "<h1>preserve</h1>", now),
      env.DB.prepare(
        "INSERT INTO legacy_artifacts (artifact_id, migrated_at, private_expires_at) VALUES (?, ?, ?)",
      ).bind(originalId, now, "2099-08-29T12:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO legacy_adoption_grants
          (id, legacy_artifact_id, legacy_revision_id, legacy_revision_version,
           legacy_title, legacy_type, code_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "adoption-grant-unconsumed",
        originalId,
        originalRevisionId,
        1,
        "Preserve me",
        "html",
        "1".repeat(64),
        now,
        "2099-08-29T12:00:00.000Z",
      ),
      env.DB.prepare(
        `INSERT INTO legacy_adoption_grants
          (id, legacy_artifact_id, legacy_revision_id, legacy_revision_version,
           legacy_title, legacy_type, code_hash, created_at, expires_at,
           consumed_at, local_project_id, local_artifact_id, local_slug)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "adoption-grant-consumed",
        originalId,
        originalRevisionId,
        1,
        "Preserve me",
        "html",
        "2".repeat(64),
        now,
        "2099-08-29T12:00:00.000Z",
        now,
        "local-project-preserve",
        "local-artifact-preserve",
        "preserved-artifact",
      ),
      env.DB.prepare(
        `INSERT INTO legacy_adoption_provenance
          (grant_id, cloud_artifact_id, local_project_id, local_artifact_id,
           local_slug, legacy_artifact_id, legacy_revision_id,
           legacy_revision_version, legacy_title, legacy_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "adoption-grant-consumed",
        "cloud-artifact-preserved",
        "local-project-preserve",
        "local-artifact-preserve",
        "preserved-artifact",
        originalId,
        originalRevisionId,
        1,
        "Preserve me",
        "html",
        now,
      ),
    ]);

    const response = await deleteLegacyInventoryArtifact(
      new Request(`${ORIGIN}/api/inventory/legacy/artifacts/${originalId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Preserve me"),
        }),
      }),
      env,
      originalId,
    );
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT 1 FROM artifacts WHERE id = ?")
        .bind(originalId)
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM legacy_adoption_grants WHERE id = ?",
      )
        .bind("adoption-grant-unconsumed")
        .first<{ revoked_at: string | null }>(),
    ).toEqual({ revoked_at: null });
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM legacy_adoption_grants WHERE id = ?",
      )
        .bind("adoption-grant-consumed")
        .first<{ revoked_at: string | null }>(),
    ).toEqual({ revoked_at: null });

    await env.DB.prepare("DELETE FROM legacy_adoption_grants WHERE id = ?")
      .bind("adoption-grant-consumed")
      .run();
    const afterSync = await deleteLegacyInventoryArtifact(
      new Request(`${ORIGIN}/api/inventory/legacy/artifacts/${originalId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Preserve me"),
        }),
      }),
      env,
      originalId,
    );
    expect(afterSync.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT 1 FROM artifacts WHERE id = ?")
        .bind(originalId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM legacy_adoption_grants WHERE id = ?",
      )
        .bind("adoption-grant-unconsumed")
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: expect.any(String) });
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM legacy_adoption_grants WHERE id = ?",
      )
        .bind("adoption-grant-consumed")
        .first<{ revoked_at: string | null }>(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT local_slug FROM legacy_adoption_provenance WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-preserved")
        .first<{ local_slug: string }>(),
    ).toEqual({ local_slug: "preserved-artifact" });
  });

  it("deletes a Legacy artifact after an expired consumed adoption is cleaned up", async () => {
    const expired = await seedAdoptionGrant("deletion-expired", {
      consumed: true,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const response = await deleteLegacyInventoryArtifact(
      new Request(
        `${ORIGIN}/api/inventory/legacy/artifacts/${expired.artifactId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmation: cloudDeletionConfirmation("Adoption fixture"),
          }),
        },
      ),
      env,
      expired.artifactId,
    );
    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT 1 FROM artifacts WHERE id = ?")
        .bind(expired.artifactId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM legacy_adoption_grants WHERE id = ?")
        .bind(expired.grantId)
        .first(),
    ).toBeNull();
  });

  it("rejects recovery confirmation and deleting Artifacts without disclosing metadata", async () => {
    const material = await accessMaterial("reconnect-boundaries");
    stubJwks(material);
    await seedInventory();
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const incorrect = await api(
      "/api/inventory/artifacts/cloud-artifact-one/reconnect-code",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ confirmation: "RECOVER OWNER CREDENTIAL" }),
      },
      accessEnv(material),
    );
    expect(incorrect.status).toBe(400);
    await env.DB.prepare(
      "UPDATE sync_artifacts SET lifecycle_state = 'deleting' WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .run();
    const deleting = await api(
      "/api/inventory/artifacts/cloud-artifact-one/reconnect-code",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          confirmation: reconnectCodeConfirmation(
            "cloud-artifact-one",
            "Inventory one",
          ),
        }),
      },
      accessEnv(material),
    );
    expect(deleting.status).toBe(409);
    expect(await deleting.text()).not.toContain("Inventory one");
  });

  it("cancels a chunked body as soon as it exceeds the byte limit", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    const text = await readBoundedText(
      new Request(ORIGIN, { body, method: "POST" }),
      10,
    );
    expect(text).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("protects every inventory mutation before looking up an Artifact", async () => {
    const response = await api(
      "/api/inventory/artifacts/missing-artifact/creator/rotate",
      { method: "POST", body: "{}" },
      {
        DB: env.DB,
        PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
        PANES_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
        PANES_ACCESS_AUDIENCE: "inventory-audience",
        PANES_ACCESS_ALLOWED_EMAIL: "simonhimself@gmail.com",
      },
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("missing-artifact");
  });

  it("rejects missing or invalid configuration before querying inventory", async () => {
    const unauthorized = await api("/api/inventory");
    expect(unauthorized.status).toBe(503);
    expect(await unauthorized.text()).not.toContain("project");

    const noHeaderEnv: Env = {
      DB: env.DB,
      PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
      PANES_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
      PANES_ACCESS_AUDIENCE: "inventory-audience",
      PANES_ACCESS_ALLOWED_EMAIL: "simonhimself@gmail.com",
    };
    const missing = await api("/api/inventory", undefined, noHeaderEnv);
    expect(missing.status).toBe(401);
    const missingBody = await missing.text();
    expect(missingBody).not.toContain("email");
    expect(missingBody).not.toContain("inventory");

    const malformed = await api(
      "/api/inventory",
      { headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } },
      noHeaderEnv,
    );
    expect(malformed.status).toBe(401);
  });

  it("returns a generic service-unavailable response when JWKS times out", async () => {
    const material = await accessMaterial("timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new errors.JWKSTimeout())),
    );
    const response = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(material),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("timeout");
  });

  it("accepts a valid signed Access JWT without an nbf claim", async () => {
    const material = await accessMaterial("without-nbf");
    stubJwks(material);
    const response = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
            missingNbf: true,
          }),
        },
      },
      accessEnv(material),
    );
    expect(response.status).toBe(200);
  });

  it("rotates Creator access and applies shared Publication rules", async () => {
    const material = await accessMaterial("mutations");
    stubJwks(material);
    await seedInventory();
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
    };

    const rotated = await api(
      "/api/inventory/artifacts/cloud-artifact-one/creator/rotate",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      },
      accessEnv(material),
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = inventoryCreatorRotateResponseSchema.parse(
      await rotated.json(),
    );
    expect(rotatedBody.creatorUrl).toMatch(
      /^https:\/\/panes\.example\/creator\/[^/]+$/u,
    );
    expect(Date.parse(rotatedBody.creatorExpiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(JSON.stringify(rotatedBody)).not.toContain("creatorToken");

    const extended = await api(
      "/api/inventory/artifacts/cloud-artifact-one/publication/extend",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ durationDays: 1 }),
      },
      accessEnv(material),
    );
    expect(extended.status).toBe(200);
    expect(publicationSchema.parse(await extended.json()).expiresAt).toBe(
      "2026-09-06T12:00:00.000Z",
    );
  });

  it("requires exact cloud deletion confirmation and preserves a resumable tombstone", async () => {
    const material = await accessMaterial("delete");
    stubJwks(material);
    await seedInventory();
    const revisionKey = "private/one/v2/index.html";
    const manifestKey =
      "private/manifests/cloud-project-one/cloud-artifact-one/v2.json";
    await env.DB.prepare(
      "UPDATE local_revisions SET cloud_manifest_key = ? WHERE artifact_id = ? AND version = 2",
    )
      .bind(manifestKey, "cloud-artifact-one")
      .run();
    await env.PRIVATE_ARTIFACTS.put(revisionKey, "revision bytes");
    await env.PRIVATE_ARTIFACTS.put(manifestKey, "manifest bytes");
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const path = "/api/inventory/artifacts/cloud-artifact-one";
    const incorrect = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
      accessEnv(material),
    );
    expect(incorrect.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();

    const padded = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: `${cloudDeletionConfirmation("Inventory one")} `,
        }),
      },
      accessEnv(material),
    );
    expect(padded.status).toBe(400);

    const deleted = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );
    expect(deleted.status).toBe(204);
    expect(await env.PRIVATE_ARTIFACTS.head(revisionKey)).toBeNull();
    expect(await env.PRIVATE_ARTIFACTS.head(manifestKey)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM local_artifacts WHERE id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM revision_files WHERE revision_id LIKE 'revision-one-%'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM sync_uploads WHERE artifact_id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM creator_links WHERE artifact_id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM publications WHERE artifact_id = ?")
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM projects WHERE id = ?")
        .bind("local-project-one")
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM artifact_deletion_objects WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).toBeNull();
    const tombstone = await env.DB.prepare(
      "SELECT * FROM artifact_deletion_tombstones WHERE cloud_artifact_id = ?",
    )
      .bind("cloud-artifact-one")
      .first<Record<string, unknown>>();
    expect(tombstone?.completed_at).toEqual(expect.any(String));
    expect(JSON.stringify(tombstone)).not.toMatch(
      /token|ciphertext|nonce|object_key|file contents/iu,
    );

    const replay = await api(
      path,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );
    expect(replay.status).toBe(204);
  });

  it("retries deletion after an R2 failure without deleting D1 metadata early", async () => {
    const material = await accessMaterial("delete-retry");
    stubJwks(material);
    await seedInventory();
    const failingBucket = {
      delete: async () => {
        throw new Error("injected R2 failure");
      },
    } as unknown as R2Bucket;
    const failingEnv = {
      ...accessEnv(material),
      PRIVATE_ARTIFACTS: failingBucket,
    } as Env;
    const headers = {
      "Cf-Access-Jwt-Assertion": await accessToken(material, {
        email: "simonhimself@gmail.com",
      }),
      "Content-Type": "application/json",
    };
    const request = () =>
      new Request(`${ORIGIN}/api/inventory/artifacts/cloud-artifact-one`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      });
    await expect(
      deleteInventoryArtifact(request(), failingEnv, "cloud-artifact-one"),
    ).rejects.toThrow("injected R2 failure");
    expect(
      await env.DB.prepare(
        "SELECT lifecycle_state FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ lifecycle_state: string }>(),
    ).toMatchObject({
      lifecycle_state: "deleting",
    });
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();

    const retried = await deleteInventoryArtifact(
      request(),
      accessEnv(material),
      "cloud-artifact-one",
    );
    expect(retried.status).toBe(204);
  });

  it("does not revoke capabilities when deletion cannot acquire both leases", async () => {
    const material = await accessMaterial("busy-delete");
    stubJwks(material);
    await seedInventory();
    await env.DB.prepare(
      "UPDATE sync_artifacts SET sync_lease_owner = ?, sync_lease_expires_at = ? WHERE cloud_artifact_id = ?",
    )
      .bind("other-session", "2099-01-01T00:00:00.000Z", "cloud-artifact-one")
      .run();
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one",
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT revoked_at FROM creator_links WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: null });
    expect(
      await env.DB.prepare(
        "SELECT status, token_ciphertext FROM publications WHERE artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ status: string; token_ciphertext: string | null }>(),
    ).toMatchObject({
      status: "active",
      token_ciphertext: expect.any(String),
    });
  });

  it("rejects an oversized chunked deletion body before buffering it fully", async () => {
    const material = await accessMaterial("oversized-delete");
    stubJwks(material);
    await seedInventory();
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"confirmation":"'));
        controller.enqueue(new Uint8Array(5000).fill(65));
        controller.close();
      },
    });
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one",
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body: chunks,
      },
      accessEnv(material),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT lifecycle_state FROM sync_artifacts WHERE cloud_artifact_id = ?",
      )
        .bind("cloud-artifact-one")
        .first<{ lifecycle_state: string }>(),
    ).toMatchObject({ lifecycle_state: "active" });
  });

  it("rejects an oversized chunked inventory mutation body", async () => {
    const material = await accessMaterial("oversized-mutation");
    stubJwks(material);
    await seedInventory();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"durationDays":7,'));
        controller.enqueue(new Uint8Array(5000).fill(65));
        controller.close();
      },
    });
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one/publication/extend",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body,
      },
      accessEnv(material),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT expires_at FROM publications WHERE id = ?")
        .bind("publication-one")
        .first<{ expires_at: string }>(),
    ).toMatchObject({ expires_at: "2026-09-05T12:00:00.000Z" });
  });

  it("retains an object that remains committed by another Artifact", async () => {
    const material = await accessMaterial("shared-object");
    stubJwks(material);
    await seedInventory();
    const sharedKey = "private/shared/committed/manifest.json";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE local_revisions SET cloud_manifest_key = ? WHERE artifact_id = ?",
      ).bind(sharedKey, "cloud-artifact-two"),
      env.DB.prepare(
        "UPDATE local_revisions SET cloud_manifest_key = ? WHERE artifact_id = ?",
      ).bind(sharedKey, "cloud-artifact-one"),
    ]);
    await env.PRIVATE_ARTIFACTS.put(sharedKey, "shared manifest");
    const response = await api(
      "/api/inventory/artifacts/cloud-artifact-one",
      {
        method: "DELETE",
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirmation: cloudDeletionConfirmation("Inventory one"),
        }),
      },
      accessEnv(material),
    );

    expect(response.status).toBe(204);
    expect(await env.PRIVATE_ARTIFACTS.head(sharedKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ? AND cloud_manifest_key = ?",
      )
        .bind("cloud-artifact-two", sharedKey)
        .first(),
    ).not.toBeNull();
  });

  it("accepts only a valid signed Access JWT and groups committed Artifacts", async () => {
    const material = await accessMaterial("one");
    const fetchJwks = stubJwks(material);
    await seedInventory();
    const token = await accessToken(material, {
      email: "SIMONHIMSELF@GMAIL.COM",
    });
    const response = await api(
      "/api/inventory",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      accessEnv(material),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const inventory = inventoryResponseSchema.parse(await response.json());
    expect(inventory.projects).toHaveLength(1);
    expect(inventory.projects[0]).toMatchObject({
      projectId: "cloud-project-one",
      artifacts: [
        {
          artifactId: "cloud-artifact-one",
          title: "Inventory one",
          lifecycleState: "active",
          revisionCount: 2,
          storageBytes: 9,
          lastSyncedAt: "2026-08-29T12:02:00.000Z",
          creatorLink: {
            status: "active",
            expiresAt: "2026-09-28T12:00:00.000Z",
          },
          publication: {
            status: "active",
            revisionVersion: 2,
            expiresAt: "2026-09-05T12:00:00.000Z",
            publicUrl: "https://panes.example/published/public-token-one",
          },
          warnings: [],
        },
        {
          artifactId: "cloud-artifact-two",
          title: "Inventory two",
          lifecycleState: "active",
          revisionCount: 1,
          storageBytes: 3,
          publication: {
            status: "expired",
            revisionVersion: 1,
            expiresAt: "2020-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    expect(JSON.stringify(inventory)).not.toContain("token_hash");
    expect(JSON.stringify(inventory)).not.toContain("ciphertext");
    expect(JSON.stringify(inventory)).not.toContain("object_key");
    expect(fetchJwks).toHaveBeenCalledOnce();
  });

  it("isolates a damaged active publication and refreshes rotated JWKS keys", async () => {
    const first = await accessMaterial("first");
    const second = await accessMaterial("second");
    let current = first;
    const fetchJwks = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [current.jwk] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchJwks);
    await seedInventory({ damagedSecondPublication: true });

    const firstResponse = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(first, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(first),
    );
    expect(firstResponse.status).toBe(200);
    const firstInventory = inventoryResponseSchema.parse(
      await firstResponse.json(),
    );
    expect(firstInventory.projects[0]?.artifacts[1]?.warnings).toEqual([
      "The active public URL could not be recovered.",
    ]);
    expect(
      firstInventory.projects[0]?.artifacts[0]?.publication.publicUrl,
    ).toBe("https://panes.example/published/public-token-one");

    current = second;
    const rotated = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(second, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(second),
    );
    expect(rotated.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("reports expired and revoked lifecycle state without exposing history internals", async () => {
    const material = await accessMaterial("lifecycle");
    stubJwks(material);
    await seedInventory();
    const retainedObjectKey = "private/one/v2/index.html";
    await env.PRIVATE_ARTIFACTS.put(retainedObjectKey, "canonical cloud bytes");
    await env.DB.prepare(
      "UPDATE creator_links SET expires_at = ?, revoked_at = NULL WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "cloud-artifact-one")
      .run();
    await env.DB.prepare(
      "UPDATE publications SET expires_at = ?, status = 'active', revoked_at = NULL WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", "cloud-artifact-one")
      .run();
    const expiredResponse = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(material),
    );
    const expiredInventory = inventoryResponseSchema.parse(
      await expiredResponse.json(),
    );
    expect(expiredInventory.projects[0]?.artifacts[0]).toMatchObject({
      creatorLink: { status: "expired" },
      publication: { status: "expired" },
    });
    expect(await env.PRIVATE_ARTIFACTS.head(retainedObjectKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ? AND committed_at IS NOT NULL",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE creator_links SET revoked_at = ? WHERE artifact_id = ?",
      ).bind("2026-08-29T12:03:00.000Z", "cloud-artifact-one"),
      env.DB.prepare(
        "UPDATE publications SET status = 'revoked', revoked_at = ?, token_ciphertext = NULL, token_nonce = NULL, encryption_key_version = NULL WHERE artifact_id = ?",
      ).bind("2026-08-29T12:03:00.000Z", "cloud-artifact-one"),
    ]);
    const response = await api(
      "/api/inventory",
      {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(material, {
            email: "simonhimself@gmail.com",
          }),
        },
      },
      accessEnv(material),
    );
    const inventory = inventoryResponseSchema.parse(await response.json());
    expect(inventory.projects[0]?.artifacts[0]).toMatchObject({
      creatorLink: { status: "revoked" },
      publication: {
        status: "revoked",
        revisionVersion: 2,
      },
    });
    expect(inventory.projects[0]?.artifacts[0]?.publication).not.toHaveProperty(
      "publicUrl",
    );
    expect(await env.PRIVATE_ARTIFACTS.head(retainedObjectKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM local_revisions WHERE artifact_id = ? AND committed_at IS NOT NULL",
      )
        .bind("cloud-artifact-one")
        .first(),
    ).not.toBeNull();
  });

  it.each([
    ["wrong signature", { email: "simonhimself@gmail.com" }],
    ["wrong issuer", { email: "simonhimself@gmail.com", issuer: true }],
    ["wrong audience", { email: "simonhimself@gmail.com", audience: true }],
    ["wrong email", { email: "other@example.com" }],
    ["expired", { email: "simonhimself@gmail.com", expired: true }],
    ["not yet valid", { email: "simonhimself@gmail.com", notYetValid: true }],
  ] as const)("fails closed for %s", async (name, options) => {
    const material = await accessMaterial(`invalid-${name}`);
    const other = await accessMaterial(`other-${name}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [material.jwk] }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const token = await accessToken(
      name === "wrong signature" ? other : material,
      options,
    );
    const response = await api(
      "/api/inventory",
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      accessEnv(material),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(name);
  });

  it("returns Legacy artifacts in a separate minimal inventory group", async () => {
    const now = "2026-08-29T12:00:00.000Z";
    const artifactId = "inventory-legacy-artifact";
    const revisionId = "inventory-legacy-revision";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO artifacts
          (id, owner_token_hash, workspace_token_hash, opencode_session_id,
           title, type, current_revision_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        artifactId,
        "a".repeat(64),
        "b".repeat(64),
        "inventory-legacy-session",
        "Inventory Legacy",
        "html",
        revisionId,
        now,
        "2026-08-30T12:00:00.000Z",
      ),
      env.DB.prepare(
        "INSERT INTO revisions (id, artifact_id, version, source, created_at) VALUES (?, ?, 1, ?, ?)",
      ).bind(revisionId, artifactId, "<h1>héllo</h1>", now),
      env.DB.prepare(
        "INSERT INTO legacy_artifacts (artifact_id, migrated_at, private_expires_at) VALUES (?, ?, ?)",
      ).bind(artifactId, now, "2026-09-28T12:00:00.000Z"),
    ]);

    const inventory = await loadInventory(
      new Request(`${ORIGIN}/api/inventory`),
      env,
    );
    expect(inventory.projects).toEqual([]);
    expect(inventory.legacyArtifacts).toEqual([
      {
        artifactId,
        title: "Inventory Legacy",
        type: "html",
        revisionCount: 1,
        storageBytes: new TextEncoder().encode("<h1>héllo</h1>").byteLength,
        createdAt: now,
        updatedAt: "2026-08-30T12:00:00.000Z",
        privateExpiresAt: "2026-09-28T12:00:00.000Z",
        status: "active",
        publicationStatus: "none",
        publicationExpiresAt: null,
      },
    ]);
  });
});

async function accessMaterial(label: string): Promise<AccessMaterial> {
  const safeLabel = label.replace(/[^a-z0-9-]/giu, "-");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = `inventory-${safeLabel}`;
  jwk.use = "sig";
  return {
    privateKey,
    jwk,
    issuer: `https://team-${safeLabel}.cloudflareaccess.com`,
    audience: `inventory-audience-${safeLabel}`,
  };
}

async function accessToken(
  material: AccessMaterial,
  options: {
    email: string;
    issuer?: boolean;
    audience?: boolean;
    expired?: boolean;
    notYetValid?: boolean;
    missingNbf?: boolean;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const token = new SignJWT({ email: options.email })
    .setProtectedHeader({ alg: "RS256", kid: String(material.jwk.kid) })
    .setIssuer(
      options.issuer ? "https://wrong.cloudflareaccess.com" : material.issuer,
    )
    .setAudience(options.audience ? "wrong-audience" : material.audience)
    .setIssuedAt(now);
  if (!options.missingNbf)
    token.setNotBefore(options.notYetValid ? now + 300 : now - 5);
  return token
    .setExpirationTime(options.expired ? now - 1 : now + 300)
    .sign(material.privateKey);
}

function stubJwks(material: AccessMaterial) {
  const fetchJwks = vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [material.jwk] }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchJwks);
  return fetchJwks;
}

function accessEnv(material: { issuer: string; audience: string }): Env {
  return {
    DB: env.DB,
    PRIVATE_ARTIFACTS: env.PRIVATE_ARTIFACTS,
    PUBLICATION_ENCRYPTION_KEY_V1: KEY_MATERIAL,
    PANES_ACCESS_ISSUER: material.issuer,
    PANES_ACCESS_AUDIENCE: material.audience,
    PANES_ACCESS_ALLOWED_EMAIL: "simonhimself@gmail.com",
  };
}

async function seedInventory(
  options: { damagedSecondPublication?: boolean } = {},
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(
      "local-project-one",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_artifacts (id, project_id, slug, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-one",
      "local-project-one",
      "inventory-one",
      "Inventory one",
      "prototype",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO sync_artifacts (cloud_artifact_id, cloud_project_id, local_project_id, local_artifact_id, slug, title, kind, owner_token_hash, creation_idempotency_key, creator_token_hash, creator_created_at, creator_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-one",
      "cloud-project-one",
      "local-project-one",
      "local-artifact-one",
      "inventory-one",
      "Inventory one",
      "prototype",
      "a".repeat(64),
      "inventory-create-one",
      "b".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO creator_links (id, artifact_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "creator-link-one",
      "cloud-artifact-one",
      "c".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_revisions (id, artifact_id, version, preview_entry, approved_origins, created_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-one-v1",
      "cloud-artifact-one",
      1,
      '{"adapter":"browser","entryPath":"index.html"}',
      "[]",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:01:00.000Z",
      "revision-one-v2",
      "cloud-artifact-one",
      2,
      '{"adapter":"browser","entryPath":"index.html"}',
      "[]",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:02:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO revision_files (revision_id, path, sha256, byte_size, media_type, object_key) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-one-v1",
      "index.html",
      "d".repeat(64),
      2,
      "text/html",
      "private/one/v1/index.html",
      "revision-one-v2",
      "index.html",
      "e".repeat(64),
      3,
      "text/html",
      "private/one/v2/index.html",
      "revision-one-v2",
      "assets/app.js",
      "f".repeat(64),
      4,
      "text/javascript",
      "private/one/v2/assets/app.js",
    ),
    env.DB.prepare(
      "INSERT INTO publications (id, artifact_id, revision_version, duration_days, token_hash, token_ciphertext, token_nonce, encryption_key_version, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "publication-one",
      "cloud-artifact-one",
      2,
      7,
      "1".repeat(64),
      await encryptedToken(
        "public-token-one",
        "cloud-artifact-one",
        "publication-one",
      ),
      "00112233445566778899aabb",
      1,
      "active",
      "2026-08-29T12:00:00.000Z",
      "2026-09-05T12:00:00.000Z",
    ),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, created_at, updated_at) VALUES (?, ?, ?)",
    ).bind(
      "local-project-two",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_artifacts (id, project_id, slug, title, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-two",
      "local-project-two",
      "inventory-two",
      "Inventory two",
      null,
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO sync_artifacts (cloud_artifact_id, cloud_project_id, local_project_id, local_artifact_id, slug, title, kind, owner_token_hash, creation_idempotency_key, creator_token_hash, creator_created_at, creator_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "cloud-artifact-two",
      "cloud-project-one",
      "local-project-two",
      "local-artifact-two",
      "inventory-two",
      "Inventory two",
      null,
      "a".repeat(64),
      "inventory-create-two",
      "b".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO creator_links (id, artifact_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "creator-link-two",
      "cloud-artifact-two",
      "c".repeat(64),
      "2026-08-29T12:00:00.000Z",
      "2026-09-28T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO local_revisions (id, artifact_id, version, preview_entry, approved_origins, created_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-two-v1",
      "cloud-artifact-two",
      1,
      '{"adapter":"browser","entryPath":"index.html"}',
      "[]",
      "2026-08-29T12:00:00.000Z",
      "2026-08-29T12:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO revision_files (revision_id, path, sha256, byte_size, media_type, object_key) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      "revision-two-v1",
      "index.html",
      "a".repeat(64),
      3,
      "text/html",
      "private/two/v1/index.html",
    ),
    env.DB.prepare(
      "INSERT INTO publications (id, artifact_id, revision_version, duration_days, token_hash, token_ciphertext, token_nonce, encryption_key_version, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "publication-two",
      "cloud-artifact-two",
      1,
      7,
      "2".repeat(64),
      options.damagedSecondPublication ? "tampered" : null,
      "00112233445566778899aabb",
      1,
      options.damagedSecondPublication ? "active" : "expired",
      "2026-08-29T12:00:00.000Z",
      options.damagedSecondPublication
        ? "2026-09-05T12:00:00.000Z"
        : "2020-01-01T00:00:00.000Z",
    ),
  ]);
}

async function encryptedToken(
  token: string,
  artifactId: string,
  publicationId: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexBytes(KEY_MATERIAL).buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = hexBytes("00112233445566778899aabb");
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce.buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(
        `opencode-panes/publication/${artifactId}/${publicationId}/key-v1`,
      ).buffer as ArrayBuffer,
    },
    key,
    new TextEncoder().encode(token).buffer as ArrayBuffer,
  );
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
}

async function seedReconnectManifests() {
  const manifests = [
    {
      key: RECONNECT_MANIFEST_V1_KEY,
      revision: {
        id: "revision-one-v1",
        version: 1,
        preview: { adapter: "browser", entryPath: "index.html" },
        approvedOrigins: [],
        files: [
          {
            kind: "directory",
            path: "empty-dir",
            byteSize: 0,
          },
          {
            kind: "file",
            path: "index.html",
            sha256: "d".repeat(64),
            byteSize: 2,
            mediaType: "text/html",
          },
        ],
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    },
    {
      key: RECONNECT_MANIFEST_V2_KEY,
      revision: {
        id: "revision-one-v2",
        version: 2,
        preview: { adapter: "browser", entryPath: "index.html" },
        approvedOrigins: [],
        files: [
          {
            kind: "file",
            path: "index.html",
            sha256: "e".repeat(64),
            byteSize: 3,
            mediaType: "text/html",
          },
          {
            kind: "file",
            path: "assets/app.js",
            sha256: "f".repeat(64),
            byteSize: 4,
            mediaType: "text/javascript",
          },
        ],
        createdAt: "2026-08-29T12:00:00.000Z",
      },
    },
  ];
  const manifestV1 = manifests[0];
  const manifestV2 = manifests[1];
  if (!manifestV1 || !manifestV2)
    throw new Error("reconnect fixtures incomplete");
  const fileV1 = privateRevisionObjectKey(
    "cloud-project-one",
    "cloud-artifact-one",
    "revision-one-v1",
    "index.html",
  );
  const fileV2 = privateRevisionObjectKey(
    "cloud-project-one",
    "cloud-artifact-one",
    "revision-one-v2",
    "index.html",
  );
  const appV2 = privateRevisionObjectKey(
    "cloud-project-one",
    "cloud-artifact-one",
    "revision-one-v2",
    "assets/app.js",
  );
  const manifestV2Revisions = [manifestV1.revision, manifestV2.revision];
  for (const { key, revision } of manifests) {
    await env.PRIVATE_ARTIFACTS.put(
      key,
      JSON.stringify({
        schemaVersion: 1,
        projectId: "cloud-project-one",
        artifactId: "cloud-artifact-one",
        slug: "inventory-one",
        title: "Inventory one",
        kind: "prototype",
        revisions: revision.version === 2 ? manifestV2Revisions : [revision],
      }),
    );
  }
  await env.PRIVATE_ARTIFACTS.put(fileV1, "ok", {
    httpMetadata: { contentType: "text/html" },
    customMetadata: { sha256: "d".repeat(64), byteSize: "2" },
  });
  await env.PRIVATE_ARTIFACTS.put(fileV2, "two", {
    httpMetadata: { contentType: "text/html" },
    customMetadata: { sha256: "e".repeat(64), byteSize: "3" },
  });
  await env.PRIVATE_ARTIFACTS.put(appV2, "file", {
    httpMetadata: { contentType: "text/javascript" },
    customMetadata: { sha256: "f".repeat(64), byteSize: "4" },
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE local_revisions SET cloud_manifest_key = ? WHERE id = ?",
    ).bind(manifestV1.key, "revision-one-v1"),
    env.DB.prepare(
      "UPDATE local_revisions SET cloud_manifest_key = ? WHERE id = ?",
    ).bind(manifestV2.key, "revision-one-v2"),
    env.DB.prepare(
      "UPDATE revision_files SET object_key = ? WHERE revision_id = ? AND path = ?",
    ).bind(fileV1, "revision-one-v1", "index.html"),
    env.DB.prepare(
      "UPDATE revision_files SET object_key = ? WHERE revision_id = ? AND path = ?",
    ).bind(fileV2, "revision-one-v2", "index.html"),
    env.DB.prepare(
      "UPDATE revision_files SET object_key = ? WHERE revision_id = ? AND path = ?",
    ).bind(appV2, "revision-one-v2", "assets/app.js"),
  ]);
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function seedAdoptionGrant(
  suffix: string,
  options: {
    consumed?: boolean;
    expiresAt?: string;
    revokedAt?: string | null;
  },
) {
  const artifactId = `legacy-adoption-${suffix}`;
  const revisionId = `${artifactId}-revision`;
  const grantId = `adoption-grant-${suffix}`;
  const code = `panes-adopt-legacy-${(await sha256Text(suffix)).slice(0, 32)}`;
  const createdAt = "2026-08-29T12:00:00.000Z";
  const expiresAt = options.expiresAt ?? "2099-08-29T12:00:00.000Z";
  const consumed = options.consumed ?? false;
  const binding = {
    localProjectId: `local-project-${suffix}`,
    localArtifactId: `local-artifact-${suffix}`,
    slug: `local-${suffix}`,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO artifacts (id, owner_token_hash, workspace_token_hash, opencode_session_id, title, type, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      artifactId,
      "a".repeat(64),
      "b".repeat(64),
      `session-${suffix}`,
      "Adoption fixture",
      "html",
      revisionId,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      "INSERT INTO revisions (id, artifact_id, version, source, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(revisionId, artifactId, 1, "<p>fixture</p>", createdAt),
    env.DB.prepare(
      "INSERT INTO legacy_artifacts (artifact_id, migrated_at, private_expires_at) VALUES (?, ?, ?)",
    ).bind(artifactId, createdAt, "2099-08-29T12:00:00.000Z"),
    env.DB.prepare(
      `INSERT INTO legacy_adoption_grants
        (id, legacy_artifact_id, legacy_revision_id, legacy_revision_version,
         legacy_title, legacy_type, code_hash, created_at, expires_at,
         consumed_at, revoked_at, local_project_id, local_artifact_id, local_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      grantId,
      artifactId,
      revisionId,
      1,
      "Adoption fixture",
      "html",
      await sha256Text(code),
      createdAt,
      expiresAt,
      consumed ? createdAt : null,
      options.revokedAt ?? null,
      consumed ? binding.localProjectId : null,
      consumed ? binding.localArtifactId : null,
      consumed ? binding.slug : null,
    ),
  ]);
  return { artifactId, binding, code, expiresAt, grantId };
}

function redeemRequest(
  code: string,
  binding: { localProjectId: string; localArtifactId: string; slug: string },
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiOrigin: ORIGIN, code, ...binding }),
  };
}

async function api(path: string, init?: RequestInit, workerEnv: Env = env) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv);
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
}
