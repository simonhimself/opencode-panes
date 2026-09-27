import { createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactShare, UploadSession } from "@opencode-panes/contracts";
import worker from "../worker";
import {
  api,
  artifact,
  commit,
  inventory,
  manifest,
  ownerFixture,
  put,
  reset,
  start,
  uploaded,
  UPLOAD_HEADERS,
} from "./fixtures";

const WEEK = 7 * 86400000;
const sources = { "index.html": "<h1>snapshot</h1>" };
const input = () => manifest({ entryPath: "index.html" }, sources);
const sweep = () => worker.scheduled(createScheduledController(), { ...env });
const prefix = (session: UploadSession) =>
  `library/${session.artifactId}/${session.uploadId}/`;

async function age(session: UploadSession, milliseconds = WEEK) {
  await env.DB.prepare("UPDATE library_uploads SET created_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - milliseconds).toISOString(), session.uploadId)
    .run();
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { release, entered, wait, started };
}

beforeEach(async () => {
  await reset();
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
});
afterEach(() => vi.restoreAllMocks());

describe("seven-day abandoned upload housekeeping", () => {
  it.each([0, WEEK - 1])(
    "keeps %i-ms-old uploads resumable without extending creation time",
    async (elapsed) => {
      const request = input();
      const session = await start(request);
      await age(session, elapsed);
      const created = new Date(Date.now() - elapsed).toISOString();
      await sweep();
      expect(await start(request)).toEqual(session);
      expect(
        (await put(session, "index.html", sources["index.html"])).status,
      ).toBe(204);
      expect(
        await env.DB.prepare(
          "SELECT created_at, expired_at, cleanup_checked_at FROM library_uploads WHERE id = ?",
        )
          .bind(session.uploadId)
          .first(),
      ).toEqual({
        created_at: created,
        expired_at: null,
        cleanup_checked_at: null,
      });
      expect(await (await commit(session)).json()).toMatchObject({
        version: 1,
      });
    },
  );

  it.each(["put", "commit", "cron"])(
    "expires at exactly seven days through %s, even after recent file activity",
    async (operation) => {
      const session = await start(input());
      await age(session, WEEK - 1);
      expect(
        (await put(session, "index.html", sources["index.html"])).status,
      ).toBe(204);
      vi.mocked(Date.now).mockReturnValue(Date.now() + 1);
      if (operation === "cron") await sweep();
      else {
        const response =
          operation === "put"
            ? await put(session, "index.html", sources["index.html"])
            : await commit(session);
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
          error: "Upload expired; start a new upload",
        });
      }
      const row = await env.DB.prepare(
        "SELECT expired_at, idempotency_key, manifest FROM library_uploads WHERE id = ?",
      )
        .bind(session.uploadId)
        .first();
      expect(row).toEqual({
        expired_at: new Date(Date.now()).toISOString(),
        idempotency_key: `expired:${session.uploadId}`,
        manifest: "{}",
      });
      expect((await commit(session)).status).toBe(410);
      expect(
        (await put(session, "index.html", sources["index.html"])).status,
      ).toBe(410);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM library_versions",
        ).first("n"),
      ).toBe(0);
      await sweep();
      expect(
        (await env.PRIVATE_ARTIFACTS.list({ prefix: prefix(session) })).objects,
      ).toEqual([]);
    },
  );

  it("cleans only stale initial/second upload prefixes, never old private or shared versions", async () => {
    const owner = await ownerFixture();
    const publicInput = input();
    const shared = await uploaded(publicInput, sources);
    const privateVersion = await uploaded(
      { ...input(), artifactKey: "private" },
      sources,
    );
    const response = await owner.request(
      `/api/library/artifacts/${shared.session.artifactId}/share`,
      {
        method: "PUT",
        body: JSON.stringify({
          versionId: shared.session.uploadId,
          expiresInDays: null,
        }),
      },
    );
    const share = await response.json<ArtifactShare>();
    const staleSecond = await start(input());
    const staleInitial = await start({ ...input(), artifactKey: "unfinished" });
    const young = await start(input());
    for (const session of [staleSecond, staleInitial, young])
      await put(session, "index.html", sources["index.html"]);
    for (const session of [
      shared.session,
      privateVersion.session,
      staleSecond,
      staleInitial,
    ])
      await age(session, 30 * 86400000);
    const adjacent = `${prefix(staleSecond).slice(0, -1)}-other/index.html`;
    await env.PRIVATE_ARTIFACTS.put(adjacent, "not this upload prefix");
    await sweep();
    for (const session of [staleSecond, staleInitial])
      expect(
        await env.PRIVATE_ARTIFACTS.head(`${prefix(session)}index.html`),
      ).toBeNull();
    for (const session of [shared.session, privateVersion.session, young]) {
      expect(
        await env.PRIVATE_ARTIFACTS.head(`${prefix(session)}index.html`),
      ).not.toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT expired_at FROM library_uploads WHERE id = ?",
        )
          .bind(session.uploadId)
          .first("expired_at"),
      ).toBeNull();
    }
    expect(await env.PRIVATE_ARTIFACTS.head(adjacent)).not.toBeNull();
    expect((await start(publicInput)).complete).toBe(true);
    expect((await commit(shared.session)).status).toBe(200);
    const item = await artifact(owner, shared.session.artifactId);
    expect(item.share).toEqual(share);
    expect(await (await api(item.versions[0]!.previewUrl)).text()).toBe(
      sources["index.html"],
    );
    const token = new URL(share.url).pathname.split("/").pop();
    expect(
      (
        await api(
          `/api/shares/${token}/versions/${shared.session.uploadId}/files/index.html`,
        )
      ).status,
    ).toBe(200);
    expect((await inventory(owner)).artifacts).toHaveLength(2);
    expect(await (await commit(young)).json()).toMatchObject({ version: 2 });
    // Expiring a share is also never permission to expire its committed upload.
    await env.DB.prepare(
      "UPDATE library_shares SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    await sweep();
    expect(
      await env.PRIVATE_ARTIFACTS.head(`${prefix(shared.session)}index.html`),
    ).not.toBeNull();
  });

  it.each([false, true])(
    "restarts an identical request on the same artifact after expiry (cron=%s), without version gaps",
    async (cron) => {
      const request = input();
      const original = await start(request);
      await put(original, "index.html", sources["index.html"]);
      await age(original);
      if (cron) await sweep();
      const retries = await Promise.all(
        Array.from({ length: 4 }, () => start(request)),
      );
      const fresh = retries[0]!;
      expect(new Set(retries.map((session) => session.uploadId)).size).toBe(1);
      expect(fresh.uploadId).not.toBe(original.uploadId);
      expect(fresh.artifactId).toBe(original.artifactId);
      expect(fresh.complete).toBe(false);
      expect((await commit(fresh)).status).toBe(409);
      await put(fresh, "index.html", sources["index.html"]);
      expect(await (await commit(fresh)).json()).toMatchObject({ version: 1 });
      expect((await start(request)).complete).toBe(true);
      expect((await commit(original)).status).toBe(410);
      expect(
        (await put(original, "index.html", sources["index.html"])).status,
      ).toBe(410);
      await sweep();
      expect(
        await env.PRIVATE_ARTIFACTS.head(`${prefix(fresh)}index.html`),
      ).not.toBeNull();
      expect(
        await env.PRIVATE_ARTIFACTS.head(`${prefix(original)}index.html`),
      ).toBeNull();
    },
  );

  it("releases expired payload identity, but still rejects changed live payloads and client tombstone keys", async () => {
    const request = input();
    const original = await start(request);
    await age(original);
    const changed = { ...request, title: "Different metadata" };
    const fresh = await start(changed);
    expect(fresh.artifactId).toBe(original.artifactId);
    expect(fresh.uploadId).not.toBe(original.uploadId);
    for (const [body, status] of [
      [request, 409],
      [{ ...request, idempotencyKey: `expired:${original.uploadId}` }, 400],
    ] as const) {
      expect(
        (
          await api("/api/uploads", {
            method: "POST",
            headers: UPLOAD_HEADERS,
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(status);
    }
  });

  it("bounds prefixes and R2 pages, rotates empty receipts, and drains multiple pages fairly", async () => {
    const sessions: UploadSession[] = [];
    for (let n = 0; n < 23; n++) {
      const session = await start(input());
      sessions.push(session);
      await put(session, "index.html", sources["index.html"]);
      await age(session, WEEK + n);
    }
    const large = sessions[22]!;
    for (let n = 0; n < 204; n++)
      await env.PRIVATE_ARTIFACTS.put(
        `${prefix(large)}${String(n).padStart(3, "0")}.txt`,
        "partial",
      );
    const list = vi.spyOn(env.PRIVATE_ARTIFACTS, "list");
    const remove = vi.spyOn(env.PRIVATE_ARTIFACTS, "delete");
    await sweep();
    expect(list).toHaveBeenCalledTimes(20);
    expect(
      list.mock.calls.every(
        ([options]) => options?.limit === 100 && !options.cursor,
      ),
    ).toBe(true);
    expect(
      remove.mock.calls.every(
        ([keys]) => Array.isArray(keys) && keys.length <= 100,
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM library_uploads WHERE expired_at IS NOT NULL",
      ).first("n"),
    ).toBe(20);
    const unchecked = (
      await env.DB.prepare(
        "SELECT id FROM library_uploads WHERE cleanup_checked_at IS NULL",
      ).all<{ id: string }>()
    ).results;
    const newcomer = await start(input());
    await age(newcomer);
    for (let run = 0; run < 4; run++) {
      vi.mocked(Date.now).mockReturnValue(Date.now() + 1000);
      list.mockClear();
      await sweep();
      expect(list).toHaveBeenCalledTimes(20);
      if (run === 0) {
        for (const session of [...unchecked, { id: newcomer.uploadId }])
          expect(
            await env.DB.prepare(
              "SELECT cleanup_checked_at FROM library_uploads WHERE id = ?",
            )
              .bind(session.id)
              .first("cleanup_checked_at"),
          ).not.toBeNull();
      }
    }
    expect(
      (
        await env.PRIVATE_ARTIFACTS.list({
          prefix: `library/${large.artifactId}/`,
        })
      ).objects,
    ).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM library_uploads WHERE expired_at IS NOT NULL",
      ).first("n"),
    ).toBe(24);
  });

  it.each(["list", "delete"] as const)(
    "retries injected R2 %s failure without blocking other prefixes or artifact deletion",
    async (operation) => {
      const owner = await ownerFixture();
      const one = await start(input());
      const two = await start(input());
      const deleted = await uploaded(
        { ...input(), artifactKey: "delete-me" },
        sources,
      );
      for (const session of [one, two]) {
        await put(session, "index.html", sources["index.html"]);
        await age(session);
      }
      await env.DB.prepare(
        "UPDATE library_artifacts SET deleted_at = ? WHERE id = ?",
      )
        .bind(new Date(Date.now()).toISOString(), deleted.session.artifactId)
        .run();
      const failure = vi
        .spyOn(env.PRIVATE_ARTIFACTS, operation)
        .mockRejectedValueOnce(new Error("injected R2 failure"));
      await expect(sweep()).rejects.toThrow(
        "Abandoned upload cleanup incomplete; retry scheduled",
      );
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM library_uploads WHERE cleanup_checked_at IS NOT NULL",
        ).first("n"),
      ).toBe(2);
      expect(
        (
          await env.PRIVATE_ARTIFACTS.list({
            prefix: `library/${one.artifactId}/`,
          })
        ).objects,
      ).toHaveLength(1);
      expect(
        await env.PRIVATE_ARTIFACTS.head(
          `${prefix(deleted.session)}index.html`,
        ),
      ).toBeNull();
      failure.mockRestore();
      vi.mocked(Date.now).mockReturnValue(Date.now() + 1000);
      await sweep();
      expect(
        (
          await env.PRIVATE_ARTIFACTS.list({
            prefix: `library/${one.artifactId}/`,
          })
        ).objects,
      ).toEqual([]);
      expect((await inventory(owner)).artifacts).toEqual([]);
    },
  );

  it.each([false, true])(
    "closes an in-flight PUT/expiry race and sweeps bytes after a post-PUT crash (crash=%s)",
    async (crash) => {
      const session = await start(input());
      await age(session, WEEK - 1);
      const pause = gate();
      const store = env.PRIVATE_ARTIFACTS.put.bind(env.PRIVATE_ARTIFACTS);
      vi.spyOn(env.PRIVATE_ARTIFACTS, "put").mockImplementationOnce(
        async (key, value, options) => {
          pause.entered();
          await pause.wait;
          const result = await store(key, value, options);
          if (crash) throw new Error("request lost after R2 PUT");
          return result;
        },
      );
      const pending = put(session, "index.html", sources["index.html"]);
      await pause.started;
      vi.mocked(Date.now).mockReturnValue(Date.now() + 1);
      await sweep();
      pause.release();
      expect((await pending).status).toBe(crash ? 500 : 410);
      const key = `${prefix(session)}index.html`;
      expect(!!(await env.PRIVATE_ARTIFACTS.head(key))).toBe(crash);
      vi.mocked(Date.now).mockReturnValue(Date.now() + 1000);
      await sweep();
      expect(await env.PRIVATE_ARTIFACTS.head(key)).toBeNull();
      expect((await commit(session)).status).toBe(410);
    },
  );

  it("continues across pages after R2 partially deletes a batch and fails", async () => {
    const session = await start(input());
    for (let n = 0; n < 205; n++)
      await env.PRIVATE_ARTIFACTS.put(
        `${prefix(session)}${String(n).padStart(3, "0")}.txt`,
        "partial",
      );
    await age(session);
    await sweep();
    expect(
      (await env.PRIVATE_ARTIFACTS.list({ prefix: prefix(session) })).objects,
    ).toHaveLength(105);
    const remove = env.PRIVATE_ARTIFACTS.delete.bind(env.PRIVATE_ARTIFACTS);
    vi.spyOn(env.PRIVATE_ARTIFACTS, "delete").mockImplementationOnce(
      async (keys) => {
        expect(Array.isArray(keys) && keys.length).toBe(100);
        await remove((keys as string[]).slice(0, 30));
        throw new Error("partial R2 delete");
      },
    );
    vi.mocked(Date.now).mockReturnValue(Date.now() + 1000);
    await expect(sweep()).rejects.toThrow(
      "Abandoned upload cleanup incomplete",
    );
    expect(
      (await env.PRIVATE_ARTIFACTS.list({ prefix: prefix(session) })).objects,
    ).toHaveLength(75);
    vi.mocked(Date.now).mockReturnValue(Date.now() + 1000);
    await sweep();
    expect(
      (await env.PRIVATE_ARTIFACTS.list({ prefix: prefix(session) })).objects,
    ).toEqual([]);
    expect((await commit(session)).status).toBe(410);
  });

  it("returns 410 when cleanup removes a conditional PUT's existing target", async () => {
    const session = await start(input());
    await put(session, "index.html", sources["index.html"]);
    await age(session, WEEK - 1);
    const pause = gate();
    const store = env.PRIVATE_ARTIFACTS.put.bind(env.PRIVATE_ARTIFACTS);
    vi.spyOn(env.PRIVATE_ARTIFACTS, "put").mockImplementationOnce(
      async (key, value, options) => {
        const result = await store(key, value, options);
        expect(result).toBeNull();
        pause.entered();
        await pause.wait;
        return result;
      },
    );
    const pending = put(session, "index.html", sources["index.html"]);
    await pause.started;
    vi.mocked(Date.now).mockReturnValue(Date.now() + 1);
    await sweep();
    pause.release();
    expect((await pending).status).toBe(410);
  });

  it.each([false, true])(
    "rejects an in-flight commit crossing the fixed cutoff (cleanup wins=%s)",
    async (cleanup) => {
      const session = await start(input());
      await put(session, "index.html", sources["index.html"]);
      await age(session, WEEK - 1);
      const pause = gate();
      const get = env.PRIVATE_ARTIFACTS.get.bind(env.PRIVATE_ARTIFACTS);
      vi.spyOn(env.PRIVATE_ARTIFACTS, "get").mockImplementationOnce(
        async (key) => {
          const object = await get(key);
          pause.entered();
          await pause.wait;
          return object;
        },
      );
      const pending = commit(session);
      await pause.started;
      vi.mocked(Date.now).mockReturnValue(Date.now() + 1);
      if (cleanup) await sweep();
      pause.release();
      expect((await pending).status).toBe(410);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM library_versions",
        ).first("n"),
      ).toBe(0);
      await sweep();
      expect(
        await env.PRIVATE_ARTIFACTS.head(`${prefix(session)}index.html`),
      ).toBeNull();
    },
  );

  it("does not delete a version when commit wins after cleanup candidate selection", async () => {
    const session = await start(input());
    await put(session, "index.html", sources["index.html"]);
    await age(session, WEEK - 1);
    const nearCutoff = Date.now();
    vi.mocked(Date.now).mockReturnValue(nearCutoff + 1);
    const pause = gate();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (query.includes("ORDER BY COALESCE(u.cleanup_checked_at")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values) => {
          const bound = bind(...values);
          const all = bound.all.bind(bound);
          vi.spyOn(bound, "all").mockImplementationOnce(async () => {
            const result = await all();
            pause.entered();
            await pause.wait;
            return result;
          });
          return bound;
        });
      }
      return statement;
    });
    const pending = sweep();
    await pause.started;
    // Model a commit's earlier clock reaching D1 before the cleanup claim.
    vi.mocked(Date.now).mockReturnValue(nearCutoff);
    expect((await commit(session)).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(nearCutoff + 1);
    pause.release();
    await pending;
    expect(
      await env.PRIVATE_ARTIFACTS.head(`${prefix(session)}index.html`),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT expired_at, cleanup_checked_at FROM library_uploads WHERE id = ?",
      )
        .bind(session.uploadId)
        .first(),
    ).toEqual({ expired_at: null, cleanup_checked_at: null });
    expect((await commit(session)).status).toBe(200);
  });

  it("applies migration 0012 to existing 0011 committed rows without expiring or changing them", async () => {
    // Use the real migration statements in an isolated table namespace; never
    // rewind applied migrations or touch historical application tables.
    const schema = env.TEST_MIGRATIONS.find((migration) =>
      migration.name.startsWith("0011"),
    )!;
    const cleanup = env.TEST_MIGRATIONS.find((migration) =>
      migration.name.startsWith("0012"),
    )!;
    const statements = (queries: string[]) =>
      queries.map((query) =>
        env.DB.prepare(query.replaceAll("library_", "migration_check_")),
      );
    await env.DB.batch(statements(schema.queries));
    const request = JSON.stringify(input());
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO migration_check_projects VALUES ('project', 'Project')",
      ),
      env.DB.prepare(
        "INSERT INTO migration_check_artifacts VALUES ('artifact', 'project', 'source', NULL)",
      ),
      env.DB.prepare(
        "INSERT INTO migration_check_uploads VALUES ('upload', 'artifact', ?, ?, '2000-01-01T00:00:00.000Z')",
      ).bind("a".repeat(64), request),
      env.DB.prepare(
        "INSERT INTO migration_check_versions VALUES ('upload', 'artifact', 1, '2000-01-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO migration_check_shares VALUES ('artifact', 'token', 'upload', NULL)",
      ),
    ]);
    await env.DB.batch(statements(cleanup.queries));
    expect(
      await env.DB.prepare(
        "SELECT expired_at, cleanup_checked_at, manifest, idempotency_key FROM migration_check_uploads",
      ).first(),
    ).toEqual({
      expired_at: null,
      cleanup_checked_at: null,
      manifest: request,
      idempotency_key: "a".repeat(64),
    });
    expect(
      await env.DB.prepare("SELECT number FROM migration_check_versions").first(
        "number",
      ),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT version_id FROM migration_check_shares",
      ).first("version_id"),
    ).toBe("upload");
  });
});
