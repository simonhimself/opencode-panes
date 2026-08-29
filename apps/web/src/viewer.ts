import {
  artifactIdSchema,
  workspaceTokenSchema,
  type Publication,
  type Artifact,
  type ArtifactType,
  type CreatorWorkspaceResponse,
  type InventoryResponse,
  type InventoryCreatorRotateResponse,
  type PublicPublicationResponse,
  type Revision,
  type ShareResponse,
} from "@opencode-panes/contracts";

const SESSION_TOKEN_PREFIX = "opencode-panes:workspace-token:";
const PUBLIC_URL_PREFIX = "opencode-panes:public-url:";
const PUBLIC_REVISION_PREFIX = "opencode-panes:public-revision:";

export type ViewerRoute =
  | { kind: "artifact"; artifactId: string }
  | { kind: "creator"; token: string }
  | { kind: "shared"; token: string }
  | { kind: "published"; token: string }
  | { kind: "inventory" }
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

export type CreatorWorkspaceData = CreatorWorkspaceResponse;
export type PublicWorkspaceData = PublicPublicationResponse;
export type InventoryData = InventoryResponse;
export type PublicationDuration = 1 | 7 | 30;

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
  if (pathname === "/inventory" || pathname === "/inventory/")
    return { kind: "inventory" };

  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)\/?$/);
  if (artifactMatch) {
    const artifactId = decodeSegment(artifactMatch[1]);
    if (artifactIdSchema.safeParse(artifactId).success) {
      return { kind: "artifact", artifactId: artifactId as string };
    }
  }

  const creatorMatch = pathname.match(/^\/creator\/([^/]+)\/?$/);
  if (creatorMatch) {
    const token = decodeSegment(creatorMatch[1]);
    if (workspaceTokenSchema.safeParse(token).success) {
      return { kind: "creator", token: token as string };
    }
  }

  const sharedMatch = pathname.match(/^\/shared\/([^/]+)\/?$/);
  if (sharedMatch) {
    const token = decodeSegment(sharedMatch[1]);
    if (workspaceTokenSchema.safeParse(token).success) {
      return { kind: "shared", token: token as string };
    }
  }

  const publishedMatch = pathname.match(/^\/published\/([^/]+)\/?$/);
  if (publishedMatch) {
    const token = decodeSegment(publishedMatch[1]);
    if (workspaceTokenSchema.safeParse(token).success) {
      return { kind: "published", token: token as string };
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

export function fetchPublicationStatus(
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<PublicWorkspaceData> {
  return requestJson<PublicWorkspaceData>(
    `/api/publications/${encodeURIComponent(token)}`,
    signal ? { signal } : {},
    fetcher,
  );
}

export function fetchInventory(
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<InventoryData> {
  return requestJson<InventoryData>(
    "/api/inventory",
    signal ? { signal } : {},
    fetcher,
  );
}

export function rotateInventoryCreator(
  artifactId: string,
  fetcher: Fetcher = fetch,
): Promise<InventoryCreatorRotateResponse> {
  return requestJson<InventoryCreatorRotateResponse>(
    `/api/inventory/artifacts/${encodeURIComponent(artifactId)}/creator/rotate`,
    {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export function extendInventoryPublication(
  artifactId: string,
  durationDays: PublicationDuration,
  fetcher: Fetcher = fetch,
): Promise<Publication> {
  return requestJson<Publication>(
    `/api/inventory/artifacts/${encodeURIComponent(artifactId)}/publication/extend`,
    {
      body: JSON.stringify({ durationDays }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export function republishInventoryPublication(
  artifactId: string,
  revisionVersion: number,
  durationDays: PublicationDuration,
  fetcher: Fetcher = fetch,
): Promise<Publication> {
  return requestJson<Publication>(
    `/api/inventory/artifacts/${encodeURIComponent(artifactId)}/publication/republish`,
    {
      body: JSON.stringify({ revisionVersion, durationDays }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export function unpublishInventoryPublication(
  artifactId: string,
  fetcher: Fetcher = fetch,
): Promise<null> {
  return requestJson<null>(
    `/api/inventory/artifacts/${encodeURIComponent(artifactId)}/publication/unpublish`,
    {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export async function deleteInventoryArtifact(
  artifactId: string,
  confirmation: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await requestJson<null>(
    `/api/inventory/artifacts/${encodeURIComponent(artifactId)}`,
    {
      body: JSON.stringify({ confirmation }),
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    },
    fetcher,
  );
}

export function publicFileUrl(
  token: string,
  path: string,
  download = false,
): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `/api/publications/${encodeURIComponent(token)}/files/${encodedPath}`;
  return download ? `${url}?download=1` : url;
}

export async function fetchPublicFile(
  token: string,
  path: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  download = false,
): Promise<Response> {
  const response = await fetcher(
    publicFileUrl(token, path, download),
    signal ? { signal } : undefined,
  );
  if (!response.ok) await throwApiError(response);
  return response;
}

export function fetchCreatorWorkspace(
  token: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<CreatorWorkspaceData> {
  return requestJson<CreatorWorkspaceData>(
    `/api/creator/${encodeURIComponent(token)}`,
    signal ? { signal } : {},
    fetcher,
  );
}

export function publishCreatorPublication(
  token: string,
  revisionVersion: number,
  durationDays: PublicationDuration,
  fetcher: Fetcher = fetch,
): Promise<Publication> {
  return requestJson<Publication>(
    `/api/creator/${encodeURIComponent(token)}/publish`,
    {
      body: JSON.stringify({ revisionVersion, durationDays }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export function republishCreatorPublication(
  token: string,
  revisionVersion: number,
  durationDays: PublicationDuration,
  fetcher: Fetcher = fetch,
): Promise<Publication> {
  return requestJson<Publication>(
    `/api/creator/${encodeURIComponent(token)}/republish`,
    {
      body: JSON.stringify({ revisionVersion, durationDays }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export function extendCreatorPublication(
  token: string,
  durationDays: PublicationDuration,
  fetcher: Fetcher = fetch,
): Promise<Publication> {
  return requestJson<Publication>(
    `/api/creator/${encodeURIComponent(token)}/extend`,
    {
      body: JSON.stringify({ durationDays }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetcher,
  );
}

export function unpublishCreatorPublication(
  token: string,
  fetcher: Fetcher = fetch,
): Promise<null> {
  return requestJson<null>(
    `/api/creator/${encodeURIComponent(token)}/unpublish`,
    { method: "POST" },
    fetcher,
  );
}

export function creatorFileUrl(
  token: string,
  version: number,
  path: string,
  download = false,
): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `/api/creator/${encodeURIComponent(token)}/revisions/${version}/files/${encodedPath}`;
  return download ? `${url}?download=1` : url;
}

export function creatorRevisionZipUrl(token: string, version: number): string {
  return `/api/creator/${encodeURIComponent(token)}/revisions/${version}/download.zip`;
}

export function publicRevisionZipUrl(token: string): string {
  return `/api/publications/${encodeURIComponent(token)}/download.zip`;
}

export async function fetchCreatorFile(
  token: string,
  version: number,
  path: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  download = false,
): Promise<Response> {
  const response = await fetcher(
    creatorFileUrl(token, version, path, download),
    signal ? { signal } : undefined,
  );
  if (!response.ok) await throwApiError(response);
  return response;
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
  if (!response.ok) await throwApiError(response);

  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

async function throwApiError(response: Response): Promise<never> {
  let message = `Request failed with status ${response.status}`;
  let code: string | undefined;
  try {
    const payload = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof payload.error?.message === "string")
      message = payload.error.message;
    if (typeof payload.error?.code === "string") code = payload.error.code;
  } catch {
    // Keep the status-based fallback when the response is not JSON.
  }
  throw new ApiError(response.status, message, code);
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
      /^\/(?:shared|published)\/[^/]+\/?$/.test(url.pathname) &&
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
