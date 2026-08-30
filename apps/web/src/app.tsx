import type {
  Artifact,
  LegacyArtifactPresentation,
  InventoryLegacyArtifact,
  InventoryArtifact,
  Revision,
} from "@opencode-panes/contracts";
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
import { CreatorWorkspace } from "./creator-workspace";
import { PublicWorkspace } from "./public-workspace";
import {
  ApiError,
  copyText,
  createSerializedPoller,
  downloadSource,
  fetchPrivateCurrent,
  fetchPrivateRevisions,
  fetchPrivateWorkspace,
  fetchCreatorWorkspace,
  fetchInventory,
  fetchPublicArtifact,
  fetchPublicationStatus,
  followCurrentRevision,
  includeRevision,
  issueInventoryReconnectCode,
  issueLegacyAdoptionCode,
  deleteInventoryArtifact,
  deleteLegacyInventoryArtifact,
  extendInventoryPublication,
  republishInventoryPublication,
  rotateInventoryCreator,
  selectRevision,
  unpublishInventoryPublication,
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
  legacy?: LegacyArtifactPresentation | { readOnly: true };
  publishedAt?: string;
  publicUrl?: string;
  revisions: Revision[];
  selection: RevisionSelection;
  setSelection: (selection: RevisionSelection) => void;
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
  if (route.kind === "creator")
    return <CreatorArtifactView token={route.token} />;
  if (route.kind === "shared")
    return <PublicArtifactView token={route.token} />;
  if (route.kind === "published")
    return <PublishedArtifactView token={route.token} />;
  if (route.kind === "inventory") return <InventoryPage />;
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
      Prepare or import a project-local Artifact, finalize a Revision, and use
      the explicit Sync result to open its Creator or public route. Legacy
      migration links may still use <code>/artifacts/:id</code> or{" "}
      <code>/shared/:token</code>. New publications use{" "}
      <code>/published/:token</code>.
    </EntryState>
  );
}

function InventoryPage() {
  const [inventory, setInventory] =
    useState<Awaited<ReturnType<typeof fetchInventory>>>();
  const [error, setError] = useState<unknown>();
  const [copyMessage, setCopyMessage] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchInventory(fetch, controller.signal).then(
      (loaded) => {
        setInventory(loaded);
        setError(undefined);
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      },
    );
    return () => controller.abort();
  }, []);

  if (error) {
    const unauthorized =
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403);
    return (
      <EntryState
        eyebrow={
          unauthorized ? "Inventory access denied" : "Inventory unavailable"
        }
        title={
          unauthorized
            ? "This cloud inventory requires your approved Access identity."
            : "The cloud inventory could not be loaded."
        }
      >
        {unauthorized
          ? "Sign in through Cloudflare Access with the approved account, then reload this page."
          : "Reload the page or try again later."}
      </EntryState>
    );
  }
  if (!inventory) return <LoadingState label="Loading cloud inventory" />;
  const legacyArtifacts = inventory.legacyArtifacts ?? [];
  if (inventory.projects.length === 0 && legacyArtifacts.length === 0) {
    return (
      <main className="inventory-shell" id="main-content">
        <InventoryHeader projectCount={0} />
        <section
          className="inventory-empty"
          aria-labelledby="inventory-empty-title"
        >
          <span className="eyebrow">NO SYNCHRONIZED ARTIFACTS</span>
          <h1 id="inventory-empty-title">Your cloud shelf is clear.</h1>
          <p>
            Sync a local Artifact from OpenCode to see its cloud history here.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="inventory-shell" id="main-content">
      <InventoryHeader projectCount={inventory.projects.length} />
      {legacyArtifacts.length > 0 ? (
        <section className="inventory-project" aria-labelledby="legacy-heading">
          <header className="inventory-project-header">
            <div>
              <span className="eyebrow">LEGACY</span>
              <h2 id="legacy-heading">Read-only cloud history</h2>
            </div>
            <span className="inventory-project-count">
              {legacyArtifacts.length} artifact
              {legacyArtifacts.length === 1 ? "" : "s"}
            </span>
          </header>
          <div className="inventory-artifacts">
            {legacyArtifacts.map((artifact) => (
              <LegacyInventoryArtifactCard
                artifact={artifact}
                key={artifact.artifactId}
                onRefresh={async () => {
                  const loaded = await fetchInventory();
                  setInventory(loaded);
                  setError(undefined);
                }}
                onNotice={setCopyMessage}
              />
            ))}
          </div>
        </section>
      ) : null}
      <div className="inventory-projects">
        {inventory.projects.map((project) => (
          <section
            className="inventory-project"
            key={project.projectId}
            aria-labelledby={`project-${project.projectId}`}
          >
            <header className="inventory-project-header">
              <div>
                <span className="eyebrow">PROJECT</span>
                <h2 id={`project-${project.projectId}`}>{project.projectId}</h2>
              </div>
              <span className="inventory-project-count">
                {project.artifacts.length} artifact
                {project.artifacts.length === 1 ? "" : "s"}
              </span>
            </header>
            <div className="inventory-artifacts">
              {project.artifacts.map((artifact) => (
                <InventoryArtifactCard
                  artifact={artifact}
                  copyMessage={copyMessage}
                  key={artifact.artifactId}
                  onRefresh={async () => {
                    const loaded = await fetchInventory();
                    setInventory(loaded);
                    setError(undefined);
                  }}
                  onNotice={setCopyMessage}
                  onCopy={async () => {
                    if (!artifact.publication.publicUrl) return;
                    try {
                      await copyText(artifact.publication.publicUrl);
                      setCopyMessage(`${artifact.title} public URL copied`);
                    } catch {
                      setCopyMessage("Clipboard access is unavailable");
                    }
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="inventory-feedback" aria-live="polite">
        {copyMessage}
      </div>
    </main>
  );
}

function LegacyInventoryArtifactCard({
  artifact,
  onNotice,
  onRefresh,
}: {
  artifact: InventoryLegacyArtifact;
  onNotice: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [adoption, setAdoption] = useState<{
    code: string;
    expiresAt: string;
    revisionVersion: number;
    type: InventoryLegacyArtifact["type"];
  }>();
  const [confirmation, setConfirmation] = useState("");
  const deletionConfirmation = `DELETE CLOUD COPY OF ${artifact.title}`;
  const expired = artifact.status === "expired";
  return (
    <article className="inventory-card">
      <header className="inventory-card-header">
        <div>
          <span className="eyebrow">LEGACY ARTIFACT</span>
          <h3>{artifact.title}</h3>
          <code>{artifact.artifactId}</code>
        </div>
        <span className={`inventory-state is-${artifact.status}`}>
          {artifact.status}
        </span>
      </header>
      <dl className="inventory-facts">
        <div>
          <dt>Revisions</dt>
          <dd>{artifact.revisionCount}</dd>
        </div>
        <div>
          <dt>Stored bytes</dt>
          <dd>{formatBytes(artifact.storageBytes)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatInventoryTime(artifact.updatedAt)}</dd>
        </div>
        <div>
          <dt>Private access</dt>
          <dd>{expired ? "expired" : "read-only"}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{formatInventoryTime(artifact.privateExpiresAt)}</dd>
        </div>
        <div>
          <dt>Publication</dt>
          <dd>
            {artifact.publicationStatus === "none"
              ? "none"
              : `${artifact.publicationStatus}, expires ${formatInventoryTime(artifact.publicationExpiresAt)}`}
          </dd>
        </div>
      </dl>
      <p className="inventory-warning">
        Legacy artifacts preserve their historical source and share records.
        They cannot be edited, published, or extended.
      </p>
      <div className="inventory-delete-action">
        <label htmlFor={`legacy-delete-${artifact.artifactId}`}>
          Type <code>{deletionConfirmation}</code> to permanently remove this
          Legacy artifact and its historical records.
        </label>
        <input
          id={`legacy-delete-${artifact.artifactId}`}
          onChange={(event) => setConfirmation(event.target.value)}
          value={confirmation}
        />
        <button
          className="inventory-danger"
          disabled={busy || confirmation !== deletionConfirmation}
          onClick={() => {
            setBusy(true);
            void deleteLegacyInventoryArtifact(
              artifact.artifactId,
              confirmation,
            )
              .then(
                async () => {
                  await onRefresh();
                  onNotice(`${artifact.title}: Legacy artifact deleted`);
                },
                (error: unknown) =>
                  onNotice(`${artifact.title}: ${apiErrorMessage(error)}`),
              )
              .finally(() => setBusy(false));
          }}
          type="button"
        >
          {busy ? "Deleting…" : "Delete Legacy artifact"}
        </button>
      </div>
      <div className="inventory-adoption-action">
        <button
          disabled={busy || expired}
          onClick={() => {
            setBusy(true);
            void issueLegacyAdoptionCode(artifact.artifactId)
              .then((issued) => {
                setAdoption({
                  code: issued.code,
                  expiresAt: issued.expiresAt,
                  revisionVersion: issued.source.revisionVersion,
                  type: issued.source.type,
                });
                onNotice(`${artifact.title}: adoption code issued`);
              })
              .catch((error: unknown) =>
                onNotice(`${artifact.title}: ${apiErrorMessage(error)}`),
              )
              .finally(() => setBusy(false));
          }}
          type="button"
        >
          {busy ? "Issuing…" : "Export / adopt locally"}
        </button>
        {adoption ? (
          <p>
            Copy this one-time code now. It is not stored in the browser.
            <br />
            Current {adoption.type} v{adoption.revisionVersion}. Expires{" "}
            {formatInventoryTime(adoption.expiresAt)}.
            <br />
            <code>{adoption.code}</code>
            <button
              onClick={() => {
                void copyText(adoption.code).then(
                  () => onNotice(`${artifact.title}: adoption code copied`),
                  () => onNotice("Clipboard access is unavailable"),
                );
              }}
              type="button"
            >
              Copy code
            </button>
          </p>
        ) : null}
      </div>
    </article>
  );
}

function InventoryHeader({ projectCount }: { projectCount: number }) {
  return (
    <header className="inventory-header">
      <div className="inventory-heading">
        <span className="brand-mark" aria-hidden="true">
          OP
        </span>
        <div>
          <span className="eyebrow">CLOUD INVENTORY</span>
          <h1>Everything synchronized, in one quiet view.</h1>
        </div>
      </div>
      <p className="inventory-summary">
        {projectCount} project{projectCount === 1 ? "" : "s"} · operator
        controls
      </p>
    </header>
  );
}

function InventoryArtifactCard({
  artifact,
  copyMessage,
  onCopy,
  onNotice,
  onRefresh,
}: {
  artifact: InventoryArtifact;
  copyMessage?: string | undefined;
  onCopy: () => Promise<void>;
  onNotice: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string>();
  const [durationDays, setDurationDays] = useState<1 | 7 | 30>(7);
  const [revisionVersion, setRevisionVersion] = useState(
    artifact.revisions[0]?.version ?? artifact.publication.revisionVersion ?? 0,
  );
  const [confirmation, setConfirmation] = useState("");
  const [rotatedCreator, setRotatedCreator] = useState<{
    url: string;
    expiresAt: string;
  }>();
  const [reconnectCode, setReconnectCode] = useState<{
    code: string;
    expiresAt: string;
  }>();
  const [reconnectConfirmation, setReconnectConfirmation] = useState("");
  const publication = artifact.publication;
  const deleting = artifact.lifecycleState === "deleting";
  const deletionConfirmation = `DELETE CLOUD COPY OF ${artifact.title}`;
  useEffect(() => {
    if (deleting) {
      setRotatedCreator(undefined);
      setReconnectCode(undefined);
      setReconnectConfirmation("");
    }
  }, [deleting]);
  const runAction = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      await onRefresh();
      onNotice(`${artifact.title}: ${label} complete`);
    } catch (error) {
      onNotice(`${artifact.title}: ${apiErrorMessage(error)}`);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <article className="inventory-card">
      <header className="inventory-card-header">
        <div>
          <span className="eyebrow">
            {artifact.legacyProvenance ? "ADOPTED LOCALLY" : "ARTIFACT"}
          </span>
          <h3>{artifact.title}</h3>
          <code>{artifact.slug}</code>
        </div>
        <span
          className={`inventory-state is-${deleting ? "deleting" : publication.status}`}
        >
          {deleting ? "deleting" : publication.status}
        </span>
      </header>
      {artifact.legacyProvenance ? (
        <p className="inventory-warning">
          Adopted from Legacy artifact{" "}
          <code>{artifact.legacyProvenance.legacyArtifactId}</code>, source v
          {artifact.legacyProvenance.legacyRevisionVersion}. The Legacy source
          remains separate and read-only.
        </p>
      ) : null}
      <dl className="inventory-facts">
        <div>
          <dt>Revisions</dt>
          <dd>{artifact.revisionCount}</dd>
        </div>
        <div>
          <dt>Committed storage</dt>
          <dd>{formatBytes(artifact.storageBytes)}</dd>
        </div>
        <div>
          <dt>Last Sync</dt>
          <dd>{formatInventoryTime(artifact.lastSyncedAt)}</dd>
        </div>
        <div>
          <dt>Creator link</dt>
          <dd>
            {artifact.creatorLink.status}, expires{" "}
            {formatInventoryTime(artifact.creatorLink.expiresAt)}
          </dd>
        </div>
        <div>
          <dt>Publication</dt>
          <dd>
            {publication.status === "none"
              ? "none"
              : `v${publication.revisionVersion}, expires ${formatInventoryTime(publication.expiresAt)}`}
          </dd>
        </div>
      </dl>
      {publication.publicUrl ? (
        <div className="inventory-public-link">
          <a href={publication.publicUrl} rel="noreferrer" target="_blank">
            {publication.publicUrl}
          </a>
          <button onClick={() => void onCopy()} type="button">
            Copy public URL
          </button>
          {copyMessage?.startsWith(artifact.title) ? (
            <span role="status">{copyMessage}</span>
          ) : null}
        </div>
      ) : null}
      <div
        className="inventory-actions"
        aria-label={`${artifact.title} actions`}
      >
        {deleting ? (
          <p className="inventory-warning" role="status">
            Cloud deletion is in progress. Re-enter the confirmation to resume
            cleanup if needed.
          </p>
        ) : null}
        <div className="inventory-action-group">
          <button
            disabled={Boolean(busy) || deleting}
            onClick={() =>
              void runAction("Creator link rotated", () =>
                rotateInventoryCreator(artifact.artifactId).then((rotated) => {
                  setRotatedCreator({
                    url: rotated.creatorUrl,
                    expiresAt: rotated.creatorExpiresAt,
                  });
                }),
              )
            }
            type="button"
          >
            {busy === "Creator link rotated"
              ? "Rotating…"
              : "Rotate Creator link"}
          </button>
          <label>
            Duration
            <select
              disabled={Boolean(busy) || deleting}
              onChange={(event) =>
                setDurationDays(Number(event.target.value) as 1 | 7 | 30)
              }
              value={durationDays}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <button
            disabled={
              Boolean(busy) || deleting || publication.status !== "active"
            }
            onClick={() =>
              void runAction("Publication extended", () =>
                extendInventoryPublication(artifact.artifactId, durationDays),
              )
            }
            type="button"
          >
            Extend publication
          </button>
          <button
            disabled={
              Boolean(busy) || deleting || publication.status !== "active"
            }
            onClick={() =>
              void runAction("Publication unpublished", () =>
                unpublishInventoryPublication(artifact.artifactId),
              )
            }
            type="button"
          >
            Unpublish
          </button>
        </div>
        <div className="inventory-reconnect-action">
          <label htmlFor={`reconnect-${artifact.artifactId}`}>
            Type <code>{reconnectConfirmationText(artifact)}</code> to replace
            the current Owner credential
          </label>
          <input
            id={`reconnect-${artifact.artifactId}`}
            onChange={(event) => setReconnectConfirmation(event.target.value)}
            value={reconnectConfirmation}
          />
          <button
            disabled={
              Boolean(busy) ||
              deleting ||
              reconnectConfirmation !== reconnectConfirmationText(artifact)
            }
            onClick={() =>
              void runAction("Reconnect code issued", async () => {
                const issued = await issueInventoryReconnectCode(
                  artifact.artifactId,
                  reconnectConfirmation,
                );
                setReconnectCode({
                  code: issued.reconnectCode,
                  expiresAt: issued.expiresAt,
                });
                setReconnectConfirmation("");
              })
            }
            type="button"
          >
            {busy === "Reconnect code issued"
              ? "Issuing…"
              : "Issue reconnect code"}
          </button>
          {reconnectCode ? (
            <div className="inventory-reconnect-code" role="alert">
              <strong>Copy this code now. It will not be shown again.</strong>
              <code>{reconnectCode.code}</code>
              <span>
                Expires {formatInventoryTime(reconnectCode.expiresAt)} (10
                minutes)
              </span>
              <button
                aria-label="Copy reconnect code"
                onClick={() =>
                  void copyText(reconnectCode.code).then(
                    () => onNotice(`${artifact.title} reconnect code copied`),
                    () => onNotice("Clipboard access is unavailable"),
                  )
                }
                type="button"
              >
                Copy reconnect code
              </button>
            </div>
          ) : null}
        </div>
        {rotatedCreator ? (
          <div className="inventory-creator-link">
            <span className="eyebrow">NEW CREATOR LINK</span>
            <a href={rotatedCreator.url} rel="noreferrer" target="_blank">
              {rotatedCreator.url}
            </a>
            <span>
              Expires {formatInventoryTime(rotatedCreator.expiresAt)} (30 days)
            </span>
            <button
              onClick={() =>
                void copyText(rotatedCreator.url).then(
                  () => onNotice(`${artifact.title} Creator URL copied`),
                  () => onNotice("Clipboard access is unavailable"),
                )
              }
              type="button"
            >
              Copy Creator URL
            </button>
          </div>
        ) : null}
        <div className="inventory-action-group">
          <label>
            Republish revision
            <select
              disabled={
                Boolean(busy) || deleting || artifact.revisions.length === 0
              }
              onChange={(event) =>
                setRevisionVersion(Number(event.target.value))
              }
              value={revisionVersion}
            >
              {artifact.revisions.map((revision) => (
                <option key={revision.version} value={revision.version}>
                  v{revision.version}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={
              Boolean(busy) || deleting || artifact.revisions.length === 0
            }
            onClick={() =>
              void runAction("Publication republished", () =>
                republishInventoryPublication(
                  artifact.artifactId,
                  revisionVersion,
                  durationDays,
                ),
              )
            }
            type="button"
          >
            Republish
          </button>
        </div>
        <div className="inventory-delete-action">
          <label htmlFor={`delete-${artifact.artifactId}`}>
            Type <code>{deletionConfirmation}</code> to permanently remove
            Creator/public links, cloud metadata, and stored bytes. Canonical
            local files remain unchanged.
          </label>
          <input
            id={`delete-${artifact.artifactId}`}
            onChange={(event) => setConfirmation(event.target.value)}
            value={confirmation}
          />
          <button
            className="inventory-danger"
            disabled={Boolean(busy) || confirmation !== deletionConfirmation}
            onClick={() =>
              void runAction("Cloud copy deleted", () =>
                deleteInventoryArtifact(artifact.artifactId, confirmation),
              )
            }
            type="button"
          >
            Delete cloud copy
          </button>
        </div>
      </div>
      {artifact.warnings.map((warning) => (
        <p className="inventory-warning" key={warning} role="alert">
          {warning}
        </p>
      ))}
    </article>
  );
}

function CreatorArtifactView({ token }: { token: string }) {
  const [workspace, setWorkspace] =
    useState<Awaited<ReturnType<typeof fetchCreatorWorkspace>>>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchCreatorWorkspace(token, fetch, controller.signal).then(
      (loaded) => {
        setWorkspace(loaded);
        setError(undefined);
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) {
          setWorkspace(undefined);
          setError(caught);
        }
      },
    );
    return () => controller.abort();
  }, [token]);

  if (error) {
    const status = error instanceof ApiError ? error.status : 0;
    const expired = status === 410;
    const missing = status === 404;
    return (
      <EntryState
        eyebrow={
          expired
            ? "Creator link expired"
            : missing
              ? "Creator link not found"
              : "Creator workspace unavailable"
        }
        title={
          expired
            ? "This creator workspace has expired."
            : missing
              ? "This creator workspace does not exist."
              : "The creator workspace could not be loaded."
        }
      >
        {expired
          ? "Reopen the artifact through OpenCode or the Cloud inventory to request a fresh Creator link."
          : missing
            ? "Check the Creator link and open it again."
            : `${apiErrorMessage(error)} Reload the page or try again later.`}
      </EntryState>
    );
  }
  if (!workspace) return <LoadingState label="Loading creator workspace" />;
  return <CreatorWorkspace token={token} workspace={workspace} />;
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
  const [legacy, setLegacy] = useState<LegacyArtifactPresentation>();
  const [error, setError] = useState<unknown>();
  const [refreshError, setRefreshError] = useState<string>();
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
        setLegacy(current.legacy);
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
        setError(caught);
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
      setLegacy(current.legacy);
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
          ? "The legacy migration workspace token in this link is malformed. Return to Inventory or OpenCode and request a current Creator route again."
          : "Open the complete viewer URL from OpenCode. It includes a one-time #workspaceToken fragment that this tab stores only for this artifact."}
      </EntryState>
    );
  }

  if (error) {
    const invalidToken =
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403);
    const expired = error instanceof ApiError && error.status === 410;
    return (
      <EntryState
        eyebrow={
          invalidToken
            ? "Workspace access denied"
            : expired
              ? "Legacy artifact expired"
              : "API request failed"
        }
        title={
          invalidToken
            ? "The saved token is no longer valid."
            : expired
              ? "This legacy artifact has expired."
              : "The artifact could not be loaded."
        }
      >
        {apiErrorMessage(error)}{" "}
        {invalidToken
          ? "Open a fresh viewer URL from OpenCode."
          : expired
            ? "Legacy artifacts are read-only and available only for a bounded period."
            : "Check the local server and reload this page."}
      </EntryState>
    );
  }

  if (!artifact || !selection)
    return <LoadingState label="Loading creator workspace" />;

  return (
    <>
      <ArtifactWorkspace
        artifact={artifact}
        isPublic={false}
        {...(legacy ? { legacy } : {})}
        revisions={revisions}
        selection={selection}
        setSelection={setSelection}
      />
      {refreshError ? (
        <div className="connection-notice" role="status">
          Live update paused: {refreshError}
        </div>
      ) : null}
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
    const expired = error.startsWith("This legacy share has expired");
    return (
      <EntryState
        eyebrow={
          expired ? "Legacy share expired" : "Public artifact unavailable"
        }
        title={
          expired
            ? "This legacy share has expired."
            : "This share cannot be opened."
        }
      >
        {error}{" "}
        {expired
          ? "Legacy shares are available only for a bounded period."
          : "The link may have been revoked or replaced by a newer published version."}
      </EntryState>
    );
  }
  if (!response) return <LoadingState label="Loading public artifact" />;

  return (
    <ArtifactWorkspace
      artifact={response.artifact}
      isPublic
      {...(response.legacy ? { legacy: response.legacy } : {})}
      publishedAt={response.publishedAt}
      publicUrl={window.location.href}
      revisions={[response.revision]}
      selection={{ followLatest: false, revisionId: response.revision.id }}
      setSelection={() => undefined}
    />
  );
}

function PublishedArtifactView({ token }: { token: string }) {
  const [status, setStatus] =
    useState<Awaited<ReturnType<typeof fetchPublicationStatus>>>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    const controller = new AbortController();
    void fetchPublicationStatus(token, fetch, controller.signal).then(
      (loaded) => setStatus(loaded),
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      },
    );
    return () => controller.abort();
  }, [token]);

  if (error) {
    const statusCode = error instanceof ApiError ? error.status : 0;
    const expired = statusCode === 410;
    const missing = statusCode === 404;
    return (
      <EntryState
        eyebrow={
          expired
            ? "Publication inactive"
            : missing
              ? "Publication not found"
              : "Publication unavailable"
        }
        title={
          expired
            ? "This publication is no longer active."
            : missing
              ? "This publication does not exist."
              : "This publication cannot be opened."
        }
      >
        {expired
          ? "The public link has expired or was revoked."
          : missing
            ? "Check the publication link and open it again."
            : `${apiErrorMessage(error)} Reload the page or try again later.`}
      </EntryState>
    );
  }
  if (!status) return <LoadingState label="Loading publication" />;
  return <PublicWorkspace token={token} workspace={status} />;
}

function ArtifactWorkspace({
  artifact,
  isPublic,
  legacy,
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
            {legacy ? (
              <span className="eyebrow" role="status">
                LEGACY · READ-ONLY
                {"privateExpiresAt" in legacy
                  ? ` · EXPIRES ${formatTimestamp(legacy.privateExpiresAt)}`
                  : ""}
              </span>
            ) : null}
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
            ) : null}
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
                : "Preview loaded"}
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
          {actionFeedback ? <strong>{actionFeedback}</strong> : null}
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

function formatInventoryTime(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function reconnectConfirmationText(artifact: InventoryArtifact): string {
  return `RECOVER OWNER CREDENTIAL FOR ARTIFACT ${artifact.artifactId}: REDEMPTION REPLACES THE CURRENT OWNER CREDENTIAL (${artifact.title})`;
}
