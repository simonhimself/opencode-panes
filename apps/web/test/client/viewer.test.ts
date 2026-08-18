import type { Artifact, Revision } from "@opencode-panes/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureWorkspaceAccess,
  clearStoredPublicUrl,
  createSerializedPoller,
  fetchPrivateWorkspace,
  fetchPublicArtifact,
  followCurrentRevision,
  getStoredPublicUrl,
  parseViewerRoute,
  publicUrlStorageKey,
  publishRevision,
  safeDownloadFilename,
  selectRevision,
  storePublicUrl,
  workspaceTokenStorageKey,
} from "../../src/viewer";

const ARTIFACT: Artifact = {
  createdAt: "2026-08-17T10:00:00.000Z",
  currentRevisionId: "revision-2",
  id: "artifact-1",
  title: "Test artifact",
  type: "markdown",
  updatedAt: "2026-08-17T10:01:00.000Z",
};

const REVISIONS: Revision[] = [
  {
    artifactId: ARTIFACT.id,
    createdAt: "2026-08-17T10:01:00.000Z",
    id: "revision-2",
    source: "second",
    version: 2,
  },
  {
    artifactId: ARTIFACT.id,
    createdAt: "2026-08-17T10:00:00.000Z",
    id: "revision-1",
    source: "first",
    version: 1,
  },
];

describe("viewer routes and workspace tokens", () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState({}, "", "/");
  });

  it("recognizes creator and public routes without accepting extra segments", () => {
    expect(parseViewerRoute("/artifacts/artifact-1")).toEqual({
      kind: "artifact",
      artifactId: "artifact-1",
    });
    expect(parseViewerRoute("/shared/public-token")).toEqual({
      kind: "shared",
      token: "public-token",
    });
    expect(parseViewerRoute("/artifacts/artifact-1/extra")).toEqual({
      kind: "not-found",
    });
  });

  it("captures the fragment token only for its artifact and removes the fragment", () => {
    sessionStorage.setItem("unrelated", "keep-me");
    history.replaceState(
      { preserved: true },
      "",
      "/artifacts/artifact-1?mode=preview#workspaceToken=workspace-one",
    );

    const access = captureWorkspaceAccess(
      "artifact-1",
      window.location,
      window.history,
      window.sessionStorage,
    );

    expect(access).toEqual({ status: "ready", token: "workspace-one" });
    expect(location.hash).toBe("");
    expect(location.search).toBe("?mode=preview");
    expect(sessionStorage.getItem(workspaceTokenStorageKey("artifact-1"))).toBe(
      "workspace-one",
    );
    expect(
      sessionStorage.getItem(workspaceTokenStorageKey("artifact-2")),
    ).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep-me");
  });

  it("reuses only a valid artifact-specific token and clears a malformed one", () => {
    sessionStorage.setItem(
      workspaceTokenStorageKey("artifact-1"),
      "saved-token",
    );
    history.replaceState({}, "", "/artifacts/artifact-1");
    expect(
      captureWorkspaceAccess("artifact-1", location, history, sessionStorage),
    ).toEqual({ status: "ready", token: "saved-token" });

    history.replaceState(
      {},
      "",
      "/artifacts/artifact-1#workspaceToken=bad%20token",
    );
    expect(
      captureWorkspaceAccess("artifact-1", location, history, sessionStorage),
    ).toEqual({ status: "invalid" });
    expect(
      sessionStorage.getItem(workspaceTokenStorageKey("artifact-1")),
    ).toBeNull();
  });
});

describe("viewer API requests", () => {
  it("starts private requests together and sends the bearer token to both", async () => {
    const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ init, url });
      const body = url.endsWith("/revisions")
        ? { artifactId: ARTIFACT.id, revisions: [REVISIONS[1]!] }
        : {
            artifact: ARTIFACT,
            revision: REVISIONS[0],
            viewerUrl: "https://panes.example/artifacts/artifact-1",
          };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const pending = fetchPrivateWorkspace(
      ARTIFACT.id,
      "workspace-token",
      fetcher,
    );
    expect(calls).toHaveLength(2);
    const workspace = await pending;

    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("Authorization")).toBe(
        "Bearer workspace-token",
      );
    }
    expect(workspace.revisions.map(({ id }) => id)).toEqual([
      "revision-2",
      "revision-1",
    ]);
  });

  it("does not send private authorization to the public endpoint", async () => {
    let headers = new Headers();
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          artifact: {
            id: ARTIFACT.id,
            title: ARTIFACT.title,
            type: ARTIFACT.type,
          },
          publishedAt: "2026-08-17T10:02:00.000Z",
          revision: REVISIONS[0],
        }),
      );
    };

    await fetchPublicArtifact("public-token", fetcher);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("publishes the explicitly selected revision with private authorization", async () => {
    let request: RequestInit | undefined;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = init;
      return new Response(null, { status: 204 });
    };

    await expect(
      publishRevision(ARTIFACT.id, "workspace-token", "revision-1", fetcher),
    ).resolves.toBeNull();
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      "Bearer workspace-token",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      revisionId: "revision-1",
    });
  });
});

describe("revision following", () => {
  const newest: Revision = {
    ...REVISIONS[0]!,
    createdAt: "2026-08-17T10:02:00.000Z",
    id: "revision-3",
    source: "third",
    version: 3,
  };

  it("moves to a new current revision while following latest", () => {
    const selection = selectRevision("revision-2", "revision-2");
    expect(
      followCurrentRevision(selection, newest.id, [newest, ...REVISIONS]),
    ).toEqual({ followLatest: true, revisionId: "revision-3" });
  });

  it("preserves an intentional historical selection until latest is selected", () => {
    const historical = selectRevision("revision-1", "revision-2");
    expect(
      followCurrentRevision(historical, newest.id, [newest, ...REVISIONS]),
    ).toEqual({ followLatest: false, revisionId: "revision-1" });

    const resumed = selectRevision(newest.id, newest.id);
    expect(resumed.followLatest).toBe(true);
  });
});

describe("serialized polling", () => {
  it("coalesces overlapping triggers and ignores a stale revision result", async () => {
    const first = deferred<number>();
    const load = vi
      .fn<(signal: AbortSignal) => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(2);
    const apply = vi.fn<(value: number) => void>();
    const poller = createSerializedPoller({
      apply,
      getSequence: (value) => value,
      initialSequence: 1,
      load,
    });

    const firstPoll = poller.pollNow();
    const overlappingPoll = poller.pollNow();
    expect(overlappingPoll).toBe(firstPoll);
    expect(load).toHaveBeenCalledTimes(1);

    first.resolve(3);
    await firstPoll;
    expect(apply).toHaveBeenLastCalledWith(3, expect.any(AbortSignal));

    await poller.pollNow();
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("aborts the active request and never applies it after stop", async () => {
    const pending = deferred<number>();
    let activeSignal: AbortSignal | undefined;
    const apply = vi.fn<(value: number) => void>();
    const poller = createSerializedPoller({
      apply,
      getSequence: (value) => value,
      initialSequence: 1,
      load: (signal) => {
        activeSignal = signal;
        return pending.promise;
      },
    });

    const poll = poller.pollNow();
    poller.stop();
    expect(activeSignal?.aborted).toBe(true);
    pending.resolve(2);
    await poll;
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("public URL session storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps only the active artifact/revision URL and clears it on unpublish", () => {
    const firstUrl = "https://panes.example/shared/first-token";
    const secondUrl = "https://panes.example/shared/second-token";
    storePublicUrl(ARTIFACT.id, "revision-1", firstUrl);
    expect(getStoredPublicUrl(ARTIFACT.id, "revision-1")).toBe(firstUrl);

    storePublicUrl(ARTIFACT.id, "revision-2", secondUrl);
    expect(getStoredPublicUrl(ARTIFACT.id, "revision-1")).toBeUndefined();
    expect(getStoredPublicUrl(ARTIFACT.id, "revision-2")).toBe(secondUrl);

    clearStoredPublicUrl(ARTIFACT.id);
    expect(getStoredPublicUrl(ARTIFACT.id, "revision-2")).toBeUndefined();
  });

  it("rejects malformed stored URLs", () => {
    sessionStorage.setItem(
      publicUrlStorageKey(ARTIFACT.id, "revision-1"),
      "javascript:alert(1)",
    );
    expect(getStoredPublicUrl(ARTIFACT.id, "revision-1")).toBeUndefined();
    expect(
      sessionStorage.getItem(publicUrlStorageKey(ARTIFACT.id, "revision-1")),
    ).toBeNull();
  });
});

describe("safe download filenames", () => {
  it.each([
    ["My Demo / ../ Final", "html", "my-demo-final.html"],
    ["Component", "react", "component.tsx"],
    ["Flow chart", "mermaid", "flow-chart.mmd"],
    ["Read me", "markdown", "read-me.md"],
    ["Logo", "svg", "logo.svg"],
    ["CON", "code", "artifact.txt"],
  ] as const)(
    "creates a safe type-aware name for %s",
    (title, type, expected) => {
      expect(safeDownloadFilename(title, type)).toBe(expected);
    },
  );
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
