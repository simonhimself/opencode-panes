import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  KEY,
  manifest,
  ORIGIN,
  ownerFixture,
  reset,
  uploaded,
  UPLOAD_HEADERS,
} from "./fixtures";
import { readAccessConfig } from "../worker/access";
import { env } from "cloudflare:test";

beforeEach(reset);

describe("owner and machine authentication boundaries", () => {
  it("requires the configured upload Bearer even in dev mode and fails closed without a key", async () => {
    for (const headers of [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: `Basic ${KEY}` },
      { "X-Api-Key": KEY },
    ]) {
      expect(
        (
          await api("/api/uploads", {
            method: "POST",
            headers,
            body: JSON.stringify(manifest()),
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await api(
          "/api/uploads",
          { method: "POST", headers: UPLOAD_HEADERS },
          { PANES_UPLOAD_KEY: "" },
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await api(
          "http://127.0.0.1/api/uploads",
          { method: "POST" },
          { PANES_DEV_MODE: "true" },
        )
      ).status,
    ).toBe(401);
    const item = await uploaded();
    for (const [path, method] of [
      [`/api/uploads/${item.session.uploadId}/files/pages/index.html`, "PUT"],
      [`/api/uploads/${item.session.uploadId}/commit`, "POST"],
    ]) {
      expect((await api(path!, { method: method! })).status).toBe(401);
    }
  });

  it("verifies signed Access identity and refuses machine/header spoofing on every owner surface", async () => {
    const owner = await ownerFixture();
    const item = await uploaded();
    const routes = [
      "/api/library",
      `/api/library/artifacts/${item.session.artifactId}`,
      "/inventory",
      `/inventory/artifacts/${item.session.artifactId}`,
    ];
    for (const path of routes) {
      for (const headers of [
        {},
        UPLOAD_HEADERS,
        { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
      ])
        expect((await api(path, { headers }, owner.bindings)).status).toBe(401);
    }
    expect((await owner.request("/api/library")).status).toBe(200);
    expect(owner.fetchMock).toHaveBeenCalledTimes(1);
    expect((await owner.request("/api/library")).status).toBe(200);
    expect(owner.fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (
        await api(
          "/api/uploads",
          { method: "POST", headers: owner.headers },
          owner.bindings,
        )
      ).status,
    ).toBe(401);
    for (const method of ["PUT", "DELETE"])
      expect(
        (
          await api(
            `/api/library/artifacts/${item.session.artifactId}/share`,
            { method, headers: { ...UPLOAD_HEADERS, Origin: ORIGIN } },
            owner.bindings,
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await api(
          `/api/library/artifacts/${item.session.artifactId}`,
          { method: "DELETE", headers: UPLOAD_HEADERS },
          owner.bindings,
        )
      ).status,
    ).toBe(401);
  });

  it("rejects wrong email, issuer, audience, expiry, not-before and forged JWT signatures", async () => {
    const owner = await ownerFixture();
    const cases = [
      { email: "intruder@example.com" },
      { email: null },
      { aud: "wrong" },
      { iss: "https://wrong.cloudflareaccess.com" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { nbf: Math.floor(Date.now() / 1000) + 600 },
    ];
    for (const claims of cases) {
      expect(
        (
          await api(
            "/api/library",
            {
              headers: { "Cf-Access-Jwt-Assertion": await owner.token(claims) },
            },
            owner.bindings,
          )
        ).status,
      ).toBe(401);
    }
    const valid = await owner.token();
    const parts = valid.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({
        email: "owner@example.com",
        exp: 9999999999,
        iss: owner.bindings.PANES_ACCESS_ISSUER,
        aud: "panes-owner",
      }),
    ).toString("base64url");
    for (const token of [
      parts.join("."),
      "eyJhbGciOiJub25lIn0.e30.",
      "not-a-jwt",
    ])
      expect(
        (
          await api(
            "/api/library",
            { headers: { "Cf-Access-Jwt-Assertion": token } },
            owner.bindings,
          )
        ).status,
      ).toBe(401);
  });

  it("fails closed on missing/malformed Access policy and JWKS unavailability", async () => {
    const owner = await ownerFixture();
    for (const overrides of [
      { PANES_ACCESS_ISSUER: "" },
      { PANES_ACCESS_AUDIENCE: "" },
      { PANES_ACCESS_ALLOWED_EMAIL: "" },
    ])
      expect(
        (
          await api(
            "/api/library",
            { headers: owner.headers },
            { ...owner.bindings, ...overrides },
          )
        ).status,
      ).toBe(503);
    for (const issuer of [
      "http://test.cloudflareaccess.com",
      "https://evil.example",
      "https://x.cloudflareaccess.com/path",
      "https://x.cloudflareaccess.com?x",
      "https://user@x.cloudflareaccess.com",
      "https://x.cloudflareaccess.com:444",
    ])
      expect(
        readAccessConfig({
          ...env,
          ...owner.bindings,
          PANES_ACCESS_ISSUER: issuer,
        }),
      ).toBeUndefined();
    owner.fetchMock.mockRejectedValue(new TypeError("offline"));
    expect((await owner.request("/api/library")).status).toBe(503);
  });

  it("requires explicit dev mode and a loopback URL, not forged forwarding headers", async () => {
    for (const origin of [
      "http://localhost",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ]) {
      expect(
        (await api(`${origin}/api/library`, {}, { PANES_DEV_MODE: "true" }))
          .status,
      ).toBe(200);
      expect(
        (await api(`${origin}/api/library`, {}, { PANES_DEV_MODE: "false" }))
          .status,
      ).toBe(401);
    }
    for (const origin of [
      ORIGIN,
      "http://192.168.1.2",
      "http://localhost.evil.example",
    ])
      expect(
        (
          await api(
            `${origin}/api/library`,
            {
              headers: {
                "X-Forwarded-Host": "localhost",
                "X-Forwarded-For": "127.0.0.1",
              },
            },
            { PANES_DEV_MODE: "true" },
          )
        ).status,
      ).toBe(401);
  });

  it("requires exact same-origin CSRF on share, revoke and artifact deletion", async () => {
    const owner = await ownerFixture();
    const item = await uploaded();
    const path = `/api/library/artifacts/${item.session.artifactId}`;
    for (const [endpoint, method] of [
      [`${path}/share`, "PUT"],
      [`${path}/share`, "DELETE"],
      [path, "DELETE"],
    ]) {
      for (const origin of [
        undefined,
        "null",
        "https://evil.example",
        "https://panes.example.evil",
        "http://panes.example",
      ]) {
        const headers = new Headers({
          "Cf-Access-Jwt-Assertion": owner.headers["Cf-Access-Jwt-Assertion"],
        });
        if (origin) headers.set("Origin", origin);
        expect(
          (await api(endpoint!, { method: method!, headers }, owner.bindings))
            .status,
        ).toBe(403);
      }
      expect(
        (
          await owner.request(endpoint!, {
            method: method!,
            headers: { "Sec-Fetch-Site": "cross-site" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api(
            endpoint!,
            {
              method: method!,
              headers: {
                Origin: "null",
                "Cf-Access-Jwt-Assertion":
                  owner.headers["Cf-Access-Jwt-Assertion"],
              },
            },
            owner.bindings,
          )
        ).headers.get("Access-Control-Allow-Origin"),
      ).toBeNull();
    }
    expect(
      (
        await owner.request(`${path}/share`, {
          method: "PUT",
          body: JSON.stringify({
            versionId: item.session.uploadId,
            expiresInDays: null,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await owner.request(`${path}/share`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await owner.request(path, { method: "DELETE" })).status).toBe(204);
    expect(
      (
        await api(
          "http://localhost/api/library/artifacts/00000000-0000-0000-0000-000000000000",
          { method: "DELETE" },
          { PANES_DEV_MODE: "true" },
        )
      ).status,
    ).toBe(403);
  });

  it("redirects root, routes public SPA and authenticated inventory through assets, and retires old APIs", async () => {
    const response = await api("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/inventory`);
    expect((await api("/", { method: "HEAD" })).status).toBe(302);
    // The real asset binding is supplied by Vite/Workers Static Assets, not auth.
    expect((await api("/s/test")).status).toBe(503);
    expect((await api("/inventory")).status).toBe(401);
    const owner = await ownerFixture();
    const assetFetch = vi.fn(
      async () =>
        new Response("<!doctype html><main>SPA</main>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    const ASSETS: Fetcher = {
      fetch: assetFetch,
      connect() {
        throw new Error("Unexpected connect");
      },
    };
    for (const path of [
      "/s/public-token",
      "/inventory",
      "/inventory/artifacts/example",
    ]) {
      const spa = await api(
        path,
        { headers: owner.headers },
        { ...owner.bindings, ASSETS },
      );
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain("<main>SPA</main>");
      expect(spa.headers.get("Cache-Control")).toBe("no-store");
      expect(spa.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    expect((await api("/s/public-token", {}, { ASSETS })).status).toBe(200);
    expect((await api("/inventory", {}, { ASSETS })).status).toBe(401);
    expect(assetFetch).toHaveBeenCalledTimes(4);
    for (const path of [
      "/api/inventory",
      "/api/sync",
      "/api/artifacts",
      "/api/publications/token",
      "/creator/token",
    ])
      expect((await api(path)).status).toBe(404);
    const log = vi.spyOn(console, "error");
    await api("/api/previews/secret-read-capability/files/index.html");
    expect(log).not.toHaveBeenCalled();
  });
});
