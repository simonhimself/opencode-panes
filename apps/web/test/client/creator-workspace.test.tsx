import type {
  CreatorWorkspaceResponse,
  Publication,
} from "@opencode-panes/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatorWorkspace } from "../../src/creator-workspace";

const PUBLIC_URL = "https://panes.example/published/public-token";
const publication: Publication = {
  artifactId: "artifact-creator-test",
  createdAt: "2026-08-30T12:00:00.000Z",
  durationDays: 7,
  expiresAt: "2026-09-06T12:00:00.000Z",
  id: "publication-creator-test",
  publicUrl: PUBLIC_URL,
  revisionVersion: 1,
  status: "active",
};

const workspace: CreatorWorkspaceResponse = {
  cloudArtifactId: "artifact-creator-test",
  cloudProjectId: "project-creator-test",
  creatorExpiresAt: "2026-09-28T12:00:00.000Z",
  revisions: [
    {
      approvedOrigins: [],
      createdAt: "2026-08-30T12:00:00.000Z",
      files: [
        {
          byteSize: 14,
          kind: "file",
          mediaType: "text/html",
          path: "index.html",
          sha256: "a".repeat(64),
        },
      ],
      id: "revision-creator-test",
      preview: { adapter: "browser", entryPath: "index.html" },
      version: 1,
    },
  ],
  slug: "creator-test",
  title: "Creator test",
};

const workspaceWithActiveShare: CreatorWorkspaceResponse = {
  ...workspace,
  publication: { ...publication, publicUrl: undefined },
  revisions: [
    workspace.revisions[0]!,
    {
      ...workspace.revisions[0]!,
      id: "revision-creator-test-2",
      version: 2,
    },
  ],
};

const workspaceWithExpiredShare: CreatorWorkspaceResponse = {
  ...workspace,
  publication: null,
  publicationHistory: [{ ...publication, status: "expired" }],
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

describe("Creator sharing", () => {
  it("confirms one selected Revision, returns its link, and supports Copy/Open", async () => {
    const confirm = vi.fn(() => true);
    const writeText = vi.fn(async () => undefined);
    const requests: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (init?.method === "POST") {
          return new Response(JSON.stringify(publication), { status: 201 });
        }
        if (String(input).endsWith("/share")) {
          return new Response(JSON.stringify(publication));
        }
        return new Response(JSON.stringify(workspaceWithActiveShare));
      }),
    );

    await act(async () => {
      root.render(
        <CreatorWorkspace token="creator-token" workspace={workspace} />,
      );
    });

    const share = button("Share this version");
    expect(share).not.toBeNull();
    await act(async () => {
      share?.click();
      await settle();
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requests[0]).toContain("POST /api/creator/creator-token/share");
    expect(requests[0]).not.toContain("durationDays=undefined");
    expect(container.textContent).toContain("Revision v1 shared");
    expect(container.textContent).toContain(PUBLIC_URL);
    const open = container.querySelector<HTMLAnchorElement>(
      `a[href="${PUBLIC_URL}"]`,
    );
    expect(open?.target).toBe("_blank");
    expect(container.textContent).toContain("Copy link");

    await act(async () => {
      button("Copy link")?.click();
      await settle();
    });
    expect(writeText).toHaveBeenCalledWith(PUBLIC_URL);
  });

  it("does not publish when public-sharing confirmation is declined", async () => {
    const confirm = vi.fn(() => false);
    const fetch = vi.fn(async () => new Response(JSON.stringify(workspace)));
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("fetch", fetch);

    await act(async () => {
      root.render(
        <CreatorWorkspace token="creator-token" workspace={workspace} />,
      );
      await settle();
    });
    await act(async () => button("Share this version")?.click());

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows Copy/Open for the active Revision and an update action for another Revision", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).endsWith("/share") &&
          (init?.method ?? "GET") === "GET"
        ) {
          return new Response(JSON.stringify(publication));
        }
        return new Response(JSON.stringify(workspaceWithActiveShare));
      }),
    );
    vi.stubGlobal("confirm", confirm);
    await act(async () => {
      root.render(
        <CreatorWorkspace
          token="creator-token"
          workspace={workspaceWithActiveShare}
        />,
      );
      await settle();
    });

    expect(button("Share again")).toBeNull();
    expect(button("Share this version")).toBeNull();
    expect(container.textContent).toContain("Copy link");
    expect(container.textContent).toContain("Open link");
    expect(
      container.querySelector('[aria-label="Active public share"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain(
      "authenticated cloud inventory",
    );
    const management = container.querySelector<HTMLDetailsElement>(
      ".publication-management",
    );
    expect(management?.querySelector("summary")?.textContent).toBe(
      "Manage share",
    );
    expect(management?.open).toBe(false);
    expect(management?.textContent).toContain("Extend by 7 days");
    const select = container.querySelector(
      'select[aria-label="Select synced revision"]',
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    await act(async () => {
      if (!select) throw new Error("Revision select is missing");
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    expect(button("Update shared version")).not.toBeNull();
    expect(button("Share again")).toBeNull();
    await act(async () => button("Update shared version")?.click());
    expect(confirm).toHaveBeenCalledWith(
      "Update the public link to Revision v2? The existing Public link and expiry will be preserved.",
    );
  });

  it("presents Share again and duration choice after an expired Share", async () => {
    await act(async () => {
      root.render(
        <CreatorWorkspace
          token="creator-token"
          workspace={workspaceWithExpiredShare}
        />,
      );
    });

    expect(button("Share again")).not.toBeNull();
    expect(button("Share this version")).toBeNull();
    expect(container.querySelector(".publication-management")).toBeNull();
    expect(
      container.querySelector('select[aria-label="Select synced revision"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Duration");
  });

  it("removes stale Copy/Open actions after unpublishing", async () => {
    let unpublished = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/unpublish") && init?.method === "POST") {
          unpublished = true;
          return new Response("null");
        }
        if (url.endsWith("/share")) {
          return new Response(JSON.stringify(publication));
        }
        return new Response(
          JSON.stringify(
            unpublished ? workspaceWithExpiredShare : workspaceWithActiveShare,
          ),
        );
      }),
    );

    await act(async () => {
      root.render(
        <CreatorWorkspace
          token="creator-token"
          workspace={workspaceWithActiveShare}
        />,
      );
      await settle();
    });
    expect(container.textContent).toContain("Copy link");

    const management = container.querySelector<HTMLDetailsElement>(
      ".publication-management",
    );
    await act(async () => {
      management?.querySelector("summary")?.click();
      await settle();
      button("Unpublish")?.click();
      await settle();
    });

    expect(container.textContent).not.toContain("Copy link");
    expect(container.textContent).not.toContain("Open link");
    expect(button("Share again")).not.toBeNull();
  });
});

function button(label: string): HTMLButtonElement | null {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  return found ?? null;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}
