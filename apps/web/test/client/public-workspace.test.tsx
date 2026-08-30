import type { PublicPublicationResponse } from "@opencode-panes/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicWorkspace } from "../../src/public-workspace";

const workspace: PublicPublicationResponse = {
  artifact: {
    kind: "html",
    slug: "shared-preview",
    title: "Shared Preview",
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
});

describe("PublicWorkspace", () => {
  it("opens on the preview and keeps supporting actions secondary", async () => {
    await act(async () => {
      root.render(
        <PublicWorkspace token="public-token" workspace={workspace} />,
      );
    });

    const stage = container.querySelector(".creator-stage");
    const supporting = container.querySelector(".public-supporting-panel");
    const preview = container.querySelector<HTMLIFrameElement>(
      ".creator-preview-frame iframe",
    );
    const previewButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Preview",
    );
    const filesButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Files",
    );
    const download = container.querySelector<HTMLAnchorElement>("a[download]");

    expect(preview).not.toBeNull();
    expect(preview?.title).toBe("Browser artifact preview");
    expect(previewButton?.getAttribute("aria-pressed")).toBe("true");
    expect(filesButton?.getAttribute("aria-pressed")).toBe("false");
    expect(stage).not.toBeNull();
    expect(supporting).not.toBeNull();
    if (!stage || !supporting)
      throw new Error("Public workspace layout missing");
    expect(
      stage.compareDocumentPosition(supporting) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(container.textContent).toContain("Files");
    expect(container.textContent).toContain("Download ZIP");
    expect(download?.getAttribute("href")).toBe(
      "/api/publications/public-token/download.zip",
    );
    expect(container.textContent).toContain("Available until");
    expect(container.textContent).toContain("User-generated content.");
    expect(container.textContent).not.toMatch(
      /creator|owner|capability|lifecycle|publication/iu,
    );
  });

  it("retains file inspection from the public link", async () => {
    await act(async () => {
      root.render(
        <PublicWorkspace token="public-token" workspace={workspace} />,
      );
    });

    const filesButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Files",
    );
    await act(async () => {
      filesButton?.click();
    });

    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(container.textContent).toContain("index.html");
    expect(container.querySelector(".creator-stage")).not.toBeNull();
  });
});
