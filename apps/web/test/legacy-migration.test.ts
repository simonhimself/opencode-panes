import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../worker";
import {
  cloudDeletionConfirmation,
  deleteLegacyInventoryArtifact,
} from "../worker/deletion";

const MIGRATED_AT = "2026-08-29T12:00:00.000Z";
const ARTIFACT_IDS = ["ticket18-legacy-one", "ticket18-legacy-two"];
const SHARE_TOKENS = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];

const DROP_TABLES = [
  "legacy_shares",
  "legacy_artifacts",
  "legacy_migration_state",
  "owner_reconnect_codes",
  "artifact_deletion_objects",
  "artifact_deletion_tombstones",
  "publications",
  "creator_links",
  "sync_uploads",
  "revision_files",
  "local_revisions",
  "sync_artifacts",
  "local_artifacts",
  "projects",
  "shares",
  "revisions",
  "artifacts",
  "d1_migrations",
];

beforeAll(async () => {
  await resetToLegacySchema();
});

afterAll(async () => {
  await dropAllTables();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetToLegacySchema();
});

describe("legacy migration classification", () => {
  it("preserves source and share history and keeps one stable expiry anchor on backfill", async () => {
    await seedLegacyRows();

    await applyLegacyMigration();
    const firstState = await env.DB.prepare(
      "SELECT migrated_at FROM legacy_migration_state WHERE id = 1",
    ).first<{ migrated_at: string }>();
    expect(firstState?.migrated_at).toEqual(expect.any(String));

    const firstArtifacts = await env.DB.prepare(
      `SELECT artifact_id, private_expires_at
         FROM legacy_artifacts
        WHERE artifact_id LIKE 'ticket18-%'
        ORDER BY artifact_id`,
    ).all<{ artifact_id: string; private_expires_at: string }>();
    const firstShares = await env.DB.prepare(
      `SELECT token_hash, public_expires_at
         FROM legacy_shares
        WHERE token_hash IN (?, ?, ?)
        ORDER BY token_hash`,
    )
      .bind(...SHARE_TOKENS)
      .all<{ token_hash: string; public_expires_at: string }>();

    expect(firstArtifacts.results).toHaveLength(2);
    expect(firstShares.results).toHaveLength(3);
    expect(Date.parse(firstArtifacts.results[0]!.private_expires_at)).toBe(
      Date.parse(firstState!.migrated_at) + 30 * 24 * 60 * 60 * 1000,
    );
    expect(Date.parse(firstShares.results[0]!.public_expires_at)).toBe(
      Date.parse(firstState!.migrated_at) + 7 * 24 * 60 * 60 * 1000,
    );

    await applyLegacyMigration("legacy_rerun_migrations");
    const secondState = await env.DB.prepare(
      "SELECT migrated_at FROM legacy_migration_state WHERE id = 1",
    ).first<{ migrated_at: string }>();
    expect(secondState).toEqual(firstState);
    const secondArtifacts = await env.DB.prepare(
      "SELECT artifact_id, private_expires_at FROM legacy_artifacts WHERE artifact_id LIKE 'ticket18-%' ORDER BY artifact_id",
    ).all();
    expect(secondArtifacts.results).toEqual(firstArtifacts.results);
    const secondShares = await env.DB.prepare(
      "SELECT token_hash, public_expires_at FROM legacy_shares WHERE token_hash IN (?, ?, ?) ORDER BY token_hash",
    )
      .bind(...SHARE_TOKENS)
      .all();
    expect(secondShares.results).toEqual(firstShares.results);

    const revisions = await env.DB.prepare(
      "SELECT version, source FROM revisions WHERE artifact_id IN (?, ?) ORDER BY artifact_id, version",
    )
      .bind(...ARTIFACT_IDS)
      .all();
    expect(revisions.results).toEqual([
      { version: 1, source: "exact\r\nsource\u0000" },
      { version: 2, source: "second exact source" },
      { version: 1, source: "other artifact source" },
    ]);
    const shares = await env.DB.prepare(
      "SELECT token_hash, revoked_at FROM shares WHERE token_hash IN (?, ?, ?) ORDER BY token_hash",
    )
      .bind(...SHARE_TOKENS)
      .all();
    expect(shares.results).toEqual([
      { token_hash: SHARE_TOKENS[0], revoked_at: null },
      { token_hash: SHARE_TOKENS[1], revoked_at: "2026-08-29T12:03:00.000Z" },
      { token_hash: SHARE_TOKENS[2], revoked_at: null },
    ]);
  });

  it("removes classification rows when source rows are explicitly deleted", async () => {
    await seedLegacyRows();
    await applyLegacyMigration();

    await env.DB.prepare("DELETE FROM shares WHERE token_hash = ?")
      .bind(SHARE_TOKENS[0])
      .run();
    await env.DB.prepare("DELETE FROM artifacts WHERE id = ?")
      .bind(ARTIFACT_IDS[0])
      .run();

    expect(
      await env.DB.prepare("SELECT 1 FROM legacy_shares WHERE token_hash = ?")
        .bind(SHARE_TOKENS[0])
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM legacy_artifacts WHERE artifact_id = ?",
      )
        .bind(ARTIFACT_IDS[0])
        .first(),
    ).toBeNull();
  });

  it("serves an active legacy artifact read-only and returns 410 at private expiry", async () => {
    await seedLegacyRows();
    await applyLegacyMigration();

    const current = await api(`/api/artifacts/${ARTIFACT_IDS[0]}`, {
      headers: { Authorization: "Bearer legacy-owner-one" },
    });
    expect(current.status).toBe(200);
    expect(await current.clone().json()).toMatchObject({
      legacy: {
        readOnly: true,
        migratedAt: expect.any(String),
        privateExpiresAt: expect.any(String),
      },
    });
    expect(
      ((await current.json()) as { revision: { source: string } }).revision
        .source,
    ).toBe("second exact source");

    const malformedWrite = await api(
      `/api/artifacts/${ARTIFACT_IDS[0]}/revisions`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer legacy-owner-one",
          "Content-Type": "application/json",
        },
        body: "not json",
      },
    );
    expect(malformedWrite.status).toBe(409);
    expect(
      ((await malformedWrite.json()) as { error: { message: string } }).error
        .message,
    ).toBe("Legacy artifacts are read-only");

    await env.DB.prepare(
      "UPDATE legacy_artifacts SET private_expires_at = ? WHERE artifact_id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", ARTIFACT_IDS[0])
      .run();
    const missingExpired = await api(`/api/artifacts/${ARTIFACT_IDS[0]}`);
    expect(missingExpired.status).toBe(401);
    const wrongExpired = await api(`/api/artifacts/${ARTIFACT_IDS[0]}`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongExpired.status).toBe(403);
    const unknownArtifact = await api("/api/artifacts/unknown-artifact", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(unknownArtifact.status).toBe(404);
    const expired = await api(`/api/artifacts/${ARTIFACT_IDS[0]}`, {
      headers: { Authorization: "Bearer legacy-owner-one" },
    });
    expect(expired.status).toBe(410);
    expect(expired.headers.get("Cache-Control")).toBe("no-store");
    expect(expired.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(expired.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("expires a legacy public share without exposing its revision", async () => {
    await seedLegacyRows();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM shares WHERE artifact_id = ?").bind(
        ARTIFACT_IDS[1],
      ),
      env.DB.prepare(
        `INSERT INTO shares (token_hash, artifact_id, revision_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)`,
      ).bind(
        await sha256Text("legacy-public-token"),
        ARTIFACT_IDS[1],
        "ticket18-revision-two-v1",
        MIGRATED_AT,
      ),
    ]);
    await applyLegacyMigration();
    await env.DB.prepare(
      "UPDATE legacy_shares SET public_expires_at = ? WHERE token_hash = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", await sha256Text("legacy-public-token"))
      .run();

    await env.DB.prepare(
      "UPDATE legacy_shares SET public_expires_at = ? WHERE token_hash = ?",
    )
      .bind("2099-01-01T00:00:00.000Z", await sha256Text("legacy-public-token"))
      .run();
    const publicResponse = await api("/api/public/legacy-public-token");
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.clone().json()).toMatchObject({
      legacy: { readOnly: true },
    });

    await env.DB.prepare(
      "UPDATE legacy_shares SET public_expires_at = ? WHERE token_hash = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", await sha256Text("legacy-public-token"))
      .run();
    const expired = await api("/api/public/legacy-public-token");
    expect(expired.status).toBe(410);
    expect(await expired.text()).not.toContain("other artifact source");

    await env.DB.prepare(
      "UPDATE legacy_shares SET public_expires_at = ? WHERE token_hash = ?",
    )
      .bind("2099-01-01T00:00:00.000Z", await sha256Text("legacy-public-token"))
      .run();
    await env.DB.prepare(
      "UPDATE shares SET revoked_at = ? WHERE token_hash = ?",
    )
      .bind(new Date().toISOString(), await sha256Text("legacy-public-token"))
      .run();
    const revoked = await api("/api/public/legacy-public-token");
    expect(revoked.status).toBe(410);
  });

  it("deletes only the selected Legacy artifact after exact confirmation", async () => {
    await seedLegacyRows();
    await applyLegacyMigration();
    const request = (confirmation: string) =>
      new Request("https://panes.example/api/inventory/legacy/artifacts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });

    expect(
      (
        await deleteLegacyInventoryArtifact(
          request("wrong"),
          env,
          ARTIFACT_IDS[0]!,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await deleteLegacyInventoryArtifact(
          request(cloudDeletionConfirmation("Legacy one")),
          env,
          ARTIFACT_IDS[0]!,
        )
      ).status,
    ).toBe(204);
    expect(
      await env.DB.prepare("SELECT 1 FROM artifacts WHERE id = ?")
        .bind(ARTIFACT_IDS[0])
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM artifacts WHERE id = ?")
        .bind(ARTIFACT_IDS[1])
        .first(),
    ).not.toBeNull();
  });
});

async function resetToLegacySchema(): Promise<void> {
  await dropAllTables();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 2));
}

async function dropAllTables(): Promise<void> {
  await env.DB.exec(
    `PRAGMA foreign_keys = OFF;
     ${DROP_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join("\n")}
     PRAGMA foreign_keys = ON;`,
  );
}

async function applyLegacyMigration(
  migrationsTableName = "d1_migrations",
): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find(({ name }) =>
    name.includes("0009"),
  );
  if (!migration) throw new Error("0009 migration fixture is missing");
  await applyD1Migrations(env.DB, [migration], migrationsTableName);
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://panes.example${path}`, init), env);
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

async function seedLegacyRows(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO artifacts
        (id, owner_token_hash, workspace_token_hash, opencode_session_id,
         title, type, current_revision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ARTIFACT_IDS[0],
      await sha256Text("legacy-owner-one"),
      await sha256Text("legacy-workspace-one"),
      "ticket18-session-one",
      "Legacy one",
      "html",
      "ticket18-revision-one-v2",
      MIGRATED_AT,
      MIGRATED_AT,
    ),
    env.DB.prepare(
      `INSERT INTO artifacts
        (id, owner_token_hash, workspace_token_hash, opencode_session_id,
         title, type, current_revision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ARTIFACT_IDS[1],
      await sha256Text("legacy-owner-two"),
      await sha256Text("legacy-workspace-two"),
      "ticket18-session-two",
      "Legacy two",
      "markdown",
      "ticket18-revision-two-v1",
      MIGRATED_AT,
      MIGRATED_AT,
    ),
    env.DB.prepare(
      `INSERT INTO revisions (id, artifact_id, version, source, created_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    ).bind(
      "ticket18-revision-one-v1",
      ARTIFACT_IDS[0],
      1,
      "exact\r\nsource\u0000",
      MIGRATED_AT,
      "ticket18-revision-one-v2",
      ARTIFACT_IDS[0],
      2,
      "second exact source",
      MIGRATED_AT,
      "ticket18-revision-two-v1",
      ARTIFACT_IDS[1],
      1,
      "other artifact source",
      MIGRATED_AT,
    ),
    env.DB.prepare(
      `INSERT INTO shares (token_hash, artifact_id, revision_id, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    ).bind(
      SHARE_TOKENS[0],
      ARTIFACT_IDS[0],
      "ticket18-revision-one-v1",
      MIGRATED_AT,
      null,
      SHARE_TOKENS[1],
      ARTIFACT_IDS[0],
      "ticket18-revision-one-v2",
      "2026-08-29T12:02:00.000Z",
      "2026-08-29T12:03:00.000Z",
      SHARE_TOKENS[2],
      ARTIFACT_IDS[1],
      "ticket18-revision-two-v1",
      MIGRATED_AT,
      null,
    ),
  ]);
}
