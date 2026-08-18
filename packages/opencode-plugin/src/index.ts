import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  MAX_ARTIFACT_SOURCE_BYTES,
  WORKSPACE_TOKEN_FRAGMENT_KEY,
  artifactIdSchema,
  artifactTypeSchema,
  createArtifactRequestSchema,
  createArtifactResponseSchema,
  createRevisionRequestSchema,
  errorEnvelopeSchema,
  ownerTokenSchema,
  revisionResponseSchema,
  workspaceTokenSchema,
  type ArtifactType,
} from "@opencode-panes/contracts";
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const STATE_DIRECTORY_NAME = "opencode-panes";

const TOOL_DESCRIPTION = `Use this tool when the user explicitly requests an artifact, prototype, interactive design, diagram, visual explanation, substantial document, or standalone code preview. Prefer an artifact when the result is easier to understand visually than as terminal text. Omit artifactId to create an artifact. Reuse the returned artifact ID when the user asks to revise that artifact so Panes creates an immutable new version. Supply complete standalone source, not a patch or prose description. After success, present viewerUrl exactly as returned, including its fragment; never shorten, sanitize, or rewrite that URL.`;

export interface PanesPluginOptions {
  /** Panes API origin. Defaults to the local Vite/Workers development server. */
  apiBaseUrl?: string;
  /** Optional admission key for creating artifacts on a protected Panes API. */
  createApiKey?: string;
  /** Open the viewer after a successful upload. Requires a separate permission. */
  autoOpen?: boolean;
  /** Abort API requests after this many milliseconds. */
  requestTimeoutMs?: number;
}

interface ResolvedOptions {
  apiBaseUrl: URL;
  autoOpen: boolean;
  createApiKey?: string;
  requestTimeoutMs: number;
}

interface StoredArtifactState {
  apiOrigin: string;
  artifactId: string;
  ownerToken: string;
  viewerUrl: string;
  title: string;
  type: ArtifactType;
}

type AutoOpenStatus = "disabled" | "opened" | "permission-denied" | "failed";

export const OpenCodePanesPlugin: Plugin = async (_input, pluginOptions) => {
  const options = resolveOptions(pluginOptions);

  return {
    tool: {
      artifact: tool({
        description: TOOL_DESCRIPTION,
        args: {
          artifactId: tool.schema
            .string()
            .min(1)
            .max(128)
            .regex(/^\S+$/)
            .optional()
            .describe(
              "Existing Panes artifact ID when creating a new revision. Omit only for a new artifact.",
            ),
          title: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("Short human-readable artifact title."),
          type: tool.schema
            .enum(["html", "react", "svg", "mermaid", "markdown", "code"])
            .describe("Renderer for this artifact."),
          source: tool.schema
            .string()
            .min(1)
            .describe(
              `Complete standalone artifact source, limited to ${MAX_ARTIFACT_SOURCE_BYTES} UTF-8 bytes.`,
            ),
        },
        async execute(args, context) {
          if (args.artifactId) {
            return updateArtifact(
              { ...args, artifactId: args.artifactId },
              context,
              options,
            );
          }

          return createArtifact(
            {
              title: args.title,
              type: args.type,
              source: args.source,
            },
            context,
            options,
          );
        },
      }),
    },
  };
};

export default OpenCodePanesPlugin;

function resolveOptions(
  options: Record<string, unknown> | undefined,
): ResolvedOptions {
  const apiBaseUrlValue = options?.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  if (typeof apiBaseUrlValue !== "string") {
    throw new Error("Panes plugin option apiBaseUrl must be a string");
  }

  let apiBaseUrl: URL;
  try {
    apiBaseUrl = new URL(apiBaseUrlValue);
  } catch {
    throw new Error("Panes plugin option apiBaseUrl must be a valid URL");
  }

  if (
    !["http:", "https:"].includes(apiBaseUrl.protocol) ||
    apiBaseUrl.username ||
    apiBaseUrl.password ||
    apiBaseUrl.pathname !== "/" ||
    apiBaseUrl.search ||
    apiBaseUrl.hash
  ) {
    throw new Error(
      "Panes plugin option apiBaseUrl must be an HTTP(S) origin without credentials, a path, query, or fragment",
    );
  }
  if (apiBaseUrl.protocol === "http:" && !isLoopbackHost(apiBaseUrl)) {
    throw new Error(
      "Panes plugin option apiBaseUrl must use HTTPS unless its host is a verified loopback address",
    );
  }

  const autoOpenValue = options?.autoOpen ?? false;
  if (typeof autoOpenValue !== "boolean") {
    throw new Error("Panes plugin option autoOpen must be a boolean");
  }

  const createApiKeyValue =
    options?.createApiKey ?? process.env.OPENCODE_PANES_CREATE_API_KEY;
  if (
    createApiKeyValue !== undefined &&
    (typeof createApiKeyValue !== "string" || createApiKeyValue.length === 0)
  ) {
    throw new Error(
      "Panes plugin option createApiKey must be a non-empty string",
    );
  }

  const requestTimeoutMsValue =
    options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    typeof requestTimeoutMsValue !== "number" ||
    !Number.isInteger(requestTimeoutMsValue) ||
    requestTimeoutMsValue < 100 ||
    requestTimeoutMsValue > 120_000
  ) {
    throw new Error(
      "Panes plugin option requestTimeoutMs must be an integer from 100 to 120000",
    );
  }

  return {
    apiBaseUrl,
    autoOpen: autoOpenValue,
    ...(createApiKeyValue ? { createApiKey: createApiKeyValue } : {}),
    requestTimeoutMs: requestTimeoutMsValue,
  };
}

async function createArtifact(
  args: {
    title: string;
    type: ArtifactType;
    source: string;
  },
  context: ToolContext,
  options: ResolvedOptions,
) {
  const request = createArtifactRequestSchema.safeParse({
    title: args.title,
    type: args.type,
    source: args.source,
    sessionId: context.sessionID,
  });
  if (!request.success) {
    throw validationError(request.error.issues[0]?.message);
  }

  await ensureUploadPermission(context, options.apiBaseUrl, {
    operation: "create",
    title: request.data.title,
  });

  const response = await fetchPanes(
    new URL("/api/artifacts", options.apiBaseUrl),
    {
      method: "POST",
      headers: jsonHeaders(undefined, options.createApiKey),
      body: JSON.stringify(request.data),
    },
    context.abort,
    options.requestTimeoutMs,
  );
  const payload = await parseApiResponse(
    response,
    createArtifactResponseSchema,
    options.createApiKey ? [options.createApiKey] : [],
  );
  if (payload.revision.artifactId !== payload.artifact.id) {
    throw malformedSuccessResponse();
  }
  const viewerUrl = validateCreateViewerUrl(
    payload.viewerUrl,
    options.apiBaseUrl.origin,
    payload.artifact.id,
  );

  try {
    await writeArtifactState({
      apiOrigin: options.apiBaseUrl.origin,
      artifactId: payload.artifact.id,
      ownerToken: payload.ownerToken,
      viewerUrl,
      title: payload.artifact.title,
      type: payload.artifact.type,
    });
  } catch (error) {
    throw new Error(
      `Artifact ${payload.artifact.id} was created, but its owner token could not be saved. Future updates are unavailable until state storage is fixed. ${errorMessage(error)}`,
    );
  }

  const autoOpenStatus = await maybeOpenViewer(
    viewerUrl,
    context,
    options.autoOpen,
  );
  return toolResult({
    operation: "created",
    artifactId: payload.artifact.id,
    title: payload.artifact.title,
    type: payload.artifact.type,
    version: payload.revision.version,
    viewerUrl,
    autoOpenStatus,
  });
}

async function updateArtifact(
  args: {
    artifactId: string;
    title: string;
    type: ArtifactType;
    source: string;
  },
  context: ToolContext,
  options: ResolvedOptions,
) {
  const artifactId = artifactIdSchema.safeParse(args.artifactId);
  if (!artifactId.success) {
    throw validationError("Artifact ID is invalid");
  }

  const request = createRevisionRequestSchema.safeParse({
    source: args.source,
  });
  if (!request.success) {
    throw validationError(request.error.issues[0]?.message);
  }

  const state = await readArtifactState(
    options.apiBaseUrl.origin,
    artifactId.data,
  );
  if (args.title !== state.title) {
    throw new Error(
      `Artifact title is immutable. Retry the update with the stored title ${JSON.stringify(state.title)}.`,
    );
  }
  if (args.type !== state.type) {
    throw new Error(
      `Artifact type is immutable. Retry the update with the stored type ${JSON.stringify(state.type)}.`,
    );
  }
  await ensureUploadPermission(context, options.apiBaseUrl, {
    operation: "update",
    title: state.title,
  });
  const response = await fetchPanes(
    new URL(
      `/api/artifacts/${encodeURIComponent(artifactId.data)}/revisions`,
      options.apiBaseUrl,
    ),
    {
      method: "POST",
      headers: jsonHeaders(state.ownerToken),
      body: JSON.stringify(request.data),
    },
    context.abort,
    options.requestTimeoutMs,
  );

  let payload;
  try {
    payload = await parseApiResponse(response, revisionResponseSchema, [
      state.ownerToken,
    ]);
  } catch (error) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Panes authorization failed for artifact ${artifactId.data}. The locally stored owner token may be missing from the server or no longer valid. Create a new artifact or restore the matching Panes state file.`,
      );
    }
    throw error;
  }
  if (
    payload.artifactId !== artifactId.data ||
    payload.revision.artifactId !== artifactId.data
  ) {
    throw malformedSuccessResponse();
  }
  const viewerUrl = validateUpdateViewerUrl(
    payload.viewerUrl,
    options.apiBaseUrl.origin,
    payload.artifactId,
    state.viewerUrl,
  );

  const autoOpenStatus = await maybeOpenViewer(
    viewerUrl,
    context,
    options.autoOpen,
  );
  return toolResult({
    operation: "updated",
    artifactId: payload.artifactId,
    title: state.title,
    type: state.type,
    version: payload.revision.version,
    viewerUrl,
    autoOpenStatus,
  });
}

function jsonHeaders(ownerToken?: string, createApiKey?: string) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}),
    ...(createApiKey ? { "x-panes-create-key": createApiKey } : {}),
  };
}

async function fetchPanes(
  url: URL,
  init: RequestInit,
  callerSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal.aborted) abortFromCaller();

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Panes request timed out"));
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (callerSignal.aborted) {
      throw new Error("Panes upload was cancelled");
    }
    if (timedOut) {
      throw new Error(`Panes API request timed out after ${timeoutMs} ms`);
    }
    throw new Error(
      `Could not reach the Panes API at ${url.origin}. Check the configured API origin and network connection.`,
    );
  } finally {
    clearTimeout(timeout);
    callerSignal.removeEventListener("abort", abortFromCaller);
  }
}

async function parseApiResponse<T>(
  response: Response,
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  },
  secrets: string[] = [],
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "Panes API returned malformed JSON"
        : `Panes API request failed with HTTP ${response.status} and a malformed error response`,
    );
  }

  if (!response.ok) {
    const apiError = errorEnvelopeSchema.safeParse(payload);
    if (!apiError.success) {
      throw new Error(
        `Panes API request failed with HTTP ${response.status} and an unrecognized error response`,
      );
    }

    const issueText = redactSecrets(
      apiError.data.error.issues
        ?.map(
          (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
        )
        .join("; ") ?? "",
      secrets,
    );
    const suffix = issueText ? ` (${issueText})` : "";
    throw new Error(
      `Panes API request failed (${apiError.data.error.code}): ${redactSecrets(apiError.data.error.message, secrets)}${suffix}`,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw malformedSuccessResponse();
  }
  return parsed.data;
}

function validationError(message = "Artifact input is invalid") {
  if (message.includes(String(MAX_ARTIFACT_SOURCE_BYTES))) {
    return new Error(
      `Artifact source exceeds the ${MAX_ARTIFACT_SOURCE_BYTES}-byte UTF-8 limit. Reduce the source and call the artifact tool again.`,
    );
  }
  return new Error(`Artifact input is invalid: ${message}`);
}

function toolResult(input: {
  operation: "created" | "updated";
  artifactId: string;
  title: string;
  type: ArtifactType;
  version: number;
  viewerUrl: string;
  autoOpenStatus: AutoOpenStatus;
}) {
  const summary = {
    artifactId: input.artifactId,
    version: input.version,
    title: input.title,
    type: input.type,
    viewerUrl: input.viewerUrl,
    operation: input.operation,
    autoOpen: input.autoOpenStatus,
  };

  return {
    title: `${input.operation === "created" ? "Created" : "Updated"} ${input.title}`,
    output: JSON.stringify(summary),
    metadata: summary,
  };
}

async function maybeOpenViewer(
  viewerUrl: string,
  context: ToolContext,
  autoOpen: boolean,
): Promise<AutoOpenStatus> {
  if (!autoOpen) return "disabled";

  let url: URL;
  try {
    url = new URL(viewerUrl);
  } catch {
    return "failed";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "failed";

  try {
    await context.ask({
      permission: "artifact_open",
      patterns: [url.origin],
      always: [url.origin],
      metadata: { viewerUrl: url.href },
    });
  } catch {
    return "permission-denied";
  }

  try {
    await openBrowser(url.href);
    return "opened";
  } catch {
    return "failed";
  }
}

async function openBrowser(url: string) {
  const command =
    platform() === "darwin"
      ? { executable: "open", args: [url] }
      : platform() === "win32"
        ? {
            executable: "rundll32.exe",
            args: ["url.dll,FileProtocolHandler", url],
          }
        : { executable: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function isLoopbackHost(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

async function ensureUploadPermission(
  context: ToolContext,
  apiBaseUrl: URL,
  metadata: { operation: "create" | "update"; title: string },
) {
  await context.ask({
    permission: "artifact_upload",
    patterns: [apiBaseUrl.origin],
    always: [apiBaseUrl.origin],
    metadata: { endpoint: apiBaseUrl.origin, ...metadata },
  });
}

async function writeArtifactState(state: StoredArtifactState) {
  const directory = artifactStateDirectory(state.apiOrigin);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictPermissions(directory, 0o700);

  const target = artifactStatePath(state.apiOrigin, state.artifactId);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, target);
    await restrictPermissions(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readArtifactState(apiOrigin: string, artifactId: string) {
  const path = artifactStatePath(apiOrigin, artifactId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `No local owner token was found for artifact ${artifactId} at ${apiOrigin}. Only the OpenCode instance that created an artifact, or a restored Panes state file, can update it.`,
      );
    }
    throw new Error(
      `Could not read local Panes state for artifact ${artifactId}. ${errorMessage(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `Local Panes state for artifact ${artifactId} is malformed. Restore or remove that state file, then create a new artifact.`,
    );
  }

  if (!isStoredArtifactState(value, apiOrigin, artifactId)) {
    throw new Error(
      `Local Panes state for artifact ${artifactId} is invalid or belongs to another API origin.`,
    );
  }
  return value;
}

function isStoredArtifactState(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
): value is StoredArtifactState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    Object.keys(state).length === 6 &&
    state.apiOrigin === apiOrigin &&
    state.artifactId === artifactId &&
    ownerTokenSchema.safeParse(state.ownerToken).success &&
    isWorkspaceViewerUrl(state.viewerUrl, apiOrigin, artifactId) &&
    typeof state.title === "string" &&
    state.title.length > 0 &&
    artifactTypeSchema.safeParse(state.type).success
  );
}

function isWorkspaceViewerUrl(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
) {
  try {
    validateCreateViewerUrl(value, apiOrigin, artifactId);
    return true;
  } catch {
    return false;
  }
}

function validateCreateViewerUrl(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
) {
  const url = parseViewerUrl(value, apiOrigin, artifactId);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const entries = [...fragment.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== WORKSPACE_TOKEN_FRAGMENT_KEY ||
    !workspaceTokenSchema.safeParse(entries[0]?.[1]).success
  ) {
    throw malformedSuccessResponse();
  }
  return url.href;
}

function validateUpdateViewerUrl(
  value: unknown,
  apiOrigin: string,
  artifactId: string,
  storedViewerUrl: string,
) {
  const storedUrl = validateCreateViewerUrl(
    storedViewerUrl,
    apiOrigin,
    artifactId,
  );
  const url = parseViewerUrl(value, apiOrigin, artifactId);
  if (url.hash && url.href !== storedUrl) {
    throw malformedSuccessResponse();
  }
  return storedUrl;
}

function parseViewerUrl(value: unknown, apiOrigin: string, artifactId: string) {
  if (typeof value !== "string") throw malformedSuccessResponse();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformedSuccessResponse();
  }
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.pathname !== `/artifacts/${encodeURIComponent(artifactId)}` ||
    url.search
  ) {
    throw malformedSuccessResponse();
  }
  return url;
}

function malformedSuccessResponse() {
  return new Error("Panes API returned a malformed success response");
}

function artifactStateDirectory(apiOrigin: string) {
  return join(stateRootDirectory(), "origins", sha256(apiOrigin), "artifacts");
}

function artifactStatePath(apiOrigin: string, artifactId: string) {
  return join(artifactStateDirectory(apiOrigin), `${sha256(artifactId)}.json`);
}

function stateRootDirectory() {
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, STATE_DIRECTORY_NAME);
  }
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, STATE_DIRECTORY_NAME, "state");
  }
  return join(homedir(), ".local", "state", STATE_DIRECTORY_NAME);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function restrictPermissions(path: string, mode: number) {
  if (platform() === "win32") return;
  await chmod(path, mode);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function redactSecrets(value: string, secrets: string[]) {
  return secrets.reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
    value,
  );
}
