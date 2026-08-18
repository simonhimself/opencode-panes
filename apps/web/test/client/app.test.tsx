import type { Artifact, Revision } from "@opencode-panes/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, SourceCode } from "../../src/app";
import { publicUrlStorageKey } from "../../src/viewer";

const ARTIFACT: Artifact = {
  createdAt: "2026-08-17T10:00:00.000Z",
  currentRevisionId: "revision-2",
  id: "artifact-1",
  title: "Release notes",
  type: "markdown",
  updatedAt: "2026-08-17T10:01:00.000Z",
};

const REVISIONS: Revision[] = [
  {
    artifactId: ARTIFACT.id,
    createdAt: "2026-08-17T10:01:00.000Z",
    id: "revision-2",
    source: "# Current",
    version: 2,
  },
  {
    artifactId: ARTIFACT.id,
    createdAt: "2026-08-17T10:00:00.000Z",
    id: "revision-1",
    source: "# Historical",
    version: 1,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("artifact workspace", () => {
  it("preserves raw source as text in code mode", () => {
    const source = '<script>alert("raw")</script>\n# heading';
    const markup = renderToStaticMarkup(
      <SourceCode source={source} type="markdown" />,
    );

    expect(markup).toContain(
      "&lt;script&gt;alert(&quot;raw&quot;)&lt;/script&gt;",
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("# heading");
  });

  it("publishes the selected historical revision and shows the returned URL", async () => {
    const requests: Array<{ init: RequestInit | undefined; url: string }> = [];
    let publishCount = 0;
    const fetcher = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        requests.push({ init, url });
        if (url.endsWith("/publish")) {
          publishCount += 1;
          if (publishCount > 1) return new Response(null, { status: 204 });
          return new Response(
            JSON.stringify({
              artifactId: ARTIFACT.id,
              createdAt: "2026-08-17T10:02:00.000Z",
              publicUrl: "https://panes.example/shared/public-token",
              revisionId: "revision-1",
              version: 1,
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/unpublish")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/revisions")) {
          return new Response(
            JSON.stringify({ artifactId: ARTIFACT.id, revisions: REVISIONS }),
          );
        }
        return new Response(
          JSON.stringify({
            artifact: ARTIFACT,
            revision: REVISIONS[0],
            viewerUrl: "https://panes.example/artifacts/artifact-1",
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);

    await act(async () => {
      root.render(
        <App
          route={{ artifactId: ARTIFACT.id, kind: "artifact" }}
          workspaceAccess={{ status: "ready", token: "workspace-token" }}
        />,
      );
      await settle();
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    await act(async () => {
      if (!select) return;
      select.value = "revision-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const publishButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Publish v1",
    );
    expect(publishButton).toBeDefined();
    await act(async () => {
      publishButton?.click();
      await settle();
    });

    const publishRequest = requests.find(({ url }) => url.endsWith("/publish"));
    expect(JSON.parse(String(publishRequest?.init?.body))).toEqual({
      revisionId: "revision-1",
    });
    expect(container.textContent).toContain("Version 1 is public.");
    expect(container.textContent).toContain(
      "https://panes.example/shared/public-token",
    );

    await act(async () => {
      publishButton?.click();
      await settle();
    });
    expect(container.textContent).toContain("Version 1 is already published.");
    expect(container.textContent).toContain("recovered from this tab");
    expect(container.textContent).toContain(
      "https://panes.example/shared/public-token",
    );
    expect(
      sessionStorage.getItem(publicUrlStorageKey(ARTIFACT.id, "revision-1")),
    ).toBe("https://panes.example/shared/public-token");

    const unpublishButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Unpublish",
    );
    await act(async () => {
      unpublishButton?.click();
      await settle();
    });
    expect(container.textContent).toContain("Public access is now revoked.");
    expect(
      sessionStorage.getItem(publicUrlStorageKey(ARTIFACT.id, "revision-1")),
    ).toBeNull();
  });

  it("shows the honest same-revision fallback when no public URL is stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/publish")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/revisions")) {
          return new Response(
            JSON.stringify({ artifactId: ARTIFACT.id, revisions: REVISIONS }),
          );
        }
        return new Response(
          JSON.stringify({
            artifact: ARTIFACT,
            revision: REVISIONS[0],
            viewerUrl: "https://panes.example/artifacts/artifact-1",
          }),
        );
      }),
    );

    await act(async () => {
      root.render(
        <App
          route={{ artifactId: ARTIFACT.id, kind: "artifact" }}
          workspaceAccess={{ status: "ready", token: "workspace-token" }}
        />,
      );
      await settle();
    });
    const publishButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Publish v2",
    );
    await act(async () => {
      publishButton?.click();
      await settle();
    });

    expect(container.textContent).toContain("Version 2 is already published.");
    expect(container.textContent).toContain("cannot return or reconstruct");
    expect(container.querySelector(".action-notice a")).toBeNull();
  });

  it("keeps the public workspace read-only and labels user-generated content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              artifact: {
                id: ARTIFACT.id,
                title: ARTIFACT.title,
                type: ARTIFACT.type,
              },
              publishedAt: "2026-08-17T10:02:00.000Z",
              revision: REVISIONS[0],
            }),
          ),
      ),
    );

    await act(async () => {
      root.render(<App route={{ kind: "shared", token: "public-token" }} />);
      await settle();
    });

    expect(container.textContent).toContain("User-generated content.");
    expect(container.textContent).toContain("Copy link");
    expect(container.textContent).not.toContain("Publish v");
    expect(container.textContent).not.toContain("Unpublish");
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}
