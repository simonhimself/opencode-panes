import { describe, expect, it } from "vitest";
import {
  filePathSchema,
  isExcludedPath,
  MAX_FILE_BYTES,
  shareRequestSchema,
  uploadRequestSchema,
  type UploadRequest,
} from "../src/index.js";

const request: UploadRequest = {
  idempotencyKey: "a".repeat(64),
  project: { id: "project-one", name: "Website" },
  artifactKey: "mockups/home",
  title: "Home page",
  entryPath: "index.html",
  files: [
    {
      path: "index.html",
      mediaType: "text/html",
      size: 12,
      sha256: "b".repeat(64),
    },
  ],
};

describe("browser-ready uploads", () => {
  it("enforces file counts and accepts exact byte limits", () => {
    const files = Array.from({ length: 500 }, (_, index) => ({
      path: index ? `${index}.bin` : "index.html",
      mediaType: "application/octet-stream",
      size: 0,
      sha256: "d".repeat(64),
    }));
    expect(uploadRequestSchema.safeParse({ ...request, files }).success).toBe(
      true,
    );
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: [...files, { ...files[0], path: "extra.bin" }],
      }).success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: files
          .slice(0, 4)
          .map((file) => ({ ...file, size: MAX_FILE_BYTES })),
      }).success,
    ).toBe(true);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        idempotencyKey: "not-a-hash",
      }).success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: [{ ...request.files[0], sha256: "z".repeat(64) }],
      }).success,
    ).toBe(false);
  });

  it.each([
    "keys/id_rsa",
    "id_ed25519",
    ".ssh/config",
    ".npmrc",
    "nested/.netrc",
  ])("excludes conventional credential file %s", (path) => {
    expect(isExcludedPath(path)).toBe(true);
  });
  it("accepts a single independent snapshot without local history", () => {
    expect(uploadRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    "/root.html",
    "../secret",
    "assets/../secret",
    "a//b",
    "./index.html",
    "a\\b",
    "a%2fb",
    "a?b",
    "a#b",
    "C:file",
    "a\u0000b",
  ])("rejects ambiguous path %s", (path) => {
    expect(filePathSchema.safeParse(path).success).toBe(false);
  });

  it("preserves ordinary nested paths and Unicode names", () => {
    expect(filePathSchema.parse("assets/café icon.svg")).toBe(
      "assets/café icon.svg",
    );
  });

  it.each([
    ".env",
    ".env.local",
    "nested/.env.production",
    "node_modules/a.js",
    ".git/config",
    "cert.pem",
    "nested/secret.KEY",
    ".cache/output",
  ])("excludes sensitive or generated path %s", (path) => {
    expect(isExcludedPath(path)).toBe(true);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: [...request.files, { ...request.files[0], path }],
      }).success,
    ).toBe(false);
  });

  it("allows browser build output and checksummed binary files", () => {
    const files = [
      ...request.files,
      {
        path: "dist/assets/image.webp",
        mediaType: "image/webp",
        size: 50,
        sha256: "c".repeat(64),
      },
    ];
    expect(uploadRequestSchema.safeParse({ ...request, files }).success).toBe(
      true,
    );
  });

  it("requires the browser entry, unique files and bounded sizes", () => {
    expect(
      uploadRequestSchema.safeParse({ ...request, entryPath: "App.tsx" })
        .success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({ ...request, entryPath: "missing.svg" })
        .success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: [...request.files, ...request.files],
      }).success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: [{ ...request.files[0], size: MAX_FILE_BYTES + 1 }],
      }).success,
    ).toBe(false);
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: index ? `${index}.bin` : "index.html",
      mediaType: "application/octet-stream",
      size: MAX_FILE_BYTES,
      sha256: "d".repeat(64),
    }));
    expect(uploadRequestSchema.safeParse({ ...request, files }).success).toBe(
      false,
    );
    expect(
      uploadRequestSchema.safeParse({ ...request, files: [] }).success,
    ).toBe(false);
  });

  it("rejects unexpected lifecycle and executable content fields", () => {
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        approvedOrigins: ["http://example.com"],
      }).success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({
        ...request,
        files: [{ ...request.files[0], mediaType: "text/html\r\nx: y" }],
      }).success,
    ).toBe(false);
  });
});

describe("human sharing choices", () => {
  it.each([null, 1, 7, 30])("supports expiry %s", (expiresInDays) => {
    expect(
      shareRequestSchema.parse({ versionId: "version-one", expiresInDays }),
    ).toEqual({ versionId: "version-one", expiresInDays });
  });
  it("requires an explicit version and expiry choice", () => {
    expect(
      shareRequestSchema.safeParse({ versionId: "version-one" }).success,
    ).toBe(false);
    expect(
      shareRequestSchema.safeParse({
        versionId: "version-one",
        expiresInDays: -1,
      }).success,
    ).toBe(false);
  });
});
