import type {
  CreatorWorkspaceResponse,
  PublicPublicationResponse,
} from "@opencode-panes/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatorWorkspace } from "../../src/creator-workspace";
import { PublicWorkspace } from "../../src/public-workspace";

const creatorWorkspace: CreatorWorkspaceResponse = {
  cloudArtifactId: "artifact-1",
  cloudProjectId: "project-1",
  creatorExpiresAt: "2026-09-01T00:00:00.000Z",
  kind: "html",
  revisions: [creatorRevision(1, "first"), creatorRevision(2, "second")],
  slug: "download-fixture",
  title: "Download Fixture",
};

const publicWorkspace: PublicPublicationResponse = {
  artifact: {
    kind: "html",
    slug: "download-fixture",
    title: "Download Fixture",
  },
  expiresAt: "2026-09-01T00:00:00.000Z",
  revision: {
    approvedOrigins: [],
    createdAt: "2026-08-29T12:00:00.000Z",
    files: [
      {
        byteSize: 6,
        kind: "file",
        mediaType: "text/html",
        path: "index.html",
      },
    ],
    preview: { adapter: "browser", entryPath: "index.html" },
    version: 2,
  },
  status: "active",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("workspace ZIP downloads", () => {
  it("tracks the selected Creator revision without eagerly fetching the ZIP", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response("preview");
      }),
    );

    await act(async () => {
      root.render(
        <CreatorWorkspace token="creator-token" workspace={creatorWorkspace} />,
      );
      await settle();
    });

    const link = () =>
      container.querySelector<HTMLAnchorElement>("a[download]");
    const select = container.querySelector(
      "select",
    ) as HTMLSelectElement | null;
    expect(link()?.getAttribute("href")).toBe(
      "/api/creator/creator-token/revisions/1/download.zip",
    );
    expect(requests.some((url) => url.includes("/download.zip"))).toBe(false);

    await act(async () => {
      if (!select) throw new Error("Creator revision select is missing");
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    expect(link()?.getAttribute("href")).toBe(
      "/api/creator/creator-token/revisions/2/download.zip",
    );
    expect(requests.some((url) => url.includes("/download.zip"))).toBe(false);
  });

  it("uses the public capability route without a version query or eager ZIP fetch", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response("preview");
      }),
    );

    await act(async () => {
      root.render(
        <PublicWorkspace token="public-token" workspace={publicWorkspace} />,
      );
      await settle();
    });

    const link = container.querySelector<HTMLAnchorElement>("a[download]");
    expect(link?.getAttribute("href")).toBe(
      "/api/publications/public-token/download.zip",
    );
    expect(link?.getAttribute("href")).not.toContain("version=");
    expect(requests.some((url) => url.includes("/download.zip"))).toBe(false);
  });
});

function creatorRevision(version: number, source: string) {
  return {
    approvedOrigins: [],
    createdAt: "2026-08-29T12:00:00.000Z",
    files: [
      {
        byteSize: source.length,
        kind: "file" as const,
        mediaType: "text/html",
        path: "index.html",
        sha256: "a".repeat(64),
      },
    ],
    id: `revision-${version}`,
    preview: { adapter: "browser" as const, entryPath: "index.html" },
    version,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}
