import { createRemoteJWKSet, errors, jwtVerify } from "jose";

const ACCESS_JWKS_PATH = "/cdn-cgi/access/certs";
const ACCESS_JWKS_TIMEOUT_MS = 3_000;
const ACCESS_JWKS_COOLDOWN_MS = 30_000;
const ACCESS_JWKS_MAX_AGE_MS = 10 * 60 * 1_000;
const ACCESS_ALGORITHMS = ["RS256"];

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

export interface AccessConfig {
  issuer: string;
  audience: string;
  allowedEmail: string;
}

export type AccessVerification =
  { ok: true; email: string } | { ok: false; status: 401 | 503 };

// This cache contains only public keys and is bounded by the jose cache age.
// It has no request-scoped identity or credential state.
const jwksCache = new Map<string, RemoteJwks>();

export async function verifyAccessRequest(
  request: Request,
  env: Env,
): Promise<AccessVerification> {
  const config = readAccessConfig(env);
  if (!config) return { ok: false, status: 503 };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401 };

  try {
    const jwks = getJwks(config.issuer);
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ACCESS_ALGORITHMS,
      audience: config.audience,
      issuer: config.issuer,
      requiredClaims: ["exp"],
    });
    const email = normalizeEmail(payload.email);
    if (!email || email !== config.allowedEmail) {
      return { ok: false, status: 401 };
    }
    return { ok: true, email };
  } catch (error) {
    // A network or timeout failure means the verifier could not establish a
    // decision. Token and claim failures remain generic unauthorized results.
    if (isJwksAvailabilityError(error)) return { ok: false, status: 503 };
    return { ok: false, status: 401 };
  }
}

export function readAccessConfig(env: Env): AccessConfig | undefined {
  const issuerInput = env.PANES_ACCESS_ISSUER?.trim();
  const audience = env.PANES_ACCESS_AUDIENCE?.trim();
  const allowedEmail = normalizeEmail(env.PANES_ACCESS_ALLOWED_EMAIL);
  if (!issuerInput || !audience || !allowedEmail) return undefined;

  let issuer: URL;
  try {
    issuer = new URL(issuerInput);
  } catch {
    return undefined;
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.port ||
    issuer.search ||
    issuer.hash ||
    (issuer.pathname !== "" && issuer.pathname !== "/") ||
    !issuer.hostname.toLowerCase().endsWith(".cloudflareaccess.com")
  ) {
    return undefined;
  }

  return {
    issuer: issuer.origin,
    audience,
    allowedEmail,
  };
}

export function clearAccessJwksCache(): void {
  jwksCache.clear();
}

function getJwks(issuer: string): RemoteJwks {
  const endpoint = new URL(ACCESS_JWKS_PATH, issuer);
  const key = endpoint.href;
  const cached = jwksCache.get(key);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(endpoint, {
    cacheMaxAge: ACCESS_JWKS_MAX_AGE_MS,
    cooldownDuration: ACCESS_JWKS_COOLDOWN_MS,
    timeoutDuration: ACCESS_JWKS_TIMEOUT_MS,
  });
  jwksCache.set(key, jwks);
  return jwks;
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLocaleLowerCase("en-US");
  if (!email || !email.includes("@") || /[\u0000-\u001f\u007f]/u.test(email))
    return undefined;
  return email;
}

function isJwksAvailabilityError(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}
