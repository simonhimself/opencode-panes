import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

// Type-only: Plugin.define() is an identity function, and importing the SDK at
// runtime would add its dependencies to the standalone bundle.
import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_UPLOAD_BYTES,
  filePathSchema,
  isExcludedPath,
  uploadRequestSchema,
  uploadResultSchema,
  uploadSessionSchema,
  type UploadFile,
} from "@opencode-panes/contracts";

export interface PanesPluginOptions {
  /** Required API origin. HTTPS, or a literal loopback IP for local development. */
  apiBaseUrl?: string;
  /** Deployment upload credential; never persisted or returned. */
  uploadKey?: string;
  /** Timeout for each HTTP request, including its response body. */
  requestTimeoutMs?: number;
}

const execFileAsync = promisify(execFile);
const artifactIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/u);
const uploadArgs = z
  .object({
    sourcePath: z
      .string()
      .min(1)
      .describe(
        "Existing HTML/SVG file or built browser folder inside the project. Source is read only.",
      ),
    entryPath: z
      .string()
      .refine(
        (value) => filePathSchema.safeParse(value).success,
        "Use a safe relative entry path",
      )
      .optional()
      .describe(
        "Entry relative to the selected folder; defaults to index.html. For one file, use its filename.",
      ),
    title: z.string().trim().min(1).max(200).optional(),
    projectName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const dashboardArgs = z
  .object({ artifactId: artifactIdSchema.optional() })
  .strict();

class SafeError extends Error {}

const plugin: Plugin.Plugin = {
  id: "opencode-panes",
  async setup(ctx) {
    const options: PanesPluginOptions = ctx.options;
    const { directory, project } = ctx.location;

    // Resolve at execution time so an unconfigured plugin cannot prevent OpenCode startup.
    function configuration() {
      const value = options.apiBaseUrl ?? process.env.OPENCODE_PANES_API_URL;
      const key = options.uploadKey ?? process.env.OPENCODE_PANES_UPLOAD_KEY;
      const timeout = options.requestTimeoutMs ?? 30_000;
      if (typeof value !== "string" || !value)
        throw new SafeError(
          "Set apiBaseUrl or OPENCODE_PANES_API_URL to your Panes API origin.",
        );
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new SafeError("Invalid Panes API origin.");
      }
      const hostname = url.hostname.replace(/^\[|\]$/gu, "");
      const loopback =
        hostname === "::1" ||
        (isIP(hostname) === 4 && hostname.startsWith("127."));
      if (
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && loopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      ) {
        throw new SafeError(
          "Use an HTTPS API origin without credentials, path, query, or fragment; HTTP is allowed only for literal loopback IPs.",
        );
      }
      if (
        typeof timeout !== "number" ||
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        timeout > 2_147_483_647
      )
        throw new SafeError(
          "requestTimeoutMs must be a positive timer-safe integer.",
        );
      if (typeof key === "string" && key && url.origin.includes(key))
        throw new SafeError(
          "The API origin must not contain an upload credential.",
        );
      return { origin: url.origin, key, timeout };
    }

    async function execute(
      signal: AbortSignal,
      action: () => Promise<unknown>,
    ): Promise<{ content: string }> {
      try {
        signal.throwIfAborted();
        return { content: JSON.stringify(await action()) };
      } catch (error) {
        // Never forward OS, git, fetch, permission, schema, or server error text.
        const message = signal.aborted
          ? "Operation cancelled."
          : error instanceof SafeError
            ? error.message
            : "Panes operation failed. Check the source and API configuration, then retry.";
        const key = options.uploadKey ?? process.env.OPENCODE_PANES_UPLOAD_KEY;
        return {
          content: JSON.stringify({
            error:
              typeof key === "string" && key
                ? message.split(key).join("[redacted]")
                : message,
          }),
        };
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "artifact_upload",
        description:
          "Upload a read-only snapshot of an ordinary HTML/SVG file or locally built browser folder to your private Panes library. Asks upload permission; never builds, executes, edits, deletes, previews locally, or shares source. Identical retries resume safely.",
        input: jsonSchema(uploadArgs),
        // OpenCode evaluates this permission before execute() runs.
        options: { permission: "artifact_upload" },
        async execute(args, { signal }) {
          return execute(signal, async () => {
            const config = configuration();
            if (
              typeof config.key !== "string" ||
              !config.key.trim() ||
              /[\r\n]/u.test(config.key)
            )
              throw new SafeError(
                "Set uploadKey or OPENCODE_PANES_UPLOAD_KEY before uploading.",
              );
            const parsed = uploadArgs.safeParse(args);
            if (!parsed.success)
              throw new SafeError(
                "Invalid upload arguments. Select an existing browser-ready source and a safe relative entry path.",
              );
            const root = await realpath(
              project.directory !== sep ? project.directory : directory,
            );
            const source = resolve(
              await realpath(directory),
              parsed.data.sourcePath,
            );
            const sourceKey =
              relative(root, source).split(sep).join("/") || ".";
            if (
              sourceKey === ".." ||
              sourceKey.startsWith("../") ||
              isAbsolute(sourceKey)
            )
              throw new SafeError("Choose a source inside the project root.");
            if (isExcludedPath(sourceKey))
              throw new SafeError(
                "The selected source is excluded from upload.",
              );
            // Check each component, not just the final file, before traversing the source.
            let component = root;
            for (const part of sourceKey === "." ? [] : sourceKey.split("/")) {
              component = join(component, part);
              if ((await lstat(component)).isSymbolicLink())
                throw new SafeError(
                  "Symbolic links are not allowed in upload sources.",
                );
            }
            const sourceStat = await lstat(source);
            if (!sourceStat.isDirectory() && !sourceStat.isFile())
              throw new SafeError("Choose an ordinary file or directory.");
            const entryPath =
              parsed.data.entryPath ??
              (sourceStat.isDirectory() ? "index.html" : basename(source));
            if (!/\.(?:html?|svg)$/iu.test(entryPath))
              throw new SafeError(
                "Choose an HTML or SVG entry; build framework source locally first.",
              );
            const artifactProject = {
              id: await projectIdentity(root, signal),
              name: parsed.data.projectName ?? basename(root),
            };
            signal.throwIfAborted();
            const snapshot = await readSnapshot(
              source,
              sourceStat.isDirectory(),
              signal,
            );
            const requestBody = {
              project: artifactProject,
              artifactKey: sourceKey,
              title: parsed.data.title ?? basename(source),
              entryPath,
              files: snapshot.map(({ file }) => file),
            };
            const request = uploadRequestSchema.safeParse({
              ...requestBody,
              idempotencyKey: "0".repeat(64),
            });
            if (!request.success)
              throw new SafeError(
                "Invalid upload snapshot. Check entry, paths, names, file count, and upload size limits.",
              );
            // Hash the validated wire payload, including contract normalization of names.
            const { idempotencyKey: _key, ...payload } = request.data;
            request.data.idempotencyKey = sha256(JSON.stringify(payload));
            const uploadKey = config.key;
            async function requestApi(
              path: string,
              method: string,
              body?: string | Buffer,
            ) {
              const timeout = AbortSignal.timeout(config.timeout);
              const requestSignal = AbortSignal.any([signal, timeout]);
              try {
                const response = await fetch(`${config.origin}${path}`, {
                  method,
                  redirect: "error",
                  signal: requestSignal,
                  headers: {
                    Authorization: `Bearer ${uploadKey}`,
                    "Content-Type":
                      typeof body === "string"
                        ? "application/json"
                        : "application/octet-stream",
                  },
                  ...(body === undefined ? {} : { body: body as BodyInit }),
                });
                if (!response.ok) {
                  await response.body?.cancel();
                  throw new SafeError(
                    `Panes API request failed (HTTP ${response.status}). Retry the same upload when the API is ready.`,
                  );
                }
                if (method === "PUT") {
                  await response.body?.cancel();
                  return undefined;
                }
                // Response bodies are untrusted too; do not buffer an unlimited server response.
                const reader = response.body?.getReader();
                if (!reader) throw new SafeError("Invalid Panes API response.");
                let text = "";
                let size = 0;
                const decoder = new TextDecoder();
                try {
                  while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 64 * 1024)
                      throw new SafeError(
                        "Panes API response exceeds the response limit.",
                      );
                    text += decoder.decode(value, { stream: true });
                  }
                  return JSON.parse(text + decoder.decode()) as unknown;
                } finally {
                  await reader.cancel().catch(() => undefined);
                }
              } catch (error) {
                if (timeout.aborted && !signal.aborted)
                  throw new SafeError(
                    "Panes API request timed out. Retry the same upload safely.",
                  );
                throw error;
              }
            }
            const session = uploadSessionSchema.safeParse(
              await requestApi(
                "/api/uploads",
                "POST",
                JSON.stringify(request.data),
              ),
            );
            if (
              !session.success ||
              !artifactIdSchema.safeParse(session.data.artifactId).success ||
              !artifactIdSchema.safeParse(session.data.uploadId).success
            )
              throw new SafeError("Invalid Panes upload session response.");
            const { uploadId, artifactId } = session.data;
            if (!session.data.complete) {
              for (const { file, bytes } of snapshot) {
                const path = file.path
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/");
                await requestApi(
                  `/api/uploads/${uploadId}/files/${path}`,
                  "PUT",
                  bytes,
                );
              }
            }
            const result = uploadResultSchema.safeParse(
              await requestApi(`/api/uploads/${uploadId}/commit`, "POST"),
            );
            if (!result.success || result.data.artifactId !== artifactId)
              throw new SafeError("Invalid Panes upload commit response.");
            // Construct owner URLs ourselves: the API cannot reflect credentials into tool output.
            if (
              artifactId.includes(uploadKey) ||
              config.origin.includes(uploadKey)
            )
              throw new SafeError("Unsafe Panes dashboard response.");
            return {
              artifactId,
              version: result.data.version,
              dashboardUrl: `${config.origin}/inventory/artifacts/${artifactId}`,
            };
          });
        },
      });
      editor.add({
        name: "artifact_dashboard",
        description:
          "Return the authenticated owner dashboard URL, optionally for a cloud artifact ID. Does not upload, open a browser, or create a share link.",
        input: jsonSchema(dashboardArgs),
        async execute(args, { signal }) {
          return execute(signal, async () => {
            const { origin, key } = configuration();
            const parsed = dashboardArgs.safeParse(args);
            if (!parsed.success)
              throw new SafeError("Invalid cloud artifact ID.");
            const { artifactId } = parsed.data;
            const dashboardUrl = `${origin}/inventory${artifactId ? `/artifacts/${artifactId}` : ""}`;
            if (typeof key === "string" && key && dashboardUrl.includes(key))
              throw new SafeError("Unsafe Panes dashboard URL.");
            return { dashboardUrl };
          });
        },
      });
    });
  },
};

export default plugin;

function jsonSchema(schema: z.ZodType) {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input" });
  return json;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function projectIdentity(root: string, signal: AbortSignal) {
  try {
    // Reading git configuration does not run source, build scripts, hooks, or remote commands.
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      { cwd: root, signal, timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    const remotes = stdout
      .trim()
      .split("\n")
      .sort(
        (a, b) =>
          Number(b.startsWith("remote.origin.url ")) -
            Number(a.startsWith("remote.origin.url ")) ||
          (a < b ? -1 : a > b ? 1 : 0),
      );
    for (const remote of remotes) {
      let address = remote.replace(/^\S+\s+/u, "").trim();
      if (!address.includes("://"))
        address = address.replace(
          /^(?:[^/@:]+@)?([^/:]+):(.+)$/u,
          "ssh://$1/$2",
        );
      try {
        const url = new URL(address);
        if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
          continue;
        const identity = `${url.hostname.toLowerCase()}${url.port && !["22", "80", "443", "9418"].includes(url.port) ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "")}`;
        return `git:${sha256(identity)}`;
      } catch {
        /* A non-network remote falls back to the real project root. */
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    const failure = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    // git config exits 1 with empty output only when the requested keys are absent.
    // Discovery failures must not assign a different project to a partial-upload retry.
    if (
      failure.code !== 1 ||
      failure.killed ||
      failure.signal ||
      failure.stdout !== "" ||
      failure.stderr !== ""
    ) {
      throw new SafeError(
        failure.code === "ENOENT"
          ? "Git is unavailable. Install Git and retry project identity discovery."
          : "Could not read Git remotes. Retry project identity discovery after resolving the Git failure.",
      );
    }
  }
  return `local:${sha256(root)}`;
}

async function readSnapshot(
  source: string,
  directory: boolean,
  signal: AbortSignal,
) {
  const snapshot: { file: UploadFile; bytes: Buffer }[] = [];
  const selection: { path: string; info: Stats; entries?: string[] }[] = [];
  let total = 0;
  async function visit(path: string, name: string) {
    signal.throwIfAborted();
    if (isExcludedPath(name)) return;
    if (name && !filePathSchema.safeParse(name).success)
      throw new SafeError("An upload path is unsafe.");
    const info = await lstat(path);
    if (info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new SafeError("Symbolic links are not allowed in upload sources.");
    if (info.isDirectory()) {
      const entries = (await readdir(path)).sort();
      selection.push({ path, info, entries });
      for (const child of entries)
        await visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    if (!info.isFile())
      throw new SafeError(
        "Upload sources must contain only ordinary files and directories.",
      );
    if (snapshot.length >= MAX_FILES)
      throw new SafeError("Upload exceeds 500 files.");
    if (info.size > MAX_FILE_BYTES)
      throw new SafeError("An upload file exceeds 25 MiB.");
    if (total + info.size > MAX_UPLOAD_BYTES)
      throw new SafeError("Upload exceeds 100 MiB.");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameSourceState(before, info))
        throw new SafeError(
          "Source changed while reading. Retry after edits finish.",
        );
      // One extra byte detects growth without unbounded readFile allocations.
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          Math.min(64 * 1024, buffer.length - offset),
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (
        offset !== info.size ||
        !sameSourceState(before, after) ||
        (await realpath(path)) !== path
      )
        throw new SafeError(
          "Source changed while reading. Retry after edits finish.",
        );
      const bytes = buffer.subarray(0, offset);
      total += bytes.length;
      selection.push({ path, info: before });
      snapshot.push({
        file: {
          path: name,
          mediaType: mediaType(name),
          size: bytes.length,
          sha256: sha256(bytes),
        },
        bytes,
      });
    } finally {
      await handle.close();
    }
  }
  try {
    await visit(source, directory ? "" : basename(source));
    // A later read can overlap a rebuild of an already-buffered file or directory.
    // Revalidate the entire selection before any upload request, not just each read.
    for (const { path, info, entries } of selection) {
      signal.throwIfAborted();
      if (
        !sameSourceState(info, await lstat(path)) ||
        (await realpath(path)) !== path
      )
        throw new SafeError(
          "Source changed while reading. Retry after edits finish.",
        );
      if (entries) {
        const current = (await readdir(path)).sort();
        if (
          entries.length !== current.length ||
          entries.some((entry, index) => entry !== current[index])
        )
          throw new SafeError(
            "Source changed while reading. Retry after edits finish.",
          );
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SafeError) throw error;
    throw new SafeError(
      "Source changed or could not be revalidated. Retry after edits finish.",
    );
  }
  snapshot.sort((a, b) =>
    a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0,
  );
  return snapshot;
}

function sameSourceState(before: Stats, after: Stats) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function mediaType(path: string) {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".svg": "image/svg+xml",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
