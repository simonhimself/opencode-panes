import type {
  ArtifactLibrary,
  ArtifactShare,
  ArtifactVersion,
  PublicArtifact,
} from "@opencode-panes/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app";

const version = (number: number): ArtifactVersion => ({
  id: `version-${number}`,
  number,
  createdAt: "2026-08-28T10:00:00.000Z",
  entryPath: "index.html",
  fileCount: 3,
  bytes: 500,
  previewUrl: `/api/previews/readonly-${number}/files/index.html`,
});
const active: ArtifactShare = {
  url: "https://panes.example/s/stable-link",
  versionId: "version-1",
  expiresAt: null,
  status: "active",
};
const fixture = (): ArtifactLibrary => ({
  projects: [
    { id: "project-one", name: "Field Notes" },
    { id: "project-two", name: "Little Experiments" },
  ],
  artifacts: [
    {
      id: "artifact-one",
      projectId: "project-one",
      title: "An illustrated field guide",
      updatedAt: "2026-08-29T10:00:00.000Z",
      versions: [version(1), version(2)],
      share: null,
    },
    {
      id: "artifact-two",
      projectId: "project-two",
      title: "A moving study",
      updatedAt: "2026-08-28T10:00:00.000Z",
      versions: [version(1)],
      share: { ...active },
    },
    {
      id: "artifact-three",
      projectId: "project-one",
      title: "The first sketch",
      updatedAt: "2026-08-27T10:00:00.000Z",
      versions: [version(1)],
      share: {
        ...active,
        expiresAt: "2020-08-27T10:00:00.000Z",
        status: "expired",
      },
    },
  ],
});

let container: HTMLDivElement;
let root: Root;
let library: ArtifactLibrary;
let fetcher: ReturnType<typeof vi.fn>;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/inventory");
  library = fixture();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/library") return json(library);
    if (input.startsWith("/api/shares/"))
      return json({
        title: library.artifacts[0]!.title,
        version: version(2),
        expiresAt: null,
      } satisfies PublicArtifact);
    const artifact = library.artifacts.find((item) =>
      input.includes(`/artifacts/${item.id}`),
    );
    if (!artifact) return json({}, 404);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        versionId: string;
        expiresInDays: number | null;
      };
      artifact.share = {
        ...active,
        versionId: body.versionId,
        expiresAt:
          body.expiresInDays === null ? null : "2099-08-29T10:00:00.000Z",
      };
      return json(artifact.share);
    }
    if (init?.method === "DELETE") {
      if (input.endsWith("/share")) artifact.share = null;
      else
        library.artifacts = library.artifacts.filter(
          (item) => item.id !== artifact.id,
        );
      return new Response(null, { status: 204 });
    }
    return json(artifact);
  });
  vi.stubGlobal("fetch", fetcher);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(path = "/inventory") {
  window.history.replaceState(null, "", path);
  await act(async () => {
    root.render(<App />);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(found, `Button "${label}" exists`).toBeDefined();
  return found!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function change(selector: string, value: string) {
  const element = container.querySelector(selector)!;
  expect(element).not.toBeNull();
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

const cards = () => [...container.querySelectorAll(".artifact-card")];
const mutations = () =>
  fetcher.mock.calls.filter(
    ([, init]) => init?.method === "PUT" || init?.method === "DELETE",
  );

describe("artifact library", () => {
  it("distinguishes the latest private upload from the older shared version", async () => {
    library.artifacts[0]!.share = { ...active };
    await mount();
    expect(cards()[0]?.textContent).toContain("Latest v2 / Shared v1");
  });

  it("leaves same-page fragment links to the browser", async () => {
    await mount();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector('a[href="#main"]')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it("redirects root to the library and displays real projects, titles, and statuses", async () => {
    await mount("/");
    expect(window.location.pathname).toBe("/inventory");
    expect(cards()).toHaveLength(3);
    expect(container.textContent).toContain("Field Notes");
    expect(container.textContent).toContain("Little Experiments");
    expect(cards()[0]?.textContent).toContain("An illustrated field guide");
    expect(cards()[0]?.textContent).toContain("Private");
    expect(cards()[1]?.textContent).toContain("Shared");
    expect(cards()[1]?.textContent).toContain("No expiry");
    expect(cards()[2]?.textContent).toContain("Expired");
    expect(container.textContent).not.toMatch(/Creator|Owner|recovery|storage/);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/library",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("uses isolated lazy thumbnails that can render browser-built JavaScript", async () => {
    await mount();
    const frames = [...container.querySelectorAll("iframe")];
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.getAttribute("loading")).toBe("lazy");
      expect(frame.tabIndex).toBe(-1);
      expect(frame.getAttribute("aria-hidden")).toBe("true");
    }
    expect(frames[0]?.getAttribute("src")).toBe(version(2).previewUrl);
  });

  it("filters by project and status, searches friendly names, and navigates cards", async () => {
    await mount();
    await click(
      container.querySelector<HTMLAnchorElement>(
        'a[href="/inventory?project=project-one"]',
      )!,
    );
    expect(window.location.search).toBe("?project=project-one");
    expect(cards()).toHaveLength(2);
    await click(button("Expired"));
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.textContent).toContain("The first sketch");
    await click(button("Private"));
    expect(cards()[0]?.textContent).toContain("An illustrated field guide");
    await change('input[type="search"]', "no such work");
    expect(cards()).toHaveLength(0);
    expect(container.textContent).toContain("Nothing in this view yet");
    await click(button("Clear search and filters"));
    await click(
      container.querySelector<HTMLAnchorElement>(
        'a[aria-label="Panes library"]',
      )!,
    );
    await change('input[type="search"]', "LITTLE EXPERIMENTS");
    expect(cards()).toHaveLength(1);
    await click(cards()[0] as HTMLElement);
    expect(window.location.pathname).toBe("/inventory/artifacts/artifact-two");
    expect(container.querySelector("h1")?.textContent).toBe("A moving study");
    expect(
      container.querySelector('[aria-label="Breadcrumb"]')?.textContent,
    ).toContain("Little Experiments");
    expect(container.querySelector('[aria-label="Sharing"]')).not.toBeNull();
  });

  it("refreshes explicitly and on window focus without resetting search", async () => {
    await mount();
    await change('input[type="search"]', "illustrated");
    const count = fetcher.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetcher.mock.calls.length).toBe(count + 1);
    expect(
      container.querySelector<HTMLInputElement>('input[type="search"]')?.value,
    ).toBe("illustrated");
    await click(button("Refresh"));
    expect(fetcher.mock.calls.length).toBe(count + 2);
  });

  it("responds to browser history navigation", async () => {
    await mount();
    await click(cards()[0] as HTMLElement);
    await act(async () => {
      window.history.replaceState(null, "", "/inventory?project=project-two");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.textContent).toContain("A moving study");
  });

  it("explains how to add the first artifact without invented content", async () => {
    library = { projects: [], artifacts: [] };
    await mount();
    expect(container.textContent).toContain("Your next idea belongs here");
    expect(container.textContent).toContain(
      "Ask OpenCode to upload a file or folder",
    );
    expect(cards()).toHaveLength(0);
  });

  it("announces loading and handles authentication and retry", async () => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await mount();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading your library",
    );
    await act(async () => resolve(json({}, 401)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "sign in again",
    );
    await click(button("Refresh"));
    expect(cards()).toHaveLength(3);
  });
});

describe("artifact detail and sharing", () => {
  it("keeps new versions fetched while a share request is pending", async () => {
    await mount("/inventory/artifacts/artifact-one");
    await click(button("Publish"));
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await click(button("Confirm publish"));
    library.artifacts[0]!.versions.push(version(3));
    await act(async () => window.dispatchEvent(new Event("focus")));
    library.artifacts[0]!.share = { ...active, versionId: "version-2" };
    await act(async () => finish(json(library.artifacts[0]!.share)));
    expect(
      container.querySelector('select[aria-label="Version"]')?.textContent,
    ).toContain("Version 3 (latest)");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      version(3).previewUrl,
    );
    expect(container.textContent).toContain("Sharing version 2");
  });

  it("does not redirect a new page when an old deletion finishes", async () => {
    await mount("/inventory/artifacts/artifact-one");
    await click(button("Delete artifact"));
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await click(button("Delete cloud copy"));
    await act(async () => {
      window.history.replaceState(
        null,
        "",
        "/inventory/artifacts/artifact-two",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    library.artifacts = library.artifacts.filter(
      (item) => item.id !== "artifact-one",
    );
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(window.location.pathname).toBe("/inventory/artifacts/artifact-two");
  });
  it("sorts versions newest-first and uses only the supplied isolated preview URL", async () => {
    await mount("/inventory/artifacts/artifact-one");
    const select = [...container.querySelectorAll("select")].find(
      (element) => element.getAttribute("aria-label") === "Version",
    )!;
    expect([...select.options].map((item) => item.value)).toEqual([
      "version-2",
      "version-1",
    ]);
    expect(select.value).toBe("version-2");
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBe(version(2).previewUrl);
    expect(frame.getAttribute("srcdoc")).toBeNull();
    await change('select[aria-label="Version"]', "version-1");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      version(1).previewUrl,
    );
  });

  it("publishes with no expiry only after confirming the exact version and accessible files", async () => {
    await mount("/inventory/artifacts/artifact-one");
    const expirySelect = [...container.querySelectorAll("select")].find(
      (element) => element.id === "expiry",
    )!;
    expect(expirySelect.value).toBe("none");
    expect([...expirySelect.options].map((item) => item.value)).toEqual([
      "none",
      "1",
      "7",
      "30",
    ]);
    await click(button("Publish"));
    expect(mutations()).toHaveLength(0);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Publish version 2?");
    expect(dialog.textContent).toContain(
      "All 3 uploaded files in this version will be accessible",
    );
    expect(dialog.textContent).toContain("no expiry");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(button("Confirm publish"));
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]).toEqual([
      "/api/library/artifacts/artifact-one/share",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ versionId: "version-2", expiresInDays: null }),
        credentials: "same-origin",
      }),
    ]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>("#share-url")?.value).toBe(
      active.url,
    );
    expect(container.textContent).toContain(
      "Published. Your link is ready to share.",
    );
    expect(button("Update shared version")).toBeDefined();
    await click(
      container.querySelector<HTMLAnchorElement>(
        '.breadcrumb a[href="/inventory"]',
      )!,
    );
    expect(cards()[0]?.querySelector(".badge")?.textContent).toBe("Shared");
  });

  it("keeps the confirmed version fixed when a newer upload arrives on focus", async () => {
    await mount("/inventory/artifacts/artifact-one");
    await click(button("Publish"));
    library.artifacts[0]!.versions.push(version(3));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Publish version 2?",
    );
    await click(button("Confirm publish"));
    expect(JSON.parse(mutations()[0]?.[1].body).versionId).toBe("version-2");
  });

  it("traps keyboard focus inside a sharing confirmation", async () => {
    await mount("/inventory/artifacts/artifact-one");
    await click(button("Publish"));
    await act(async () =>
      button("Cancel").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button("Confirm publish"));
    await act(async () =>
      button("Confirm publish").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("updates the chosen version at the stable link, including a finite expiry", async () => {
    library.artifacts[0]!.share = { ...active };
    await mount("/inventory/artifacts/artifact-one");
    await change("#expiry", "7");
    await click(button("Update shared version"));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Your active link stays the same",
    );
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "7 days after confirmation",
    );
    await click(button("Confirm update"));
    expect(JSON.parse(mutations()[0]?.[1].body)).toEqual({
      versionId: "version-2",
      expiresInDays: 7,
    });
    expect(container.querySelector<HTMLInputElement>("#share-url")?.value).toBe(
      active.url,
    );
    expect(container.textContent).toContain("Sharing version 2");
    expect(container.textContent).toContain("Your link stays the same");
    expect(
      container.querySelector<HTMLAnchorElement>(".link-actions a")?.rel,
    ).toBe("noopener noreferrer");
  });

  it("cancels sharing with Escape and restores keyboard focus", async () => {
    await mount("/inventory/artifacts/artifact-one");
    button("Publish").focus();
    await click(button("Publish"));
    await act(async () =>
      container
        .querySelector('[role="dialog"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Publish"));
    expect(mutations()).toHaveLength(0);
  });

  it("copies the active public URL", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await mount("/inventory/artifacts/artifact-two");
    await click(button("Copy link"));
    expect(writeText).toHaveBeenCalledWith(active.url);
    expect(container.textContent).toContain("Link copied.");
  });

  it.each(["unavailable", "denied"])(
    "provides a selected manual-copy fallback when clipboard is %s",
    async (kind) => {
      if (kind === "denied")
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: vi.fn(async () => {
              throw new Error("Denied");
            }),
          },
        });
      await mount("/inventory/artifacts/artifact-two");
      await click(button("Copy link"));
      const input = container.querySelector<HTMLInputElement>("#share-url")!;
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(active.url.length);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not copy automatically",
      );
      expect(container.textContent).not.toContain("Link copied.");
    },
  );

  it("requires separate unpublish confirmation and removes the old link", async () => {
    await mount("/inventory/artifacts/artifact-two");
    await click(button("Unpublish"));
    expect(mutations()).toHaveLength(0);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Publishing again creates a new link",
    );
    await click(button("Cancel"));
    expect(mutations()).toHaveLength(0);
    await click(button("Unpublish"));
    await click(button("Confirm unpublish"));
    expect(mutations()[0]).toEqual([
      "/api/library/artifacts/artifact-two/share",
      expect.objectContaining({ method: "DELETE" }),
    ]);
    expect(container.querySelector("#share-url")).toBeNull();
    expect(container.textContent).toContain("The old link no longer works");
    expect(button("Publish")).toBeDefined();
  });

  it("confirms cloud-only deletion separately and returns to the refreshed library", async () => {
    await mount("/inventory/artifacts/artifact-one");
    await click(button("Delete artifact"));
    expect(mutations()).toHaveLength(0);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("permanently deleted from the cloud");
    expect(dialog.textContent).toContain(
      "Your local files will not be changed",
    );
    await click(button("Delete cloud copy"));
    expect(mutations()[0]).toEqual([
      "/api/library/artifacts/artifact-one",
      expect.objectContaining({ method: "DELETE" }),
    ]);
    expect(window.location.pathname).toBe("/inventory");
    expect(cards()).toHaveLength(2);
    expect(
      cards().some((item) =>
        item.textContent?.includes("An illustrated field guide"),
      ),
    ).toBe(false);
  });

  it("keeps a failed action in the confirmation without reporting success", async () => {
    await mount("/inventory/artifacts/artifact-one");
    await click(button("Publish"));
    fetcher.mockImplementationOnce(async () => json({}, 503));
    await click(button("Confirm publish"));
    expect(
      container.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toContain("try again");
    expect(container.querySelector("#share-url")).toBeNull();
    expect(button("Confirm publish").disabled).toBe(false);
  });

  it("does not expose an expired share as an active link", async () => {
    await mount("/inventory/artifacts/artifact-three");
    expect(container.querySelector("#share-url")).toBeNull();
    expect(container.textContent).toContain("This link is no longer available");
    expect(button("Publish")).toBeDefined();
  });

  it("handles missing detail without a broken iframe", async () => {
    await mount("/inventory/artifacts/missing");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "no longer in your library",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("public viewer", () => {
  it("fetches PublicArtifact without management cookies and renders a read-only isolated preview", async () => {
    await mount("/s/public-token");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/shares/public-token",
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "An illustrated field guide",
    );
    expect(container.textContent).toContain("Read-only");
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms",
    );
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      version(2).previewUrl,
    );
    expect(
      container.querySelector("iframe")?.getAttribute("referrerpolicy"),
    ).toBe("no-referrer");
    expect(container.textContent).not.toMatch(
      /Publish|Unpublish|Delete|Creator|Owner/,
    );
    expect(container.querySelector("select")).toBeNull();
  });

  it.each([403, 404, 410, 503])(
    "handles public error %s without exposing a preview or token",
    async (code) => {
      fetcher.mockImplementation(async () => json({}, code));
      await mount("/s/secret-public-token");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        code === 503 ? "could not be loaded" : "This link is unavailable",
      );
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.textContent).not.toContain("secret-public-token");
    },
  );

  it("removes the preview if a refreshed public link has been revoked", async () => {
    await mount("/s/public-token");
    expect(container.querySelector("iframe")).not.toBeNull();
    fetcher.mockImplementation(async () => json({}, 410));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("This link is unavailable");
  });
});
