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

  it("selects synced Creator revisions and inspects nested text and binary files", async () => {
    const creatorResponse = {
      cloudArtifactId: "cloud-artifact-1",
      cloudProjectId: "cloud-project-1",
      creatorExpiresAt: "2026-09-28T10:00:00.000Z",
      revisions: [
        {
          approvedOrigins: [],
          createdAt: "2026-08-18T10:00:00.000Z",
          files: [
            {
              byteSize: 4,
              kind: "file" as const,
              mediaType: "application/octet-stream",
              path: "assets/data.bin",
              sha256: "a".repeat(64),
            },
            {
              byteSize: 18,
              kind: "file" as const,
              mediaType: "text/html",
              path: "index.html",
              sha256: "b".repeat(64),
            },
          ],
          id: "cloud-revision-2",
          preview: { adapter: "browser" as const, entryPath: "index.html" },
          version: 2,
        },
        {
          approvedOrigins: [],
          createdAt: "2026-08-17T10:00:00.000Z",
          files: [
            {
              byteSize: 31,
              kind: "file" as const,
              mediaType: "text/markdown",
              path: "docs/README.md",
              sha256: "c".repeat(64),
            },
          ],
          id: "cloud-revision-1",
          preview: {
            adapter: "renderer" as const,
            renderer: "markdown" as const,
            entryPath: "docs/README.md",
          },
          version: 1,
        },
      ],
      slug: "creator-test",
      title: "Creator test",
    };
    const fileRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/creator/creator-token")) {
          return new Response(JSON.stringify(creatorResponse));
        }
        fileRequests.push(url);
        if (url.includes("docs/README.md")) {
          return new Response("# <safe>");
        }
        if (url.includes("assets/data.bin")) {
          return new Response(Uint8Array.from([0, 255, 1, 254]));
        }
        return new Response("<h1>v2</h1>");
      }),
    );

    await act(async () => {
      root.render(<App route={{ kind: "creator", token: "creator-token" }} />);
      await settle();
    });
    const select = container.querySelector("select");
    expect(select?.textContent).toContain("v2");
    expect(select?.textContent).toContain("v1");
    expect(
      container.querySelector('iframe[sandbox="allow-scripts"]'),
    ).not.toBeNull();
    expect(container.innerHTML).not.toContain("object_key");

    await act(async () => {
      if (!select) return;
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    const filesButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Files",
    );
    await act(async () => {
      filesButton?.click();
      await settle();
    });
    expect(container.textContent).toContain("docs/README.md");
    expect(container.textContent).toContain("# <safe>");
    expect(fileRequests.some((url) => url.includes("docs/README.md"))).toBe(
      true,
    );

    await act(async () => {
      if (!select) return;
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    const binaryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Files",
    );
    expect(binaryButton).toBeDefined();
    const binaryFile = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "assets/data.bin",
    );
    await act(async () => {
      binaryFile?.click();
      await settle();
    });
    expect(container.textContent).toContain(
      "This binary file is not decoded as text.",
    );
    expect(container.textContent).toContain("Download data.bin");
    expect(fileRequests.some((url) => url.includes("assets/data.bin"))).toBe(
      false,
    );
  });

  it.each([
    [404, "Creator link not found", "This creator workspace does not exist."],
    [410, "Creator link expired", "This creator workspace has expired."],
  ] as const)(
    "maps Creator API %s to the existing status view",
    async (status, eyebrow, title) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: { code: "NOT_FOUND", message: "Creator link failed" },
              }),
              { status },
            ),
        ),
      );

      await act(async () => {
        root.render(
          <App route={{ kind: "creator", token: "creator-token" }} />,
        );
        await settle();
      });

      expect(container.textContent).toContain(eyebrow);
      expect(container.textContent).toContain(title);
    },
  );
});

async function settle(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}
