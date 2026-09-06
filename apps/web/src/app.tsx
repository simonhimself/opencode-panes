import type {
  ArtifactLibrary,
  ArtifactShare,
  ArtifactVersion,
  LibraryArtifact,
  Project,
  PublicArtifact,
  ShareRequest,
} from "@opencode-panes/contracts";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { errorMessage, request } from "./http";

function navigate(href: string) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function locationKey() {
  if (window.location.pathname === "/")
    window.history.replaceState(null, "", "/inventory");
  return window.location.pathname + window.location.search;
}

// A single request per resource, with cancellation on navigation, refresh, or mutation.
function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [generation, setGeneration] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!path) return;
    const load = () => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setLoading(true);
      setError(null);
      void request<T>(path, { signal: current.signal })
        .then((result) => {
          if (!current.signal.aborted) setData(result);
        })
        .catch((reason: unknown) => {
          if (!current.signal.aborted) {
            setData(null);
            setError(reason);
          }
        })
        .finally(() => {
          if (!current.signal.aborted) setLoading(false);
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      controller.current?.abort();
      window.removeEventListener("focus", load);
    };
  }, [path, generation]);
  return {
    data,
    error,
    loading,
    refresh: () => setGeneration((value) => value + 1),
    replace: (update: (current: T) => T) => {
      controller.current?.abort();
      setData((current) => (current === null ? null : update(current)));
      setError(null);
      setLoading(false);
    },
  };
}

function Icon({
  name,
}: {
  name: "grid" | "folder" | "search" | "refresh" | "arrow" | "copy" | "link";
}) {
  const paths = {
    grid: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6z",
    folder: "M3 7V5h6l2 2h10v13H3V7Z",
    search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    refresh: "M20 7a9 9 0 1 0 1 9M20 2v6h-6",
    arrow: "M6 18 18 6M6 6h12v12",
    copy: "M8 8h13v13H8zM16 8V3H3v13h5",
    link: "m9 15 6-6M7 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M17 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function Brand({ linked = true }: { linked?: boolean }) {
  const content = (
    <>
      <span className="panes-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        Panes<span className="brand-period">.</span>
      </span>
    </>
  );
  return linked ? (
    <a className="brand" href="/inventory" aria-label="Panes library">
      {content}
    </a>
  ) : (
    <div className="brand">{content}</div>
  );
}

function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function expiry(share: { expiresAt: string | null }, expired = false) {
  if (!share.expiresAt) return "No expiry";
  return `${expired ? "Expired" : "Expires"} ${new Date(share.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}

function status(share: ArtifactShare | null): "Private" | "Shared" | "Expired" {
  if (!share) return "Private";
  return share.status === "expired" ||
    (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now())
    ? "Expired"
    : "Shared";
}

function Badge({ share }: { share: ArtifactShare | null }) {
  const label = status(share);
  return (
    <span className={`badge badge-${label.toLowerCase()}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

function Preview({
  version,
  title,
  thumbnail = false,
}: {
  version: ArtifactVersion;
  title: string;
  thumbnail?: boolean;
}) {
  return (
    <div className={thumbnail ? "thumbnail" : "preview-frame"}>
      <iframe
        key={version.previewUrl}
        src={version.previewUrl}
        title={`${title}, version ${version.number} preview`}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        loading={thumbnail ? "lazy" : "eager"}
        tabIndex={thumbnail ? -1 : 0}
        aria-hidden={thumbnail || undefined}
      />
    </div>
  );
}

function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={error ? "notice notice-error" : "notice"}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

function Refresh({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="button button-quiet"
      onClick={onClick}
      disabled={loading}
    >
      <Icon name="refresh" />
      {loading ? "Refreshing..." : "Refresh"}
    </button>
  );
}

function Rail({
  projects,
  artifacts,
  projectId,
}: {
  projects: Project[];
  artifacts: LibraryArtifact[];
  projectId: string | null;
}) {
  return (
    <aside className="rail">
      <Brand />
      <nav aria-label="Projects">
        <a
          className={`project-link ${projectId === null ? "selected" : ""}`}
          href="/inventory"
          aria-current={projectId === null ? "page" : undefined}
        >
          <Icon name="grid" />
          <span>All artifacts</span>
          <span className="project-count">{artifacts.length}</span>
        </a>
        <p className="rail-label">
          Projects <span>{projects.length}</span>
        </p>
        {projects.map((project) => (
          <a
            key={project.id}
            className={`project-link ${projectId === project.id ? "selected" : ""}`}
            href={`/inventory?project=${encodeURIComponent(project.id)}`}
            aria-current={projectId === project.id ? "page" : undefined}
          >
            <Icon name="folder" />
            <span className="project-name">{project.name}</span>
            <span className="project-count">
              {
                artifacts.filter(
                  (artifact) => artifact.projectId === project.id,
                ).length
              }
            </span>
          </a>
        ))}
      </nav>
      <div className="rail-note">
        <span className="tiny-window" aria-hidden="true" />
        <p>
          Made in OpenCode.
          <br />
          <strong>Collected here.</strong>
        </p>
        <span>
          Upload a file or folder from OpenCode to add it to your library.
        </span>
      </div>
    </aside>
  );
}

function Gallery({
  library,
  projectId,
}: {
  library: ArtifactLibrary;
  projectId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const project = library.projects.find((item) => item.id === projectId);
  const artifacts = library.artifacts
    .filter((artifact) => {
      const projectName =
        library.projects.find((item) => item.id === artifact.projectId)?.name ??
        "";
      return (
        (!projectId || artifact.projectId === projectId) &&
        (filter === "All" || status(artifact.share) === filter) &&
        `${artifact.title} ${projectName}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      );
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">Your workspace</p>
        <h1>
          {project?.name ??
            (projectId ? "Project not found" : "A place for your work.")}
        </h1>
        <p>Ideas, experiments, and finished things. All in view.</p>
      </header>
      <div className="gallery-toolbar">
        <div
          className="filters"
          role="group"
          aria-label="Filter by sharing status"
        >
          {["All", "Private", "Shared", "Expired"].map((label) => (
            <button
              key={label}
              aria-pressed={filter === label}
              onClick={() => setFilter(label)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" />
          <span className="sr-only">Search artifacts</span>
          <input
            type="search"
            placeholder="Search your artifacts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="section-line">
        <h2>{project?.name ?? "All artifacts"}</h2>
        <span role="status">
          {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"}
        </span>
      </div>
      {artifacts.length ? (
        <div className="artifact-grid">
          {artifacts.map((artifact) => {
            const latest = [...artifact.versions].sort(
              (a, b) => b.number - a.number,
            )[0];
            const name =
              library.projects.find((item) => item.id === artifact.projectId)
                ?.name ?? "Project";
            const sharedVersion =
              status(artifact.share) === "Shared"
                ? artifact.versions.find(
                    (item) => item.id === artifact.share?.versionId,
                  )
                : undefined;
            return (
              <a
                className="artifact-card"
                key={artifact.id}
                href={`/inventory/artifacts/${encodeURIComponent(artifact.id)}`}
              >
                <div className="card-window">
                  <div className="window-chrome" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <i />
                  </div>
                  {latest ? (
                    <Preview
                      version={latest}
                      title={artifact.title}
                      thumbnail
                    />
                  ) : (
                    <div className="preview-unavailable">
                      Preview unavailable
                    </div>
                  )}
                  <span className="card-open" aria-hidden="true">
                    <Icon name="arrow" />
                  </span>
                </div>
                <div className="card-info">
                  <div className="card-project">{name}</div>
                  <h3>{artifact.title}</h3>
                  <div className="card-meta">
                    <Badge share={artifact.share} />
                    <span>
                      {latest
                        ? sharedVersion && sharedVersion.id !== latest.id
                          ? `Latest v${latest.number} / Shared v${sharedVersion.number}`
                          : `v${latest.number}`
                        : "No version"}
                    </span>
                  </div>
                  <p className="card-date">
                    {artifact.share
                      ? expiry(
                          artifact.share,
                          status(artifact.share) === "Expired",
                        )
                      : `Uploaded ${date(artifact.updatedAt)}`}
                  </p>
                </div>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <span className="empty-mark" aria-hidden="true">
            <span className="panes-mark">
              <i />
              <i />
              <i />
            </span>
          </span>
          <h2>
            {library.artifacts.length
              ? "Nothing in this view yet."
              : "Your next idea belongs here."}
          </h2>
          <p>
            {library.artifacts.length
              ? "Try another project, change a filter, or search for something else."
              : "Ask OpenCode to upload a file or folder. It will appear here, private until you choose to share it."}
          </p>
          {query || filter !== "All" ? (
            <button
              className="button"
              onClick={() => {
                setQuery("");
                setFilter("All");
              }}
            >
              Clear search and filters
            </button>
          ) : null}
        </div>
      )}
      <p className="gallery-footnote">
        Your uploads start private. Share only when you're ready.
      </p>
    </>
  );
}

function Confirmation({
  title,
  children,
  confirmLabel,
  busy,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div
        ref={dialog}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-description"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
          if (event.key === "Tab") {
            const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            );
            const first = buttons?.[0];
            const last = buttons?.[buttons.length - 1];
            if (!first) {
              event.preventDefault();
              return;
            }
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <p className="eyebrow">One last check</p>
        <h2 id="confirmation-title">{title}</h2>
        <div id="confirmation-description">{children}</div>
        <div className="dialog-actions">
          <button
            ref={cancel}
            className="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className={`button ${danger ? "button-danger" : "button-primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArtifactDetail({
  id,
  projects,
  onChanged,
  onDeleted,
}: {
  id: string;
  projects: Project[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const endpoint = `/api/library/artifacts/${encodeURIComponent(id)}`;
  const resource = useResource<LibraryArtifact>(endpoint);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [days, setDays] = useState<ShareRequest["expiresInDays"]>(null);
  const [confirmation, setConfirmation] = useState<
    | {
        kind: "share";
        version: ArtifactVersion;
        days: ShareRequest["expiresInDays"];
        updating: boolean;
      }
    | { kind: "unpublish" | "delete" }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  const mutationPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const artifact = resource.data;
  const versions = [...(artifact?.versions ?? [])].sort(
    (a, b) => b.number - a.number,
  );
  const version =
    versions.find((item) => item.id === selectedId) ?? versions[0];
  const project = projects.find((item) => item.id === artifact?.projectId);
  const shared = artifact ? status(artifact.share) === "Shared" : false;

  async function mutate() {
    if (!artifact || !confirmation || mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      if (confirmation.kind === "share") {
        const share = await request<ArtifactShare>(`${endpoint}/share`, {
          method: "PUT",
          body: JSON.stringify({
            versionId: confirmation.version.id,
            expiresInDays: confirmation.days,
          } satisfies ShareRequest),
        });
        if (!mounted.current) {
          onChanged();
          return;
        }
        resource.replace((current) => ({ ...current, share }));
        setMessage(
          confirmation.updating
            ? "Shared version updated. Your link stays the same."
            : "Published. Your link is ready to share.",
        );
      } else if (confirmation.kind === "unpublish") {
        await request<void>(`${endpoint}/share`, { method: "DELETE" });
        if (!mounted.current) {
          onChanged();
          return;
        }
        resource.replace((current) => ({ ...current, share: null }));
        setMessage("Unpublished. The old link no longer works.");
      } else {
        await request<void>(endpoint, { method: "DELETE" });
        if (mounted.current) onDeleted();
        else onChanged();
        return;
      }
      onChanged();
      resource.refresh();
      setConfirmation(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!artifact?.share) return;
    setMessage("");
    setActionError(null);
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(artifact.share.url);
      setMessage("Link copied.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setActionError(
        "Could not copy automatically. The link is selected; use your browser's Copy command.",
      );
    }
  }

  if (!artifact)
    return (
      <div className="detail-loading">
        <a className="text-link" href="/inventory">
          Back to library
        </a>
        {resource.error ? (
          <Notice error>{errorMessage(resource.error)}</Notice>
        ) : (
          <Notice>Loading artifact...</Notice>
        )}
        <Refresh loading={resource.loading} onClick={resource.refresh} />
      </div>
    );
  return (
    <>
      <div className="detail-top">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <a href="/inventory">Library</a>
          <span aria-hidden="true">/</span>
          <a
            href={`/inventory?project=${encodeURIComponent(artifact.projectId)}`}
          >
            {project?.name ?? "Project"}
          </a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{artifact.title}</span>
        </nav>
        <Refresh
          loading={resource.loading || busy}
          onClick={resource.refresh}
        />
      </div>
      <header className="detail-heading">
        <div>
          <p className="eyebrow">{project?.name ?? "Your artifact"}</p>
          <h1>{artifact.title}</h1>
        </div>
        <Badge share={artifact.share} />
      </header>
      {message ? <Notice>{message}</Notice> : null}
      {actionError && !confirmation ? (
        <Notice error>{actionError}</Notice>
      ) : null}
      <div className="detail-layout">
        <section className="preview-panel" aria-label="Artifact preview">
          <div className="preview-toolbar">
            <span className="preview-label">
              <span className="live-dot" />
              Preview
            </span>
            <label className="version-label">
              Version
              <select
                aria-label="Version"
                value={version?.id ?? ""}
                disabled={!version || busy}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {versions.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    Version {item.number}
                    {index === 0 ? " (latest)" : ""}
                    {artifact.share?.versionId === item.id && shared
                      ? " - shared"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {version ? (
            <Preview version={version} title={artifact.title} />
          ) : (
            <Notice>No uploaded versions are available.</Notice>
          )}
          <div className="preview-caption">
            <span>
              {version ? `Uploaded ${date(version.createdAt)}` : "No preview"}
            </span>
            <span>Isolated preview</span>
          </div>
        </section>
        <aside className="sharing-panel" aria-label="Sharing">
          <div className="share-heading">
            <span className="share-icon">
              <Icon name="link" />
            </span>
            <h2>Share your work.</h2>
          </div>
          <p>
            {shared
              ? "A window into the version you choose. Your other versions stay private."
              : "Make this artifact available to anyone with the link. You're in control."}
          </p>
          {artifact.share ? (
            <div className="share-summary">
              <Badge share={artifact.share} />
              <p>{expiry(artifact.share, !shared)}</p>
              {shared ? (
                <>
                  <p>
                    Sharing version{" "}
                    {versions.find(
                      (item) => item.id === artifact.share?.versionId,
                    )?.number ?? "previously uploaded"}
                  </p>
                  <label className="field-label" htmlFor="share-url">
                    Shared link
                  </label>
                  <input
                    ref={linkInput}
                    id="share-url"
                    className="share-url"
                    readOnly
                    value={artifact.share.url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <div className="link-actions">
                    <button className="button" onClick={() => void copyLink()}>
                      <Icon name="copy" />
                      Copy link
                    </button>
                    <a
                      className="button"
                      href={artifact.share.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open
                      <Icon name="arrow" />
                    </a>
                  </div>
                </>
              ) : (
                <p>
                  This link is no longer available. Publish again to create a
                  new one.
                </p>
              )}
            </div>
          ) : (
            <div className="private-note">
              <Badge share={null} />
              <span>Only you can see this artifact.</span>
            </div>
          )}
          <label className="field-label" htmlFor="expiry">
            Link expiry
          </label>
          <select
            id="expiry"
            value={days === null ? "none" : String(days)}
            disabled={busy}
            onChange={(event) =>
              setDays(
                event.target.value === "none"
                  ? null
                  : (Number(event.target.value) as 1 | 7 | 30),
              )
            }
          >
            <option value="none">No expiry</option>
            <option value="1">After 1 day</option>
            <option value="7">After 7 days</option>
            <option value="30">After 30 days</option>
          </select>
          <p className="field-hint">
            {shared
              ? "Applies when you update the shared version."
              : "Starts when you publish. You can unpublish at any time."}
          </p>
          <button
            className="button button-primary publish-button"
            disabled={!version || busy}
            onClick={() => {
              if (version) {
                setActionError(null);
                setConfirmation({
                  kind: "share",
                  version,
                  days,
                  updating: shared,
                });
              }
            }}
          >
            {shared ? "Update shared version" : "Publish"}
            <Icon name="arrow" />
          </button>
          <p className="share-version-note">
            {version
              ? `Selected: version ${version.number}`
              : "Choose a version to publish"}
          </p>
          {artifact.share ? (
            <button
              className="button button-quiet unpublish-button"
              disabled={busy}
              onClick={() => {
                setActionError(null);
                setConfirmation({ kind: "unpublish" });
              }}
            >
              Unpublish
            </button>
          ) : null}
        </aside>
      </div>
      <section className="delete-section" aria-label="Delete artifact">
        <div>
          <h2>Remove from your library</h2>
          <p>Deletes the cloud copy only. Your local files stay untouched.</p>
        </div>
        <button
          className="button button-delete"
          disabled={busy}
          onClick={() => {
            setActionError(null);
            setConfirmation({ kind: "delete" });
          }}
        >
          Delete artifact
        </button>
      </section>
      {confirmation ? (
        <Confirmation
          title={
            confirmation.kind === "share"
              ? `${confirmation.updating ? "Update to" : "Publish"} version ${confirmation.version.number}?`
              : confirmation.kind === "unpublish"
                ? "Unpublish this artifact?"
                : "Delete this artifact?"
          }
          confirmLabel={
            confirmation.kind === "share"
              ? confirmation.updating
                ? "Confirm update"
                : "Confirm publish"
              : confirmation.kind === "unpublish"
                ? "Confirm unpublish"
                : "Delete cloud copy"
          }
          busy={busy}
          danger={confirmation.kind !== "share"}
          onConfirm={() => void mutate()}
          onCancel={() => {
            setConfirmation(null);
            setActionError(null);
          }}
        >
          {confirmation.kind === "share" ? (
            <>
              <p>
                <strong>
                  {artifact.title}, version {confirmation.version.number}
                </strong>{" "}
                will be available to anyone with the link.
              </p>
              <p>
                All {confirmation.version.fileCount} uploaded{" "}
                {confirmation.version.fileCount === 1 ? "file" : "files"} in
                this version will be accessible, not just the preview.
              </p>
              <p>
                {confirmation.days === null
                  ? "The link will have no expiry."
                  : `The link will expire ${confirmation.days} ${confirmation.days === 1 ? "day" : "days"} after confirmation.`}{" "}
                {confirmation.updating
                  ? "Your active link stays the same."
                  : "Other versions stay private."}
              </p>
            </>
          ) : confirmation.kind === "unpublish" ? (
            <p>
              The shared link will stop working. The artifact stays in your
              library. Publishing again creates a new link.
            </p>
          ) : (
            <p>
              <strong>{artifact.title}</strong> and all uploaded versions will
              be permanently deleted from the cloud. Shared links will stop
              working. Your local files will not be changed. This cannot be
              undone.
            </p>
          )}
          {actionError ? <Notice error>{actionError}</Notice> : null}
        </Confirmation>
      ) : null}
    </>
  );
}

function Library({
  artifactId,
  projectId,
}: {
  artifactId: string | null;
  projectId: string | null;
}) {
  const resource = useResource<ArtifactLibrary>("/api/library");
  const library = resource.data;
  const activeProject = artifactId
    ? (library?.artifacts.find((item) => item.id === artifactId)?.projectId ??
      null)
    : projectId;
  return (
    <div className="workspace">
      <Rail
        projects={library?.projects ?? []}
        artifacts={library?.artifacts ?? []}
        projectId={activeProject}
      />
      <main
        id="main"
        tabIndex={-1}
        className={`workspace-main ${artifactId ? "workspace-detail" : ""}`}
      >
        {artifactId ? (
          <ArtifactDetail
            key={artifactId}
            id={artifactId}
            projects={library?.projects ?? []}
            onChanged={resource.refresh}
            onDeleted={() => {
              resource.refresh();
              navigate("/inventory");
            }}
          />
        ) : (
          <>
            <div className="workspace-top">
              <span className="workspace-label">Artifact library</span>
              <Refresh loading={resource.loading} onClick={resource.refresh} />
            </div>
            {resource.error ? (
              <Notice error>{errorMessage(resource.error)}</Notice>
            ) : library ? (
              <Gallery library={library} projectId={projectId} />
            ) : (
              <>
                <header className="page-heading">
                  <p className="eyebrow">Your workspace</p>
                  <h1>A place for your work.</h1>
                </header>
                <Notice>Loading your library...</Notice>
                <div className="loading-grid" aria-hidden="true">
                  <div />
                  <div />
                  <div />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function PublicView({ token }: { token: string }) {
  const resource = useResource<PublicArtifact>(
    `/api/shares/${encodeURIComponent(token)}`,
  );
  const artifact = resource.data;
  return (
    <div className="public-workspace">
      <header className="public-header">
        <Brand linked={false} />
        <span>Shared with you</span>
      </header>
      <main id="main" tabIndex={-1} className="public-main">
        {artifact ? (
          <>
            <div className="public-title">
              <div>
                <h1>{artifact.title}</h1>
                <p>
                  Version {artifact.version.number}{" "}
                  <span aria-hidden="true">/</span> {expiry(artifact)}
                </p>
              </div>
              <span className="readonly-label">Read-only</span>
            </div>
            <Preview version={artifact.version} title={artifact.title} />
            <footer className="public-footer">
              <span>
                An artifact shared with Panes. Content provided by its author.
              </span>
              <Refresh loading={resource.loading} onClick={resource.refresh} />
            </footer>
          </>
        ) : (
          <div className="public-state">
            <p className="eyebrow">Shared artifact</p>
            <h1>
              {resource.error
                ? "This window isn't open."
                : "Opening your preview."}
            </h1>
            {resource.error ? (
              <Notice error>{errorMessage(resource.error, true)}</Notice>
            ) : (
              <Notice>Loading shared artifact...</Notice>
            )}
            <Refresh loading={resource.loading} onClick={resource.refresh} />
          </div>
        )}
      </main>
    </div>
  );
}

export function App() {
  const [location, setLocation] = useState(locationKey);
  useEffect(() => {
    const onPopState = () => setLocation(locationKey());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location]);
  const url = new URL(location, window.location.origin);
  const detail = /^\/inventory\/artifacts\/([^/]+)\/?$/u.exec(url.pathname);
  const publicRoute = /^\/s\/([^/]+)\/?$/u.exec(url.pathname);
  let content: ReactNode;
  try {
    content = publicRoute ? (
      <PublicView
        key={publicRoute[1]}
        token={decodeURIComponent(publicRoute[1]!)}
      />
    ) : detail || /^\/inventory\/?$/u.test(url.pathname) ? (
      <Library
        artifactId={detail ? decodeURIComponent(detail[1]!) : null}
        projectId={url.searchParams.get("project")}
      />
    ) : (
      <main id="main" tabIndex={-1} className="not-found">
        <Brand />
        <h1>Nothing at this address.</h1>
        <a className="button" href="/inventory">
          Back to your library
        </a>
      </main>
    );
  } catch {
    content = (
      <main id="main" tabIndex={-1} className="not-found">
        <h1>This address is invalid.</h1>
        <a href="/inventory">Back to your library</a>
      </main>
    );
  }
  function followLink(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a[href]",
    );
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      link.target ||
      link.getAttribute("href")?.startsWith("#") ||
      link.hasAttribute("download")
    )
      return;
    const target = new URL(link.href);
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith("/inventory")
    )
      return;
    event.preventDefault();
    navigate(target.pathname + target.search);
  }
  return (
    <div onClick={followLink}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {content}
    </div>
  );
}
