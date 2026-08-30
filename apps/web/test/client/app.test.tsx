import type {
  Artifact,
  CreatorWorkspaceResponse,
  Revision,
} from "@opencode-panes/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, SourceCode } from "../../src/app";
import { CreatorWorkspace } from "../../src/creator-workspace";
import { parseViewerRoute } from "../../src/viewer";

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
  it("keeps local-first publication routes separate from legacy shared routes", () => {
    expect(parseViewerRoute("/shared/legacy-token")).toEqual({
      kind: "shared",
      token: "legacy-token",
    });
    expect(parseViewerRoute("/published/local-first-token")).toEqual({
      kind: "published",
      token: "local-first-token",
    });
    expect(parseViewerRoute("/inventory")).toEqual({ kind: "inventory" });
  });

  it("renders a grouped inventory and copies a recoverable URL", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              projects: [
                {
                  projectId: "project-demo",
                  artifacts: [
                    {
                      artifactId: "artifact-demo",
                      slug: "demo",
                      title: "Demo artifact",
                      kind: null,
                      lifecycleState: "active",
                      revisionCount: 2,
                      storageBytes: 2048,
                      lastSyncedAt: "2026-08-29T12:00:00.000Z",
                      creatorLink: {
                        status: "active",
                        expiresAt: "2026-09-28T12:00:00.000Z",
                      },
                      publication: {
                        status: "active",
                        revisionVersion: 2,
                        expiresAt: "2026-09-05T12:00:00.000Z",
                        publicUrl:
                          "https://panes.example/published/public-token",
                      },
                      revisions: [
                        {
                          version: 2,
                          createdAt: "2026-08-29T12:00:00.000Z",
                        },
                        {
                          version: 1,
                          createdAt: "2026-08-28T12:00:00.000Z",
                        },
                      ],
                      warnings: [
                        "The active public URL could not be recovered.",
                      ],
                    },
                  ],
                },
              ],
            }),
          ),
      ),
    );

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });

    expect(container.textContent).toContain("project-demo");
    expect(container.textContent).toContain("Demo artifact");
    expect(container.textContent).toContain(
      "The active public URL could not be recovered.",
    );
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy public URL",
    );
    await act(async () => {
      copy?.click();
      await settle();
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://panes.example/published/public-token",
    );
    expect(container.textContent).toContain("public URL copied");
    expect(container.textContent).not.toContain("owner_token_hash");
    expect(container.textContent).not.toContain("read-only");
  });

  it("puts current Artifacts before collapsed Legacy history and Manage controls", async () => {
    const payload = {
      projects: [
        {
          projectId: "project-current",
          artifacts: [
            {
              artifactId: "artifact-current",
              slug: "current",
              title: "Current artifact",
              kind: null,
              lifecycleState: "active",
              revisionCount: 1,
              storageBytes: 10,
              lastSyncedAt: "2026-08-29T12:00:00.000Z",
              creatorLink: {
                status: "active",
                expiresAt: "2026-09-28T12:00:00.000Z",
              },
              publication: {
                status: "none",
                revisionVersion: null,
                expiresAt: null,
              },
              revisions: [
                { version: 1, createdAt: "2026-08-29T12:00:00.000Z" },
              ],
              warnings: [],
            },
          ],
        },
      ],
      legacyArtifacts: [
        {
          artifactId: "legacy-history",
          title: "Archived artifact",
          type: "html",
          revisionCount: 3,
          storageBytes: 128,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-03T10:00:00.000Z",
          privateExpiresAt: "2026-08-31T10:00:00.000Z",
          status: "active",
          publicationStatus: "none",
          publicationExpiresAt: null,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload))),
    );

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });

    const project = container.querySelector(".inventory-project");
    const legacyHistory = container.querySelector<HTMLDetailsElement>(
      ".inventory-legacy-history",
    );
    expect(project?.textContent).toContain("project-current");
    expect(legacyHistory).not.toBeNull();
    expect(project?.compareDocumentPosition(legacyHistory as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(legacyHistory?.open).toBe(false);
    expect(legacyHistory?.querySelector("summary")?.textContent).toContain(
      "1 artifact",
    );
    expect(legacyHistory?.querySelector("summary")?.textContent).toContain(
      "read-only",
    );

    const currentCard = container.querySelector(
      '[data-artifact-id="artifact-current"]',
    );
    expect(currentCard).not.toBeNull();
    const manage =
      currentCard?.querySelector<HTMLDetailsElement>(".inventory-manage");
    expect(manage?.open).toBe(false);
    expect(manage?.querySelector("button")?.textContent).toContain(
      "Rotate Creator link",
    );
    expect(currentCard?.textContent).toContain("Extend publication");
    expect(currentCard?.textContent).toContain("Republish");
  });

  it("renders Legacy inventory as read-only with deletion confirmation only", async () => {
    const payload = {
      projects: [],
      legacyArtifacts: [
        {
          artifactId: "legacy-artifact",
          title: "Archived artifact",
          type: "html",
          revisionCount: 3,
          storageBytes: 128,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-03T10:00:00.000Z",
          privateExpiresAt: "2026-08-31T10:00:00.000Z",
          status: "active",
          publicationStatus: "none",
          publicationExpiresAt: null,
        },
      ],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetcher);

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });

    const legacyHistory = container.querySelector<HTMLDetailsElement>(
      ".inventory-legacy-history",
    );
    expect(legacyHistory?.open).toBe(false);
    await act(async () => {
      legacyHistory?.querySelector("summary")?.click();
      await settle();
    });
    const manage =
      legacyHistory?.querySelector<HTMLDetailsElement>(".inventory-manage");
    expect(manage?.open).toBe(false);
    await act(async () => {
      manage?.querySelector("summary")?.click();
      await settle();
    });

    expect(container.textContent).toContain("Read-only cloud history");
    expect(container.textContent).toContain("Archived artifact");
    expect(container.textContent).toContain("128 B");
    expect(container.textContent).toContain("Updated");
    expect(container.textContent).toContain(
      "cannot be edited, published, or extended",
    );
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Delete Legacy artifact",
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Rotate Creator link");
    expect(container.textContent).not.toContain("Republish");
    expect(container.textContent).not.toContain("Extend publication");
  });

  it("issues Legacy adoption codes through the Access-protected inventory action", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const payload = {
      projects: [],
      legacyArtifacts: [
        {
          artifactId: "legacy-adoption-client",
          title: "Client adoption fixture",
          type: "html",
          revisionCount: 2,
          storageBytes: 128,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-03T10:00:00.000Z",
          privateExpiresAt: "2026-09-01T10:00:00.000Z",
          status: "active",
          publicationStatus: "none",
          publicationExpiresAt: null,
        },
      ],
    };
    let postCount = 0;
    let releaseFirstIssue!: () => void;
    const firstIssueReleased = new Promise<void>(
      (resolve) => (releaseFirstIssue = resolve),
    );
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== "POST")
          return new Response(JSON.stringify(payload));
        postCount += 1;
        if (postCount === 1) {
          await firstIssueReleased;
          return new Response(
            JSON.stringify({
              operation: "adoption-code-issued",
              artifactId: "legacy-adoption-client",
              code: "panes-adopt-legacy-11111111111111111111111111111111",
              expiresAt: "2026-08-31T10:00:00.000Z",
              source: {
                title: "Client adoption fixture",
                type: "html",
                revisionVersion: 2,
              },
            }),
          );
        }
        if (postCount === 2) {
          return new Response(
            JSON.stringify({
              operation: "adoption-code-issued",
              artifactId: "legacy-adoption-client",
              code: "panes-adopt-legacy-22222222222222222222222222222222",
              expiresAt: "2026-08-31T11:00:00.000Z",
              source: {
                title: "Client adoption fixture",
                type: "html",
                revisionVersion: 2,
              },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: "SERVICE_UNAVAILABLE", message: "Issue failed" },
          }),
          { status: 503 },
        );
      },
    );
    vi.stubGlobal("fetch", fetcher);

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });
    const legacyHistory = container.querySelector<HTMLDetailsElement>(
      ".inventory-legacy-history",
    );
    await act(async () => {
      legacyHistory?.querySelector("summary")?.click();
      await settle();
      legacyHistory
        ?.querySelector<HTMLElement>(".inventory-manage summary")
        ?.click();
      await settle();
    });
    const issue = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Export / adopt locally",
    );
    expect(issue).not.toBeUndefined();
    await act(async () => {
      issue?.click();
      await settle();
    });
    expect(issue?.textContent).toBe("Issuing…");
    releaseFirstIssue();
    await act(async () => {
      await settle();
    });
    expect(container.textContent).toContain("Copy this one-time code now");
    expect(container.textContent).toContain("v2");
    expect(container.textContent).toContain("Expires Aug 31, 2026");
    expect(container.textContent).toContain(
      "panes-adopt-legacy-11111111111111111111111111111111",
    );
    expect(container.textContent).not.toContain("ownerCredential");
    expect(container.textContent).not.toContain("source bytes");
    expect(container.textContent).not.toContain("Owner credential");
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy code",
    );
    await act(async () => {
      copy?.click();
      await settle();
    });
    expect(writeText).toHaveBeenCalledWith(
      "panes-adopt-legacy-11111111111111111111111111111111",
    );

    await act(async () => {
      issue?.click();
      await settle();
    });
    expect(container.textContent).not.toContain(
      "panes-adopt-legacy-11111111111111111111111111111111",
    );
    expect(container.textContent).toContain(
      "panes-adopt-legacy-22222222222222222222222222222222",
    );
    await act(async () => {
      issue?.click();
      await settle();
    });
    expect(container.textContent).toContain("Issue failed");
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/inventory/legacy/artifacts/legacy-adoption-client/adoption-code",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(postCount).toBe(3);
    expect(String(fetcher.mock.calls[1]?.[0])).not.toContain("source");
  });

  it("requires the exact reconnect confirmation and keeps the issued code ephemeral", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const payload = {
      projects: [
        {
          projectId: "project-demo",
          artifacts: [
            {
              artifactId: "artifact-demo",
              slug: "demo",
              title: "Demo artifact",
              kind: null,
              lifecycleState: "active",
              revisionCount: 1,
              storageBytes: 10,
              lastSyncedAt: "2026-08-29T12:00:00.000Z",
              creatorLink: {
                status: "active",
                expiresAt: "2026-09-28T12:00:00.000Z",
              },
              publication: {
                status: "none",
                revisionVersion: null,
                expiresAt: null,
              },
              revisions: [
                { version: 1, createdAt: "2026-08-29T12:00:00.000Z" },
              ],
              warnings: [],
            },
          ],
        },
      ],
    };
    const requests: Array<{ method: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              cloudArtifactId: "artifact-demo",
              reconnectCode: "panes-reconnect-0123456789abcdef0123456789abcdef",
              expiresAt: "2026-08-29T12:10:00.000Z",
            }),
          );
        }
        return new Response(JSON.stringify(payload));
      }),
    );

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });
    const manage =
      container.querySelector<HTMLDetailsElement>(".inventory-manage");
    await act(async () => {
      manage?.querySelector("summary")?.click();
      await settle();
    });
    const input = container.querySelector<HTMLInputElement>(
      "#reconnect-artifact-demo",
    );
    const issue = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Issue reconnect code",
    );
    expect(issue?.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "RECOVER OWNER CREDENTIAL");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(issue?.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(
        input,
        "RECOVER OWNER CREDENTIAL FOR ARTIFACT artifact-demo: REDEMPTION REPLACES THE CURRENT OWNER CREDENTIAL (Demo artifact)",
      );
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(issue?.disabled).toBe(false);
    await act(async () => {
      issue?.click();
      await settle();
    });
    expect(container.textContent).toContain("Copy this code now");
    expect(container.textContent).toContain(
      "panes-reconnect-0123456789abcdef0123456789abcdef",
    );
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy reconnect code",
    );
    await act(async () => {
      copy?.click();
      await settle();
    });
    expect(writeText).toHaveBeenCalledWith(
      "panes-reconnect-0123456789abcdef0123456789abcdef",
    );
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(requests[1]?.body).toContain("REDEMPTION REPLACES");
  });

  it("shows a rotated Creator URL only after rotation and explains deletion consequences", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const payload = {
      projects: [
        {
          projectId: "project-demo",
          artifacts: [
            {
              artifactId: "artifact-demo",
              slug: "demo",
              title: "Demo artifact",
              kind: null,
              lifecycleState: "active",
              revisionCount: 1,
              storageBytes: 10,
              lastSyncedAt: "2026-08-29T12:00:00.000Z",
              creatorLink: {
                status: "active",
                expiresAt: "2026-09-28T12:00:00.000Z",
              },
              publication: {
                status: "none",
                revisionVersion: null,
                expiresAt: null,
              },
              revisions: [
                { version: 1, createdAt: "2026-08-29T12:00:00.000Z" },
              ],
              warnings: [],
            },
          ],
        },
      ],
    };
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ method: init?.method ?? "GET", url });
        if (url.endsWith("/creator/rotate")) {
          return new Response(
            JSON.stringify({
              cloudArtifactId: "artifact-demo",
              creatorUrl: "https://panes.example/creator/rotated-secret",
              creatorExpiresAt: "2026-09-28T12:00:00.000Z",
            }),
          );
        }
        return new Response(JSON.stringify(payload));
      }),
    );

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });
    const manage =
      container.querySelector<HTMLDetailsElement>(".inventory-manage");
    await act(async () => {
      manage?.querySelector("summary")?.click();
      await settle();
    });
    expect(container.textContent).toContain(
      "permanently remove Creator/public links, cloud metadata, and stored bytes",
    );
    expect(container.textContent).toContain(
      "Canonical local files remain unchanged",
    );
    expect(container.textContent).not.toContain("rotated-secret");

    const rotate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Rotate Creator link",
    );
    await act(async () => {
      rotate?.click();
      await settle();
    });
    expect(container.textContent).toContain("rotated-secret");
    expect(container.textContent).toContain("Expires Sep 28, 2026");
    expect(container.textContent).toContain("(30 days)");
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy Creator URL",
    );
    expect(copy).not.toBeUndefined();
    await act(async () => {
      copy?.click();
      await settle();
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://panes.example/creator/rotated-secret",
    );
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("requires exact deletion confirmation and refreshes after an inventory action", async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = [];
    const payload = {
      projects: [
        {
          projectId: "project-demo",
          artifacts: [
            {
              artifactId: "artifact-demo",
              slug: "demo",
              title: "Demo artifact",
              kind: null,
              lifecycleState: "active",
              revisionCount: 1,
              storageBytes: 10,
              lastSyncedAt: "2026-08-29T12:00:00.000Z",
              creatorLink: {
                status: "active",
                expiresAt: "2026-09-28T12:00:00.000Z",
              },
              publication: {
                status: "active",
                revisionVersion: 1,
                expiresAt: "2026-09-05T12:00:00.000Z",
                publicUrl: null,
              },
              revisions: [
                { version: 1, createdAt: "2026-08-29T12:00:00.000Z" },
              ],
              warnings: [],
            },
          ],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          method: init?.method ?? "GET",
          url,
          ...(init?.body ? { body: String(init.body) } : {}),
        });
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        return new Response(JSON.stringify(payload));
      }),
    );

    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });

    const manage =
      container.querySelector<HTMLDetailsElement>(".inventory-manage");
    await act(async () => {
      manage?.querySelector("summary")?.click();
      await settle();
    });
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete cloud copy",
    );
    expect(deleteButton?.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>(
      "#delete-artifact-demo",
    );
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "DELETE CLOUD COPY OF Demo artifact");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(deleteButton?.disabled).toBe(false);

    await act(async () => {
      deleteButton?.click();
      await settle();
    });
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(
      1,
    );
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(2);
    expect(requests.find(({ method }) => method === "DELETE")?.body).toBe(
      JSON.stringify({ confirmation: "DELETE CLOUD COPY OF Demo artifact" }),
    );
  });

  it.each([
    [401, "Inventory access denied", "approved Access identity"],
    [503, "Inventory unavailable", "could not be loaded"],
  ] as const)(
    "renders inventory failure state %s",
    async (status, eyebrow, title) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: { code: "UNAUTHORIZED", message: "generic" },
              }),
              {
                status,
              },
            ),
        ),
      );
      await act(async () => {
        root.render(<App route={{ kind: "inventory" }} />);
        await settle();
      });
      expect(container.textContent).toContain(eyebrow);
      expect(container.textContent).toContain(title);
      expect(container.textContent).not.toContain("generic");
    },
  );

  it("renders an empty inventory without lifecycle controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ projects: [] }))),
    );
    await act(async () => {
      root.render(<App route={{ kind: "inventory" }} />);
      await settle();
    });
    expect(container.textContent).toContain("Your cloud shelf is clear.");
    expect(container.textContent).not.toContain("Publish");
    expect(container.textContent).not.toContain("Delete");
  });

  it("keeps advanced Creator share controls behind Manage share", () => {
    const workspace: CreatorWorkspaceResponse = {
      cloudArtifactId: "artifact-demo",
      cloudProjectId: "project-demo",
      slug: "demo",
      title: "Demo artifact",
      creatorExpiresAt: "2026-09-28T12:00:00.000Z",
      revisions: [
        {
          id: "revision-demo",
          version: 1,
          preview: { adapter: "browser", entryPath: "index.html" },
          approvedOrigins: [],
          files: [
            {
              kind: "file",
              path: "index.html",
              sha256: "a".repeat(64),
              byteSize: 10,
              mediaType: "text/html",
            },
          ],
          createdAt: "2026-08-29T12:00:00.000Z",
        },
      ],
      publication: {
        id: "publication-demo",
        artifactId: "artifact-demo",
        revisionVersion: 1,
        durationDays: 7,
        status: "active",
        createdAt: "2026-08-29T12:00:00.000Z",
        expiresAt: "2026-09-05T12:00:00.000Z",
        publicUrl: "https://panes.example/published/secret-token",
      },
      publicationHistory: [],
    };
    const markup = renderToStaticMarkup(
      <CreatorWorkspace token="creator-token" workspace={workspace} />,
    );
    expect(markup).not.toContain("authenticated cloud inventory");
    expect(markup).toContain("Manage share");
    expect(markup).toContain("Extend by 7 days");
    expect(markup).toContain("Republish v1");
    expect(markup).not.toContain(
      "https://panes.example/published/secret-token",
    );
    expect(markup).not.toContain("Copy public URL");
  });
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
              legacy: { readOnly: true },
            }),
          ),
      ),
    );

    await act(async () => {
      root.render(<App route={{ kind: "shared", token: "public-token" }} />);
      await settle();
    });

    expect(container.textContent).toContain("User-generated content.");
    expect(container.textContent).toContain("LEGACY · READ-ONLY");
    expect(container.textContent).toContain("Copy link");
    expect(container.textContent).not.toContain("Publish v");
    expect(container.textContent).not.toContain("Unpublish");
  });

  it("shows private Legacy metadata and omits publication controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
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
            legacy: {
              readOnly: true,
              migratedAt: "2026-08-17T10:00:00.000Z",
              privateExpiresAt: "2026-09-16T10:00:00.000Z",
            },
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

    expect(container.textContent).toContain("LEGACY · READ-ONLY");
    expect(container.textContent).toContain("EXPIRES");
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
    const durationSelect = container.querySelectorAll("select")[1];
    expect(
      [...((durationSelect?.options ?? []) as HTMLOptionsCollection)].map(
        (option) => option.value,
      ),
    ).toEqual(["1", "7", "30"]);
    expect(durationSelect?.value).toBe("7");
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

  it("renders a public publication without private actions or eager binary fetches", async () => {
    const fileRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/publications/public-token")) {
          return new Response(
            JSON.stringify({
              artifact: { slug: "public-demo", title: "Public demo" },
              expiresAt: "2026-09-05T12:00:00.000Z",
              revision: {
                approvedOrigins: [],
                createdAt: "2026-08-29T12:00:00.000Z",
                files: [
                  {
                    byteSize: 18,
                    kind: "file",
                    mediaType: "text/html",
                    path: "index.html",
                  },
                  {
                    byteSize: 4,
                    kind: "file",
                    mediaType: "application/octet-stream",
                    path: "assets/data.bin",
                  },
                ],
                preview: { adapter: "browser", entryPath: "index.html" },
                version: 3,
              },
              status: "active",
            }),
          );
        }
        fileRequests.push(url);
        return new Response("<h1>Public</h1>");
      }),
    );

    await act(async () => {
      root.render(<App route={{ kind: "published", token: "public-token" }} />);
      await settle();
    });

    expect(container.textContent).toContain("Public demo");
    expect(container.textContent).toContain("Available until");
    expect(container.textContent).not.toContain("Revision");
    expect(container.textContent).not.toContain("Publish");
    expect(container.textContent).not.toContain("Unpublish");
    expect(container.textContent).not.toContain("Creator");
    expect(container.querySelectorAll("select")).toHaveLength(0);

    const filesButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Files",
    );
    await act(async () => {
      filesButton?.click();
      await settle();
    });
    const binaryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "assets/data.bin",
    );
    await act(async () => {
      binaryButton?.click();
      await settle();
    });
    expect(container.textContent).toContain("Download data.bin");
    expect(fileRequests.some((url) => url.includes("assets/data.bin"))).toBe(
      false,
    );
  });

  it.each([
    [404, "Publication not found", "This publication does not exist."],
    [410, "Publication inactive", "This publication is no longer active."],
  ] as const)(
    "keeps public publication status %s in the status view",
    async (status, eyebrow, title) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  code: "NOT_FOUND",
                  message: "Publication unavailable",
                },
              }),
              { status },
            ),
        ),
      );

      await act(async () => {
        root.render(
          <App route={{ kind: "published", token: "public-token" }} />,
        );
        await settle();
      });

      expect(container.textContent).toContain(eyebrow);
      expect(container.textContent).toContain(title);
      expect(container.textContent).not.toContain("public-token");
    },
  );

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
