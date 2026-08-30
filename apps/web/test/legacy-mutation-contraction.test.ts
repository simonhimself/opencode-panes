import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker";
import { errorEnvelopeSchema } from "@opencode-panes/contracts";

const ORIGIN = "https://panes.example";
const LOCAL_ARTIFACT_ID = "legacy-contraction-artifact";

describe("legacy mutation contraction", () => {
  it("returns one body-independent no-store 410 for every legacy mutation POST", async () => {
    const before = await storageSnapshot();
    const routes = [
      "/api/artifacts",
      `/api/artifacts/${LOCAL_ARTIFACT_ID}/revisions`,
      `/api/artifacts/${LOCAL_ARTIFACT_ID}/publish`,
      `/api/artifacts/${LOCAL_ARTIFACT_ID}/unpublish`,
    ];

    const responses = await Promise.all(
      routes.map((path) =>
        worker.fetch(
          new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("not-json"));
                controller.close();
              },
            }),
          }),
          env,
        ),
      ),
    );
    const payloads = await Promise.all(
      responses.map(async (response) => ({
        response,
        body: errorEnvelopeSchema.parse(await response.json()),
      })),
    );

    expect(payloads.map(({ response }) => response.status)).toEqual([
      410, 410, 410, 410,
    ]);
    expect(new Set(payloads.map(({ body }) => JSON.stringify(body))).size).toBe(
      1,
    );
    expect(payloads[0]?.body.error).toEqual({
      code: "LOCAL_FIRST_REQUIRED",
      message:
        "Legacy mutation is no longer supported. Create or adopt a project-local Artifact and Sync it.",
    });
    for (const { response } of payloads) {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }

    expect(await storageSnapshot()).toEqual(before);
  });

  it("bypasses configured Sync admission for every retired mutation route", async () => {
    const protectedEnv: Env = {
      ...env,
      PANES_CREATE_API_KEY: "sync-admission-key",
    };
    const routes = [
      "/api/artifacts",
      `/api/artifacts/${LOCAL_ARTIFACT_ID}/revisions`,
      `/api/artifacts/${LOCAL_ARTIFACT_ID}/publish`,
      `/api/artifacts/${LOCAL_ARTIFACT_ID}/unpublish`,
    ];
    const keys = [undefined, "wrong-key", "sync-admission-key"];

    for (const path of routes) {
      for (const key of keys) {
        const headers = new Headers({ "Content-Type": "application/json" });
        if (key) headers.set("X-Panes-Create-Key", key);
        const response = await worker.fetch(
          new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers,
            body: "not-json",
          }),
          protectedEnv,
        );
        expect(response.status).toBe(410);
        expect(errorEnvelopeSchema.parse(await response.json()).error).toEqual({
          code: "LOCAL_FIRST_REQUIRED",
          message:
            "Legacy mutation is no longer supported. Create or adopt a project-local Artifact and Sync it.",
        });
      }
    }
  });

  it("keeps the configured admission check on first Sync creation", async () => {
    const protectedEnv: Env = {
      ...env,
      PANES_CREATE_API_KEY: "sync-admission-key",
    };
    const request = (key?: string) => {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (key) headers.set("X-Panes-Create-Key", key);
      return worker.fetch(
        new Request(`${ORIGIN}/api/sync/artifacts`, {
          method: "POST",
          headers,
          body: "{}",
        }),
        protectedEnv,
      );
    };

    expect((await request()).status).toBe(401);
    expect((await request("wrong-key")).status).toBe(401);
    expect((await request("sync-admission-key")).status).toBe(400);
  });

  it("keeps unsupported methods at 405 with precise Allow headers", async () => {
    const artifact = await SELF.fetch(
      new Request(`${ORIGIN}/api/artifacts/${LOCAL_ARTIFACT_ID}`, {
        method: "POST",
      }),
    );
    expect(artifact.status).toBe(405);
    expect(artifact.headers.get("Allow")).toBe("GET");

    const revisions = await SELF.fetch(
      new Request(`${ORIGIN}/api/artifacts/${LOCAL_ARTIFACT_ID}/revisions`, {
        method: "PUT",
      }),
    );
    expect(revisions.status).toBe(405);
    expect(revisions.headers.get("Allow")).toBe("GET, POST");
  });
});

async function storageSnapshot() {
  const tables = [
    "artifacts",
    "revisions",
    "shares",
    "projects",
    "local_artifacts",
    "local_revisions",
    "revision_files",
    "sync_artifacts",
    "creator_links",
    "sync_uploads",
    "publications",
    "owner_reconnect_codes",
    "artifact_deletion_tombstones",
    "artifact_deletion_objects",
    "legacy_migration_state",
    "legacy_artifacts",
    "legacy_shares",
    "legacy_adoption_grants",
    "legacy_adoption_provenance",
  ];
  const counts = await Promise.all(
    tables.map(
      async (name) =>
        [
          name,
          (
            await env.DB.prepare(
              `SELECT COUNT(*) AS count FROM "${name}"`,
            ).first<{
              count: number;
            }>()
          )?.count ?? 0,
        ] as const,
    ),
  );
  return {
    d1: counts,
    r2: (await env.PRIVATE_ARTIFACTS.list({ limit: 1000 })).objects.map(
      ({ key, etag, size }) => ({ key, etag, size }),
    ),
  };
}
