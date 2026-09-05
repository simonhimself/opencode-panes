export class HttpError extends Error {
  constructor(public status: number) {
    super(`Request failed (${status})`);
  }
}

// Authentication stays in same-origin cookies, never in artifact frames or URLs.
export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: path.startsWith("/api/shares/") ? "omit" : "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new HttpError(response.status);
  if (response.status === 204) return undefined as T;
  // An expired sign-in session can redirect fetch to an HTML login page.
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new HttpError(response.redirected ? 401 : 502);
  }
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown, publicView = false): string {
  if (error instanceof HttpError) {
    if (publicView && [403, 404, 410].includes(error.status))
      return "This link is unavailable. It may have expired or been unpublished. Ask the person who shared it for a new link.";
    if (error.status === 401 || error.status === 403)
      return "Your session could not be verified. Reload this page to sign in again.";
    if (error.status === 404)
      return "This artifact is no longer in your library.";
  }
  return publicView
    ? "This preview could not be loaded. Check your connection and try again."
    : "We could not complete that request. Check your connection and try again.";
}
