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
  const allowedOrigins = ["https:", ...normalizedOrigins];
  return {
    origins: normalizedOrigins,
    connectSrc: allowedOrigins,
    imageSrc: allowedOrigins,
    mediaSrc: allowedOrigins,
    fontSrc: allowedOrigins,
    styleSrc: allowedOrigins,
    scriptSrc: allowedOrigins,
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
    const policy = createArtifactNetworkPolicy(origins);
    return policy.connectSrc.includes(url.origin) || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function createPreviewCsp(origin, origins) {
  const policy = createArtifactNetworkPolicy(origins);
  const scriptSrc = [origin, ...policy.scriptSrc].join(" ");
  const styleSrc = [origin, ...policy.styleSrc].join(" ");
  const imageSrc = [origin, ...policy.imageSrc, "data:", "blob:"].join(" ");
  const fontSrc = [origin, ...policy.fontSrc, "data:"].join(" ");
  const mediaSrc = [origin, ...policy.mediaSrc].join(" ");
  const connectSrc = policy.connectSrc.length
    ? policy.connectSrc.join(" ")
    : "'none'";
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${scriptSrc}; style-src 'unsafe-inline' ${styleSrc}; img-src ${imageSrc}; font-src ${fontSrc}; connect-src ${connectSrc}; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri ${origin}; form-action 'none'; manifest-src 'none'; media-src ${mediaSrc}; navigate-to 'none'`;
}

export function normalizePreviewContentType(mediaType) {
  return /^(?:text\/|application\/(?:javascript|json|typescript|xml)|image\/svg\+xml)/u.test(
    mediaType,
  )
    ? `${mediaType}; charset=utf-8`
    : mediaType;
}
