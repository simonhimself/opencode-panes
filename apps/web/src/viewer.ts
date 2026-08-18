import {
  artifactIdSchema,
  workspaceTokenSchema,
  type Artifact,
  type ArtifactType,
  type Revision,
  type ShareResponse,
} from "@opencode-panes/contracts";

const SESSION_TOKEN_PREFIX = "opencode-panes:workspace-token:";
const PUBLIC_URL_PREFIX = "opencode-panes:public-url:";
const PUBLIC_REVISION_PREFIX = "opencode-panes:public-revision:";

export type ViewerRoute =
  | { kind: "artifact"; artifactId: string }
  | { kind: "shared"; token: string }
  | { kind: "home" }
  | { kind: "not-found" };

export type WorkspaceAccess =
  | { status: "ready"; token: string }
  | { status: "missing" }
  | { status: "invalid" };

export interface PublicArtifactResponse {
  artifact: Pick<Artifact, "id" | "title" | "type">;
  revision: Revision;
  publishedAt: string;
}

export interface ArtifactResponse {
  artifact: Artifact;
  revision: Revision;
  viewerUrl: string;
}

export interface RevisionListResponse {
  artifactId: string;
  revisions: Revision[];
}

export interface PrivateWorkspaceData {
  current: ArtifactResponse;
  revisions: Revision[];
}

export interface RevisionSelection {
  followLatest: boolean;
  revisionId: string;
}

interface LocationLike {
  hash: string;
  pathname: string;
  search: string;
}

interface HistoryLike {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface SerializedPoller {
  pollNow(): Promise<void>;
  stop(): void;
}

export interface SerializedPollerOptions<T> {
  apply: (value: T, signal: AbortSignal) => Promise<void> | void;
  getSequence: (value: T) => number;
  initialSequence: number;
  load: (signal: AbortSignal) => Promise<T>;
  onError?: (error: unknown) => void;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const DOWNLOAD_EXTENSIONS: Record<ArtifactType, string> = {
  code: "txt",
  html: "html",
  markdown: "md",
  mermaid: "mmd",
  react: "tsx",
  svg: "svg",
};

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export class ApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function parseViewerRoute(pathname: string): ViewerRoute {
  if (pathname === "/" || pathname === "") return { kind: "home" };

  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)\/?$/);
  if (artifactMatch) {
    const artifactId = decodeSegment(artifactMatch[1]);
    if (artifactIdSchema.safeParse(artifactId).success) {
      return { kind: "artifact", artifactId: artifactId as string };
    }
  }

  const sharedMatch = pathname.match(/^\/shared\/([^/]+)\/?$/);
  if (sharedMatch) {
    const token = decodeSegment(sharedMatch[1]);
    if (workspaceTokenSchema.safeParse(token).success) {
      return { kind: "shared", token: token as string };
    }
  }

  return { kind: "not-found" };
}

export function workspaceTokenStorageKey(artifactId: string): string {
  return `${SESSION_TOKEN_PREFIX}${artifactId}`;
}

export function publicUrlStorageKey(
  artifactId: string,
  revisionId: string,
): string {
  return `${PUBLIC_URL_PREFIX}${artifactId}:${revisionId}`;
}

export function storePublicUrl(
  artifactId: string,
  revisionId: string,
  publicUrl: string,
  storage: StorageLike = sessionStorage,
): void {
  if (!isPublicViewerUrl(publicUrl)) return;
  const activeKey = `${PUBLIC_REVISION_PREFIX}${artifactId}`;
  try {
    const previousRevisionId = storage.getItem(activeKey);
    if (previousRevisionId && previousRevisionId !== revisionId) {
      storage.removeItem(publicUrlStorageKey(artifactId, previousRevisionId));
    }
    storage.setItem(publicUrlStorageKey(artifactId, revisionId), publicUrl);
    storage.setItem(activeKey, revisionId);
  } catch {
    // Publishing still succeeds when storage is unavailable or full.
  }
}

export function getStoredPublicUrl(
  artifactId: string,
  revisionId: string,
  storage: StorageLike = sessionStorage,
): string | undefined {
  const key = publicUrlStorageKey(artifactId, revisionId);
  try {
    const value = storage.getItem(key);
    if (!value) return undefined;
    if (isPublicViewerUrl(value)) return value;
    storage.removeItem(key);
  } catch {
    // Treat unavailable storage as a cache miss.
  }
  return undefined;
}

export function clearStoredPublicUrl(
  artifactId: string,
  storage: StorageLike = sessionStorage,
): void {
  const activeKey = `${PUBLIC_REVISION_PREFIX}${artifactId}`;
  try {
    const revisionId = storage.getItem(activeKey);
    if (revisionId) {
      storage.removeItem(publicUrlStorageKey(artifactId, revisionId));
    }
    storage.removeItem(activeKey);
  } catch {
    // Unpublish still succeeds when storage is unavailable.
  }
}

export function createSerializedPoller<T>(
  options: SerializedPollerOptions<T>,
): SerializedPoller {
  const controller = new AbortController();
  let inFlight: Promise<void> | undefined;
  let latestSequence = options.initialSequence;

  const pollNow = () => {
    if (controller.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight;

    const task = (async () => {
      try {
        const value = await options.load(controller.signal);
        if (controller.signal.aborted) return;
        const sequence = options.getSequence(value);
        if (sequence < latestSequence) return;
        await options.apply(value, controller.signal);
        latestSequence = sequence;
      } catch (error) {
        if (!controller.signal.aborted) options.onError?.(error);
      }
    })();
    inFlight = task;
    const clear = () => {
      if (inFlight === task) inFlight = undefined;
    };
    void task.then(clear, clear);
    return task;
  };

  return {
    pollNow,
    stop() {
      controller.abort();
    },
  };
}

export function captureWorkspaceAccess(
  artifactId: string,
  location: LocationLike,
  history: HistoryLike,
  storage: StorageLike,
): WorkspaceAccess {
  const storageKey = workspaceTokenStorageKey(artifactId);
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const hasFragmentToken = fragment.has("workspaceToken");

  if (location.hash) {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}`,
    );
  }

  if (hasFragmentToken) {
    const fragmentToken = fragment.get("workspaceToken");
    if (!workspaceTokenSchema.safeParse(fragmentToken).success) {
      safelyRemove(storage, storageKey);
      return { status: "invalid" };
    }

    try {
      storage.setItem(storageKey, fragmentToken as string);
    } catch {
      return { status: "ready", token: fragmentToken as string };
    }
    return { status: "ready", token: fragmentToken as string };
  }

  let storedToken: string | null = null;
  try {
    storedToken = storage.getItem(storageKey);
  } catch {
    return { status: "missing" };
  }

  if (!storedToken) return { status: "missing" };
  if (!workspaceTokenSchema.safeParse(storedToken).success) {
    safelyRemove(storage, storageKey);
    return { status: "invalid" };
  }
  return { status: "ready", token: storedToken };
}

export function selectRevision(
  revisionId: string,
  currentRevisionId: string,
): RevisionSelection {
  return {
    followLatest: revisionId === currentRevisionId,
    revisionId,
  };
}

export function followCurrentRevision(
  selection: RevisionSelection,
  currentRevisionId: string,
  revisions: readonly Revision[],
): RevisionSelection {
  if (selection.followLatest) {
    return { followLatest: true, revisionId: currentRevisionId };
  }

  if (revisions.some((revision) => revision.id === selection.revisionId)) {
    return selection;
  }

  return { followLatest: true, revisionId: currentRevisionId };
}

export async function fetchPrivateWorkspace(
  artifactId: string,
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<PrivateWorkspaceData> {
  const [current, revisionList] = await Promise.all([
    fetchPrivateCurrent(artifactId, token, fetcher, signal),
    requestJson<RevisionListResponse>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/revisions`,
      { headers: privateHeaders(token), ...(signal ? { signal } : {}) },
      fetcher,
    ),
  ]);

  return {
    current,
    revisions: includeRevision(revisionList.revisions, current.revision),
  };
}

export function fetchPrivateCurrent(
  artifactId: string,
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<ArtifactResponse> {
  return requestJson<ArtifactResponse>(
    `/api/artifacts/${encodeURIComponent(artifactId)}`,
    { headers: privateHeaders(token), ...(signal ? { signal } : {}) },
    fetcher,
  );
}

export async function fetchPrivateRevisions(
  artifactId: string,
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<Revision[]> {
  const response = await requestJson<RevisionListResponse>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/revisions`,
    { headers: privateHeaders(token), ...(signal ? { signal } : {}) },
    fetcher,
  );
  return response.revisions;
}

export function fetchPublicArtifact(
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<PublicArtifactResponse> {
  return requestJson<PublicArtifactResponse>(
    `/api/public/${encodeURIComponent(token)}`,
    signal ? { signal } : {},
    fetcher,
  );
}

export function publishRevision(
  artifactId: string,
  token: string,
  revisionId: string,
  fetcher: Fetcher = fetch,
): Promise<ShareResponse | null> {
  return requestJson<ShareResponse | null>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/publish`,
    {
      body: JSON.stringify({ revisionId }),
      headers: privateHeaders(token, true),
      method: "POST",
    },
    fetcher,
  );
}

export function unpublishArtifact(
  artifactId: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<null> {
  return requestJson<null>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/unpublish`,
    { headers: privateHeaders(token), method: "POST" },
    fetcher,
  );
}

export function safeDownloadFilename(
  title: string,
  type: ArtifactType,
): string {
  const extension = DOWNLOAD_EXTENSIONS[type];
  let base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 72)
    .replace(/-+$/g, "");

  if (!base || WINDOWS_RESERVED_NAMES.test(base)) base = "artifact";
  return `${base}.${extension}`;
}

export function downloadSource(
  source: string,
  title: string,
  type: ArtifactType,
): void {
  const url = URL.createObjectURL(
    new Blob([source], { type: downloadMimeType(type) }),
  );
  const anchor = document.createElement("a");
  anchor.download = safeDownloadFilename(title, type);
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error("Clipboard access is unavailable in this browser");
  }
  await navigator.clipboard.writeText(value);
}

function privateHeaders(token: string, json = false): Headers {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (json) headers.set("Content-Type", "application/json");
  return headers;
}

export function includeRevision(
  revisions: readonly Revision[],
  current: Revision,
): Revision[] {
  const withoutCurrent = revisions.filter(
    (revision) => revision.id !== current.id,
  );
  return [current, ...withoutCurrent].sort(
    (left, right) => right.version - left.version,
  );
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(input, init);
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;
    try {
      const payload = (await response.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof payload.error?.message === "string") {
        message = payload.error.message;
      }
      if (typeof payload.error?.code === "string") code = payload.error.code;
    } catch {
      // Keep the status-based fallback when the response is not JSON.
    }
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

function downloadMimeType(type: ArtifactType): string {
  if (type === "html") return "text/html;charset=utf-8";
  if (type === "svg") return "image/svg+xml;charset=utf-8";
  if (type === "markdown") return "text/markdown;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function decodeSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isPublicViewerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      /^\/shared\/[^/]+\/?$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function safelyRemove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy modes. The invalid token is ignored.
  }
}
