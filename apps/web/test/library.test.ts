import { env, createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactShare, PublicArtifact } from "@opencode-panes/contracts";
import worker from "../worker";
import { previewToken } from "../worker/security";
import {
  api,
  artifact,
  commit,
  inventory,
  KEY,
  manifest,
  ownerFixture,
  put,
  reset,
  SOURCES,
  start,
  uploaded,
  UPLOAD_HEADERS,
} from "./fixtures";

beforeEach(reset);

async function shared(expiresInDays: 1 | 7 | 30 | null = null) {
  const owner = await ownerFixture();
  const upload = await uploaded();
  const endpoint = `/api/library/artifacts/${upload.session.artifactId}/share`;
  const response = await owner.request(endpoint, {
    method: "PUT",
    body: JSON.stringify({ versionId: upload.session.uploadId, expiresInDays }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const share = await response.json<ArtifactShare>();
  const publicPath = `/api/shares/${new URL(share.url).pathname.split("/").pop()}`;
  return { owner, ...upload, endpoint, share, publicPath };
}

describe("read-only previews and publication", () => {
  it("issues short-lived version-scoped previews without credentials and serves relative HTML/SVG assets unchanged", async () => {
    const owner = await ownerFixture();
    const { session } = await uploaded();
    const item = await artifact(owner, session.artifactId);
    const url = item.versions[0]!.previewUrl;
    expect(url).not.toContain(KEY);
    expect(url).not.toContain(owner.headers["Cf-Access-Jwt-Assertion"]);
    for (const [path, source] of Object.entries(SOURCES)) {
      const response = await api(new URL(`../${path}`, url).href);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new TextEncoder().encode(source),
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const csp = response.headers.get("Content-Security-Policy")!;
      expect(csp).toContain("sandbox allow-scripts;");
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).not.toContain("allow-top-navigation");
      expect(csp).toContain("https:");
      expect(csp).toContain("base-uri 'none'");
    }
    expect(
      (await api(new URL("../assets/main.js", url).href)).headers.get(
        "Content-Type",
      ),
    ).toContain("text/javascript");
    expect(
      (await api(new URL("../assets/picture.svg", url).href)).headers.get(
        "Content-Type",
      ),
    ).toBe("image/svg+xml");
    expect(
      (await api(url, { method: "HEAD" })).headers.get("Content-Length"),
    ).toBe(
      String(new TextEncoder().encode(SOURCES["pages/index.html"]).length),
    );
    expect((await api(url, { method: "PUT", body: "evil" })).status).toBe(404);
    const token = new URL(url).pathname.split("/")[3]!;
    expect(
      (
        await api("/api/uploads", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(manifest()),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await api("/api/library", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await api(
          url.replace(
            token,
            `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`,
          ),
        )
      ).status,
    ).toBe(404);
    const other = await uploaded(manifest({ artifactKey: "other" }));
    expect(
      (await api(url.replace(session.uploadId, other.session.uploadId))).status,
    ).toBe(404);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601000);
    expect((await api(url)).status).toBe(404);
    clock.mockRestore();
    expect((await api(url, {}, { PANES_UPLOAD_KEY: "rotated" })).status).toBe(
      404,
    );
    expect((await api(url, {}, { PANES_UPLOAD_KEY: "" })).status).toBe(503);
    const incomplete = await start(manifest());
    const notCommitted = previewToken(incomplete.uploadId, {
      ...env,
      PANES_UPLOAD_KEY: KEY,
    });
    expect(
      (await api(`/api/previews/${notCommitted}/files/pages/index.html`))
        .status,
    ).toBe(404);
  });

  it("shares with no expiry by default and keeps an active URL stable on explicit version updates", async () => {
    const one = await shared();
    expect(one.share).toMatchObject({
      expiresAt: null,
      status: "active",
      versionId: one.session.uploadId,
    });
    const selected = await (await api(one.publicPath)).json<PublicArtifact>();
    expect(selected.version.previewUrl).toContain(
      `/versions/${one.session.uploadId}/files/`,
    );
    expect(selected.version.previewUrl).not.toContain("/previews/");
    expect(
      new Uint8Array(
        await (await api(selected.version.previewUrl)).arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode(SOURCES["pages/index.html"]));
    const two = await uploaded(manifest({ title: "New" }));
    expect(
      (await (await api(one.publicPath)).json<PublicArtifact>()).version.id,
    ).toBe(one.session.uploadId);
    const updated = await one.owner.request(one.endpoint, {
      method: "PUT",
      body: JSON.stringify({
        versionId: two.session.uploadId,
        expiresInDays: null,
      }),
    });
    expect((await updated.json<ArtifactShare>()).url).toBe(one.share.url);
    const latest = await (await api(one.publicPath)).json<PublicArtifact>();
    expect(latest.title).toBe("New");
    expect(latest.version.id).toBe(two.session.uploadId);
    expect((await api(selected.version.previewUrl)).status).toBe(404);
    expect(
      (
        await api(
          new URL("../assets/main.css", selected.version.previewUrl).href,
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(new URL("../assets/main.css", latest.version.previewUrl).href))
        .status,
    ).toBe(200);
    expect((await artifact(one.owner, one.session.artifactId)).share!.url).toBe(
      one.share.url,
    );
  });

  it.each([1, 7, 30] as const)(
    "expires %i-day shares at the boundary and fails closed for all files",
    async (days) => {
      const item = await shared(days);
      const selected = await (
        await api(item.publicPath)
      ).json<PublicArtifact>();
      expect(Date.parse(item.share.expiresAt!) - Date.now()).toBeGreaterThan(
        days * 86400000 - 10000,
      );
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.parse(item.share.expiresAt!));
      expect((await api(item.publicPath)).status).toBe(404);
      expect((await api(selected.version.previewUrl)).status).toBe(404);
      clock.mockRestore();
      await env.DB.prepare(
        "UPDATE library_shares SET expires_at = ? WHERE artifact_id = ?",
      )
        .bind("2000-01-01T00:00:00.000Z", item.session.artifactId)
        .run();
      expect(
        (await artifact(item.owner, item.session.artifactId)).share!.status,
      ).toBe("expired");
      const renewed = await item.owner.request(item.endpoint, {
        method: "PUT",
        body: JSON.stringify({
          versionId: item.session.uploadId,
          expiresInDays: null,
        }),
      });
      expect((await renewed.json<ArtifactShare>()).url).not.toBe(
        item.share.url,
      );
      expect((await api(item.publicPath)).status).toBe(404);
    },
  );

  it("revokes immediately, issues a fresh link on reshare, and never accepts malformed expiry", async () => {
    const item = await shared();
    const selected = await (await api(item.publicPath)).json<PublicArtifact>();
    expect(
      (await item.owner.request(item.endpoint, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await item.owner.request(item.endpoint, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await api(item.publicPath)).status).toBe(404);
    expect((await api(selected.version.previewUrl)).status).toBe(404);
    const response = await item.owner.request(item.endpoint, {
      method: "PUT",
      body: JSON.stringify({
        versionId: item.session.uploadId,
        expiresInDays: null,
      }),
    });
    const renewed = await response.json<ArtifactShare>();
    expect(renewed.url).not.toBe(item.share.url);
    await env.DB.prepare(
      "UPDATE library_shares SET expires_at = 'not-a-date' WHERE artifact_id = ?",
    )
      .bind(item.session.artifactId)
      .run();
    expect(
      (
        await api(
          `/api/shares/${new URL(renewed.url).pathname.split("/").pop()}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await artifact(item.owner, item.session.artifactId)).share!.status,
    ).toBe("expired");
  });

  it("refuses shares of another artifact or an uncommitted version and unsupported durations", async () => {
    const item = await shared();
    const other = await uploaded(manifest({ artifactKey: "another" }));
    const unfinished = await start(manifest());
    for (const versionId of [
      other.session.uploadId,
      unfinished.uploadId,
      crypto.randomUUID(),
    ]) {
      expect(
        (
          await item.owner.request(item.endpoint, {
            method: "PUT",
            body: JSON.stringify({ versionId, expiresInDays: null }),
          })
        ).status,
      ).toBe(404);
    }
    for (const expiresInDays of [0, -1, 2, "7", undefined]) {
      expect(
        (
          await item.owner.request(item.endpoint, {
            method: "PUT",
            body: JSON.stringify({
              versionId: item.session.uploadId,
              expiresInDays,
            }),
          })
        ).status,
      ).toBe(400);
    }
    expect((await api(item.publicPath)).status).toBe(200);
  });

  it("rejects path escapes, unknown files and encoded percent tricks on private/public/upload routes", async () => {
    const item = await shared();
    const privateUrl = (await artifact(item.owner, item.session.artifactId))
      .versions[0]!.previewUrl;
    const publicUrl = (
      await (await api(item.publicPath)).json<PublicArtifact>()
    ).version.previewUrl;
    for (const suffix of [
      "%252e%252e/secret",
      "%2e%2e%2fsecret",
      "%2Fetc/passwd",
      "x%5cy",
      "a%00b",
      "x%3Fy",
      "%zz",
      "missing.txt",
    ]) {
      for (const url of [privateUrl, publicUrl]) {
        const response = await api(url.replace("pages/index.html", suffix));
        expect([400, 404]).toContain(response.status);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      }
      const response = await api(
        `/api/uploads/${item.session.uploadId}/files/${suffix}`,
        { method: "PUT", headers: UPLOAD_HEADERS, body: "x" },
      );
      expect([400, 404]).toContain(response.status);
    }
  });

  it("serves standalone SVG and safely encodes spaces, Unicode, and unknown types", async () => {
    const sources = {
      "drawings/my café.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="../photo.png"/></svg>',
      "photo.png": "bytes",
      "payload.bin": "<script>evil</script>",
    };
    const owner = await ownerFixture();
    const item = await uploaded(
      manifest({ entryPath: "drawings/my café.svg" }, sources),
      sources,
    );
    const url = (await artifact(owner, item.session.artifactId)).versions[0]!
      .previewUrl;
    expect(url).toContain("my%20caf%C3%A9.svg");
    expect((await api(url)).headers.get("Content-Type")).toBe("image/svg+xml");
    expect(
      new Uint8Array(
        await (await api(new URL("../photo.png", url).href)).arrayBuffer(),
      ),
    ).toEqual(new TextEncoder().encode("bytes"));
    const unknown = await api(new URL("../payload.bin", url).href);
    expect(unknown.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(unknown.headers.get("Content-Disposition")).toBe("attachment");
  });
});

describe("cloud deletion", () => {
  it("deletes all independent versions, revokes reads, blocks retries, and permits a fresh new artifact", async () => {
    const item = await shared();
    const second = await uploaded();
    const untouched = await uploaded(manifest({ artifactKey: "keep" }));
    const privateUrl = (await artifact(item.owner, item.session.artifactId))
      .versions[0]!.previewUrl;
    const publicUrl = (
      await (await api(item.publicPath)).json<PublicArtifact>()
    ).version.previewUrl;
    const endpoint = `/api/library/artifacts/${item.session.artifactId}`;
    expect(
      (await item.owner.request(endpoint, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await item.owner.request(endpoint, { method: "DELETE" })).status,
    ).toBe(204);
    for (const path of [endpoint, privateUrl, publicUrl, item.publicPath])
      expect((await item.owner.request(path)).status).toBe(404);
    expect((await commit(second.session)).status).toBe(410);
    expect(
      (
        await put(
          item.session,
          "pages/index.html",
          SOURCES["pages/index.html"]!,
        )
      ).status,
    ).toBe(410);
    expect(
      (
        await api("/api/uploads", {
          method: "POST",
          headers: UPLOAD_HEADERS,
          body: JSON.stringify(item.input),
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await env.PRIVATE_ARTIFACTS.list({
          prefix: `library/${item.session.artifactId}/`,
        })
      ).objects,
    ).toHaveLength(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM library_versions WHERE artifact_id = ?",
      )
        .bind(item.session.artifactId)
        .first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT manifest FROM library_uploads WHERE id = ?")
        .bind(item.session.uploadId)
        .first("manifest"),
    ).toBe("{}");
    expect((await inventory(item.owner)).artifacts.map((a) => a.id)).toEqual([
      untouched.session.artifactId,
    ]);
    const fresh = await uploaded();
    expect(fresh.session.artifactId).not.toBe(item.session.artifactId);
    expect(
      (await artifact(item.owner, fresh.session.artifactId)).versions[0]!
        .number,
    ).toBe(1);
  });

  it("closes in-flight write/delete races and sweeps orphan bytes left by an interrupted delete", async () => {
    const owner = await ownerFixture();
    const session = await start(manifest());
    let release!: () => void;
    let reading!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading();
          await wait;
          controller.enqueue(
            new TextEncoder().encode(SOURCES["pages/index.html"]),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = put(session, "pages/index.html", body);
    await started;
    expect(
      (
        await owner.request(`/api/library/artifacts/${session.artifactId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    release();
    expect((await pending).status).toBe(410);
    const key = `library/${session.artifactId}/${session.uploadId}/orphan.html`;
    await env.PRIVATE_ARTIFACTS.put(key, "interrupted write");
    await worker.scheduled(createScheduledController(), { ...env });
    expect(await env.PRIVATE_ARTIFACTS.head(key)).toBeNull();
    expect((await commit(session)).status).toBe(410);
  });

  it("cannot commit a version after deletion wins during integrity verification", async () => {
    const owner = await ownerFixture();
    const sources = { "index.html": "<h1>race</h1>" };
    const session = await start(manifest({ entryPath: "index.html" }, sources));
    await put(session, "index.html", sources["index.html"]);
    const get = env.PRIVATE_ARTIFACTS.get.bind(env.PRIVATE_ARTIFACTS);
    let release!: () => void;
    let verifying!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    vi.spyOn(env.PRIVATE_ARTIFACTS, "get").mockImplementationOnce(
      async (key) => {
        const object = await get(key);
        verifying();
        await pause;
        return object;
      },
    );
    const pending = commit(session);
    await started;
    expect(
      (
        await owner.request(`/api/library/artifacts/${session.artifactId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    release();
    expect((await pending).status).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM library_versions",
      ).first("count"),
    ).toBe(0);
  });
});
