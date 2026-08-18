import type { Artifact, Revision } from "@opencode-panes/contracts";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ArtifactRenderer } from "./renderers";
import { SourceCode } from "./renderers/source-code";
import {
  ApiError,
  clearStoredPublicUrl,
  copyText,
  createSerializedPoller,
  downloadSource,
  fetchPrivateCurrent,
  fetchPrivateRevisions,
  fetchPrivateWorkspace,
  fetchPublicArtifact,
  followCurrentRevision,
  getStoredPublicUrl,
  includeRevision,
  publishRevision,
  selectRevision,
  storePublicUrl,
  unpublishArtifact,
  type RevisionSelection,
  type ViewerRoute,
  type WorkspaceAccess,
  workspaceTokenStorageKey,
} from "./viewer";

const POLL_INTERVAL_MS = 3_000;

interface AppProps {
  route: ViewerRoute;
  workspaceAccess?: WorkspaceAccess;
}

interface WorkspaceProps {
  artifact: Pick<Artifact, "id" | "title" | "type">;
  isPublic: boolean;
  onPublish?: (revision: Revision) => Promise<void>;
  onUnpublish?: () => Promise<void>;
  publishedAt?: string;
  publicUrl?: string;
  revisions: Revision[];
  selection: RevisionSelection;
  setSelection: (selection: RevisionSelection) => void;
}

interface Notice {
  kind: "error" | "info" | "success";
  text: string;
  url?: string;
}

export function App({ route, workspaceAccess }: AppProps) {
  if (route.kind === "artifact") {
    return (
      <PrivateArtifactView
        access={workspaceAccess ?? { status: "missing" }}
        artifactId={route.artifactId}
      />
    );
  }
  if (route.kind === "shared")
    return <PublicArtifactView token={route.token} />;
  if (route.kind === "not-found") {
    return (
      <EntryState
        eyebrow="Route not found"
        title="This viewer address is not valid."
      >
        Check the artifact or shared link and open it again.
      </EntryState>
    );
  }
  return (
    <EntryState eyebrow="OpenCode Panes" title="No artifact is open.">
      Open a viewer URL returned by the OpenCode artifact tool. Creator links
      use
      <code>/artifacts/:id</code>; public links use <code>/shared/:token</code>.
    </EntryState>
  );
}

function PrivateArtifactView({
  access,
  artifactId,
}: {
  access: WorkspaceAccess;
  artifactId: string;
}) {
  const [artifact, setArtifact] = useState<Artifact>();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selection, setSelection] = useState<RevisionSelection>();
  const [error, setError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const currentRevisionVersion = useRef(0);
  const token = access.status === "ready" ? access.token : undefined;

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void fetchPrivateWorkspace(
      artifactId,
      token,
      fetch,
      controller.signal,
    ).then(
      ({ current, revisions: loadedRevisions }) => {
        currentRevisionVersion.current = current.revision.version;
        setArtifact(current.artifact);
        setRevisions(loadedRevisions);
        setSelection({
          followLatest: true,
          revisionId: current.revision.id,
        });
        setError(undefined);
      },
      (caught: unknown) => {
        if (controller.signal.aborted) return;
        if (
          caught instanceof ApiError &&
          (caught.status === 401 || caught.status === 403)
        ) {
          sessionStorage.removeItem(workspaceTokenStorageKey(artifactId));
        }
        setError(apiErrorMessage(caught));
      },
    );
    return () => controller.abort();
  }, [artifactId, token]);

  const applyPolledCurrent = useEffectEvent(
    async (
      current: Awaited<ReturnType<typeof fetchPrivateCurrent>>,
      signal: AbortSignal,
    ) => {
      if (!token || !artifact || !selection) return;
      let nextRevisions = revisions;
      if (current.artifact.currentRevisionId !== artifact.currentRevisionId) {
        nextRevisions = includeRevision(
          await fetchPrivateRevisions(artifactId, token, fetch, signal),
          current.revision,
        );
        if (signal.aborted) return;
        setRevisions(nextRevisions);
      }
      currentRevisionVersion.current = current.revision.version;
      setArtifact(current.artifact);
      setSelection(
        followCurrentRevision(
          selection,
          current.artifact.currentRevisionId,
          nextRevisions,
        ),
      );
      setRefreshError(undefined);
    },
  );

  const reportPollError = useEffectEvent((caught: unknown) => {
    setRefreshError(apiErrorMessage(caught));
  });

  useEffect(() => {
    if (!artifact || !token) return;
    const poller = createSerializedPoller({
      apply: applyPolledCurrent,
      getSequence: (current) => current.revision.version,
      initialSequence: currentRevisionVersion.current,
      load: (signal) => fetchPrivateCurrent(artifactId, token, fetch, signal),
      onError: reportPollError,
    });
    let active = true;
    let timeout: number | undefined;
    const schedule = () => {
      timeout = window.setTimeout(() => {
        void poller.pollNow().then(() => {
          if (active) schedule();
        });
      }, POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      poller.stop();
    };
  }, [artifact?.id, artifactId, token]);

  if (access.status !== "ready") {
    return (
      <EntryState
        eyebrow={
          access.status === "invalid"
            ? "Invalid access token"
            : "Access token missing"
        }
        title="This creator workspace cannot be authorized."
      >
        {access.status === "invalid"
          ? "The workspace token in this link is malformed. Return to OpenCode and request the artifact viewer URL again."
          : "Open the complete viewer URL from OpenCode. It includes a one-time #workspaceToken fragment that this tab stores only for this artifact."}
      </EntryState>
    );
  }

  if (error) {
    const invalidToken = error.startsWith("Access denied:");
    return (
      <EntryState
        eyebrow={
          invalidToken ? "Workspace access denied" : "API request failed"
        }
        title={
          invalidToken
            ? "The saved token is no longer valid."
            : "The artifact could not be loaded."
        }
      >
        {error}{" "}
        {invalidToken
          ? "Open a fresh viewer URL from OpenCode."
          : "Check the local server and reload this page."}
      </EntryState>
    );
  }

  if (!artifact || !selection)
    return <LoadingState label="Loading creator workspace" />;

  const handlePublish = async (revision: Revision) => {
    try {
      const published = await publishRevision(
        artifact.id,
        access.token,
        revision.id,
      );
      if (!published) {
        const storedUrl = getStoredPublicUrl(artifact.id, revision.id);
        if (storedUrl) {
          setNotice({
            kind: "info",
            text: `Version ${revision.version} is already published. Its public URL was recovered from this tab's session storage.`,
            url: storedUrl,
          });
          return;
        }
        setNotice({
          kind: "info",
          text: `Version ${revision.version} is already published. The server stores only a hash of the existing share token, so it cannot return or reconstruct that public URL. Publish another version to create a new link, or use the link you previously saved.`,
        });
        return;
      }
      storePublicUrl(
        published.artifactId,
        published.revisionId,
        published.publicUrl,
      );
      setNotice({
        kind: "success",
        text: `Version ${published.version} is public.`,
        url: published.publicUrl,
      });
    } catch (caught) {
      setNotice({ kind: "error", text: apiErrorMessage(caught) });
    }
  };

  const handleUnpublish = async () => {
    try {
      await unpublishArtifact(artifact.id, access.token);
      clearStoredPublicUrl(artifact.id);
      setNotice({
        kind: "success",
        text: "Public access is now revoked. Unpublish is safe to repeat if no share was active.",
      });
    } catch (caught) {
      setNotice({ kind: "error", text: apiErrorMessage(caught) });
    }
  };

  return (
    <>
      <ArtifactWorkspace
        artifact={artifact}
        isPublic={false}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
        revisions={revisions}
        selection={selection}
        setSelection={setSelection}
      />
      {refreshError ? (
        <div className="connection-notice" role="status">
          Live update paused: {refreshError}
        </div>
      ) : null}
      {notice ? <ActionNotice notice={notice} /> : null}
    </>
  );
}

function PublicArtifactView({ token }: { token: string }) {
  const [response, setResponse] =
    useState<Awaited<ReturnType<typeof fetchPublicArtifact>>>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchPublicArtifact(token, fetch, controller.signal).then(
      (loaded) => setResponse(loaded),
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(apiErrorMessage(caught));
      },
    );
    return () => controller.abort();
  }, [token]);

  if (error) {
    return (
      <EntryState
        eyebrow="Public artifact unavailable"
        title="This share cannot be opened."
      >
        {error} The link may have been revoked or replaced by a newer published
        version.
      </EntryState>
    );
  }
  if (!response) return <LoadingState label="Loading public artifact" />;

  return (
    <ArtifactWorkspace
      artifact={response.artifact}
      isPublic
      publishedAt={response.publishedAt}
      publicUrl={window.location.href}
      revisions={[response.revision]}
      selection={{ followLatest: false, revisionId: response.revision.id }}
      setSelection={() => undefined}
    />
  );
}

function ArtifactWorkspace({
  artifact,
  isPublic,
  onPublish,
  onUnpublish,
  publishedAt,
  publicUrl,
  revisions,
  selection,
  setSelection,
}: WorkspaceProps) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [stopped, setStopped] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [rendererError, setRendererError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [actionFeedback, setActionFeedback] = useState<string>();
  const selectedRevision =
    revisions.find((revision) => revision.id === selection.revisionId) ??
    revisions[0];

  useEffect(() => {
    setRendererError(undefined);
    setStopped(false);
  }, [mode, selectedRevision?.id]);

  if (!selectedRevision) {
    return (
      <EntryState eyebrow="No revisions" title="This artifact has no content.">
        Return to OpenCode and create a revision before opening the viewer.
      </EntryState>
    );
  }

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusyAction(label);
    try {
      await action();
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleCopy = async () => {
    try {
      await copyText(selectedRevision.source);
      setActionFeedback("Source copied");
    } catch (caught) {
      setActionFeedback(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  const handleCopyLink = async () => {
    if (!publicUrl) return;
    try {
      await copyText(publicUrl);
      setActionFeedback("Public link copied");
    } catch (caught) {
      setActionFeedback(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  const handleReload = () => {
    setRendererError(undefined);
    setStopped(false);
    setGeneration((value) => value + 1);
  };

  const errorForOpenCode = rendererError
    ? [
        `OpenCode Panes ${artifact.type} artifact error`,
        `Artifact: ${artifact.title}`,
        `Revision: v${selectedRevision.version}`,
        "",
        rendererError,
      ].join("\n")
    : undefined;

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div className="identity-block">
          <span className="brand-mark" aria-hidden="true">
            OP
          </span>
          <div className="title-block">
            <span className="eyebrow">
              {isPublic ? "PUBLIC ARTIFACT" : "CREATOR WORKSPACE"}
            </span>
            <h1>{artifact.title}</h1>
          </div>
          <span className="type-readout">{artifact.type}</span>
        </div>

        <div className="instrument-bar" aria-label="Artifact controls">
          <div className="segmented-control" aria-label="View mode">
            <button
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              type="button"
            >
              Preview
            </button>
            <button
              aria-pressed={mode === "code"}
              onClick={() => setMode("code")}
              type="button"
            >
              Code
            </button>
          </div>

          <label className="version-control">
            <span>Version</span>
            <select
              disabled={isPublic}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setSelection(
                  selectRevision(
                    event.target.value,
                    artifactCurrentId(artifact, revisions),
                  ),
                )
              }
              value={selectedRevision.id}
            >
              {revisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  v{revision.version}
                  {!isPublic &&
                  revision.id === artifactCurrentId(artifact, revisions)
                    ? " · latest"
                    : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="action-group">
            <button onClick={() => void handleCopy()} type="button">
              Copy
            </button>
            <button
              onClick={() =>
                downloadSource(
                  selectedRevision.source,
                  artifact.title,
                  artifact.type,
                )
              }
              type="button"
            >
              Download
            </button>
            {isPublic ? (
              <button onClick={() => void handleCopyLink()} type="button">
                Copy link
              </button>
            ) : (
              <>
                <button
                  disabled={Boolean(busyAction) || !onPublish}
                  onClick={() =>
                    onPublish
                      ? void runAction("Publishing", () =>
                          onPublish(selectedRevision),
                        )
                      : undefined
                  }
                  type="button"
                >
                  Publish v{selectedRevision.version}
                </button>
                <button
                  disabled={Boolean(busyAction) || !onUnpublish}
                  onClick={() =>
                    onUnpublish
                      ? void runAction("Unpublishing", onUnpublish)
                      : undefined
                  }
                  type="button"
                >
                  Unpublish
                </button>
              </>
            )}
          </div>

          <div className="runtime-group">
            <button onClick={handleReload} type="button">
              Reload
            </button>
            <button
              disabled={stopped || mode === "code"}
              onClick={() => setStopped(true)}
              type="button"
            >
              Stop
            </button>
          </div>
        </div>

        <div className="status-strip" aria-live="polite">
          <span className={stopped ? "state-dot is-stopped" : "state-dot"} />
          <span>
            {stopped
              ? "Runtime stopped"
              : mode === "code"
                ? "Source inspection"
                : "Runtime active"}
          </span>
          <span className="status-divider" />
          <span>v{selectedRevision.version}</span>
          <span>{formatTimestamp(selectedRevision.createdAt)}</span>
          {selection.followLatest && !isPublic ? (
            <span>Following latest</span>
          ) : null}
          {publishedAt ? (
            <span>Published {formatTimestamp(publishedAt)}</span>
          ) : null}
          {busyAction || actionFeedback ? (
            <strong>{busyAction ?? actionFeedback}</strong>
          ) : null}
        </div>
      </header>

      {isPublic ? (
        <aside className="public-notice">
          <strong>User-generated content.</strong> This read-only artifact runs
          in an isolated viewer. OpenCode Panes does not verify its accuracy.
        </aside>
      ) : null}

      <section
        className="artifact-stage"
        aria-label={`${artifact.title} artifact ${mode}`}
      >
        <span className="stage-index" aria-hidden="true">
          {mode === "preview" ? "VIEW" : "SRC"}
        </span>
        <div className="artifact-canvas">
          {mode === "code" ? (
            <SourceCode source={selectedRevision.source} type={artifact.type} />
          ) : stopped ? (
            <StoppedState onReload={handleReload} />
          ) : (
            <ArtifactRenderer
              key={`${selectedRevision.id}-${generation}`}
              onError={setRendererError}
              source={selectedRevision.source}
              type={artifact.type}
            />
          )}
        </div>
      </section>

      {rendererError && errorForOpenCode ? (
        <section className="renderer-error" role="alert">
          <div>
            <span className="eyebrow">RENDER FAILURE</span>
            <h2>Artifact execution failed</h2>
          </div>
          <pre>{rendererError}</pre>
          <button
            onClick={() =>
              void copyText(errorForOpenCode).then(
                () => setActionFeedback("Error copied for OpenCode"),
                (caught: unknown) =>
                  setActionFeedback(
                    caught instanceof Error ? caught.message : String(caught),
                  ),
              )
            }
            type="button"
          >
            Copy error for OpenCode
          </button>
        </section>
      ) : null}
    </main>
  );
}

export { SourceCode } from "./renderers/source-code";

function StoppedState({ onReload }: { onReload: () => void }) {
  return (
    <div className="stopped-state">
      <span className="eyebrow">RUNTIME OFFLINE</span>
      <h2>Preview stopped</h2>
      <p>The artifact process and any active compilation have been stopped.</p>
      <button onClick={onReload} type="button">
        Reload preview
      </button>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <main className="entry-shell" aria-busy="true">
      <div className="loading-readout" role="status">
        <span className="state-dot" />
        {label}…
      </div>
    </main>
  );
}

function EntryState({
  children,
  eyebrow,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <main className="entry-shell">
      <section className="entry-message">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{children}</p>
      </section>
    </main>
  );
}

function ActionNotice({ notice }: { notice: Notice }) {
  const handleCopy = async () => {
    if (notice.url) await copyText(notice.url);
  };
  return (
    <aside className={`action-notice is-${notice.kind}`} role="status">
      <p>{notice.text}</p>
      {notice.url ? (
        <div>
          <a href={notice.url} rel="noreferrer" target="_blank">
            {notice.url}
          </a>
          <button onClick={() => void handleCopy()} type="button">
            Copy public URL
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function artifactCurrentId(
  artifact: Pick<Artifact, "id" | "title" | "type">,
  revisions: Revision[],
): string {
  if ("currentRevisionId" in artifact) {
    return String(artifact.currentRevisionId);
  }
  return revisions[0]?.id ?? "";
}

function apiErrorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    return `Access denied: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
