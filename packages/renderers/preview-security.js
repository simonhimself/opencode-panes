const HTTP_SCHEMES = new Set(["http:", "https:"]);

export function normalizePreviewOrigins(origins) {
  if (!Array.isArray(origins)) throw new TypeError("Origins must be an array");
  const normalized = origins.map((value) => {
    if (typeof value !== "string")
      throw new TypeError("Origin must be a string");
    const url = new URL(value);
    if (
      !HTTP_SCHEMES.has(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      /[^\x00-\x7f]/u.test(
        value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu)?.[1] ?? "",
      ) ||
      url.hostname.endsWith(".") ||
      url.hostname
        .split(".")
        .some((label) => label.toLowerCase().startsWith("xn--"))
    ) {
      throw new TypeError("Origin must be an unambiguous HTTP(S) origin");
    }
    return url.origin;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Origins must be unique after normalization");
  }
  return normalized.sort();
}

export function createArtifactNetworkPolicy(origins) {
  const normalizedOrigins = normalizePreviewOrigins(origins);
  return {
    origins: normalizedOrigins,
    connectSrc: normalizedOrigins,
    imageSrc: normalizedOrigins,
    mediaSrc: normalizedOrigins,
    fontSrc: normalizedOrigins,
    styleSrc: normalizedOrigins,
    scriptSrc: normalizedOrigins,
  };
}

export function isAllowedArtifactNetworkRequest(value, origins) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!HTTP_SCHEMES.has(url.protocol)) return false;
  try {
    return createArtifactNetworkPolicy(origins).origins.includes(url.origin);
  } catch {
    return false;
  }
}
