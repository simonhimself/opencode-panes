import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker, { logUnexpectedError } from "../worker";

const ORIGIN = "https://panes.example";

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

describe("artifact API", () => {
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
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type",
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
