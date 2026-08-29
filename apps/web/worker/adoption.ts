import {
  MAX_ARTIFACT_SOURCE_BYTES,
  LEGACY_ADOPTION_CODE_PREFIX,
  LEGACY_ADOPTION_CODE_TTL_MS,
  legacyAdoptionIssueResponseSchema,
  legacyAdoptionRedeemRequestSchema,
  legacyAdoptionRedeemResponseSchema,
} from "@opencode-panes/contracts";
import { readBoundedText } from "./bounded-json";

const ADOPTION_BODY_LIMIT = 8 * 1024;

interface LegacyAdoptionSourceRow {
  artifact_id: string;
  revision_id: string;
  revision_version: number;
  title: string;
  type: "html" | "react" | "svg" | "mermaid" | "markdown" | "code";
  source: string;
}

interface AdoptionGrantRow extends LegacyAdoptionSourceRow {
  grant_id: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  local_project_id: string | null;
  local_artifact_id: string | null;
  local_slug: string | null;
}

export async function issueLegacyAdoptionCode(
  env: Env,
  artifactId: string,
): Promise<Response> {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + LEGACY_ADOPTION_CODE_TTL_MS,
  ).toISOString();
  const code = generateAdoptionCode();
  const codeHash = await hashToken(code);
  const grantId = `adoption_grant_${crypto.randomUUID()}`;
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE legacy_adoption_grants
          SET revoked_at = ?
        WHERE legacy_artifact_id = ?
          AND consumed_at IS NULL AND revoked_at IS NULL`,
    ).bind(createdAt, artifactId),
    env.DB.prepare(
      `INSERT INTO legacy_adoption_grants
        (id, legacy_artifact_id, legacy_revision_id, legacy_revision_version,
         legacy_title, legacy_type, code_hash, created_at, expires_at)
       SELECT ?, a.id, r.id, r.version, a.title, a.type, ?, ?, ?
         FROM legacy_artifacts legacy
         JOIN artifacts a ON a.id = legacy.artifact_id
         JOIN revisions r ON r.id = a.current_revision_id
        WHERE legacy.artifact_id = ? AND legacy.private_expires_at > ?
          AND length(CAST(r.source AS BLOB)) <= ?`,
    ).bind(
      grantId,
      codeHash,
      createdAt,
      expiresAt,
      artifactId,
      createdAt,
      MAX_ARTIFACT_SOURCE_BYTES,
    ),
  ]);
  if (result[1]?.meta.changes !== 1)
    return adoptionError(404, "Artifact not found");

  const source = await readAdoptionGrant(env.DB, artifactId, codeHash);
  if (!source) return adoptionError(404, "Artifact not found");

  return adoptionJsonResponse(
    legacyAdoptionIssueResponseSchema.parse({
      operation: "adoption-code-issued",
      artifactId,
      code,
      expiresAt,
      source: {
        title: source.title,
        type: source.type,
        revisionVersion: source.revision_version,
      },
    }),
  );
}

export async function redeemLegacyAdoption(
  request: Request,
  env: Env,
  artifactId: string,
): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return adoptionError(400, "Adoption request is invalid");
  const parsed = legacyAdoptionRedeemRequestSchema.safeParse(body.value);
  if (
    !parsed.success ||
    parsed.data.apiOrigin !== new URL(request.url).origin
  ) {
    return adoptionError(403, "Adoption request is invalid");
  }

  const codeHash = await hashToken(parsed.data.code);
  const now = new Date().toISOString();
  const grant = await readAdoptionGrant(env.DB, artifactId, codeHash);
  if (
    !grant ||
    grant.revoked_at !== null ||
    grant.expires_at <= now ||
    (grant.consumed_at !== null &&
      (grant.local_project_id !== parsed.data.localProjectId ||
        grant.local_artifact_id !== parsed.data.localArtifactId ||
        grant.local_slug !== parsed.data.slug))
  ) {
    return adoptionError(403, "Adoption request is invalid");
  }

  if (grant.consumed_at === null) {
    const result = await env.DB.prepare(
      `UPDATE legacy_adoption_grants
          SET consumed_at = ?, local_project_id = ?, local_artifact_id = ?,
              local_slug = ?
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at > ?`,
    )
      .bind(
        now,
        parsed.data.localProjectId,
        parsed.data.localArtifactId,
        parsed.data.slug,
        grant.grant_id,
        now,
      )
      .run();
    if (result.meta.changes !== 1) {
      const retry = await readAdoptionGrant(env.DB, artifactId, codeHash);
      if (!retry || !sameBinding(retry, parsed.data))
        return adoptionError(409, "Adoption request is invalid");
      return adoptionResponse(request, parsed.data, retry);
    }
  }

  return adoptionResponse(request, parsed.data, grant);
}

async function readAdoptionGrant(
  db: D1Database,
  artifactId: string,
  codeHash: string,
): Promise<AdoptionGrantRow | null> {
  return db
    .prepare(
      `SELECT g.id AS grant_id, g.legacy_artifact_id AS artifact_id,
              g.legacy_revision_id AS revision_id,
              g.legacy_revision_version AS revision_version,
              g.legacy_title AS title, g.legacy_type AS type,
              g.expires_at, g.consumed_at, g.revoked_at,
              g.local_project_id, g.local_artifact_id, g.local_slug, r.source
         FROM legacy_adoption_grants g
         JOIN legacy_artifacts legacy
           ON legacy.artifact_id = g.legacy_artifact_id
         JOIN artifacts a ON a.id = g.legacy_artifact_id
         JOIN revisions r ON r.id = g.legacy_revision_id
        WHERE g.legacy_artifact_id = ? AND g.code_hash = ?
          AND g.consumed_at IS NULL AND g.revoked_at IS NULL
          AND legacy.private_expires_at > ?
          AND a.current_revision_id = g.legacy_revision_id`,
    )
    .bind(artifactId, codeHash, new Date().toISOString())
    .first<AdoptionGrantRow>();
}

function sameBinding(
  grant: AdoptionGrantRow,
  binding: { localProjectId: string; localArtifactId: string; slug: string },
): boolean {
  return (
    grant.local_project_id === binding.localProjectId &&
    grant.local_artifact_id === binding.localArtifactId &&
    grant.local_slug === binding.slug
  );
}

function adoptionResponse(
  request: Request,
  binding: { localProjectId: string; localArtifactId: string; slug: string },
  grant: AdoptionGrantRow,
): Response {
  return adoptionJsonResponse(
    legacyAdoptionRedeemResponseSchema.parse({
      operation: "legacy-adopted",
      apiOrigin: new URL(request.url).origin,
      localProjectId: binding.localProjectId,
      localArtifactId: binding.localArtifactId,
      slug: binding.slug,
      title: grant.title,
      type: grant.type,
      source: grant.source,
      provenance: {
        grantId: grant.grant_id,
        localProjectId: binding.localProjectId,
        localArtifactId: binding.localArtifactId,
        localSlug: binding.slug,
        legacyArtifactId: grant.artifact_id,
        legacyRevisionId: grant.revision_id,
        legacyRevisionVersion: grant.revision_version,
        legacyTitle: grant.title,
        legacyType: grant.type,
      },
    }),
  );
}

function generateAdoptionCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${LEGACY_ADOPTION_CODE_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function adoptionJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function adoptionError(status: number, message: string): Response {
  return adoptionJsonResponse(
    {
      error: {
        code:
          status === 400
            ? "VALIDATION_ERROR"
            : status === 404
              ? "NOT_FOUND"
              : status === 409
                ? "CONFLICT"
                : "FORBIDDEN",
        message,
      },
    },
    status,
  );
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return { ok: false };
  try {
    const text = await readBoundedText(request, ADOPTION_BODY_LIMIT);
    if (text === undefined) return { ok: false };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
