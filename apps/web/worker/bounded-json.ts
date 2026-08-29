const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string | undefined> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await request.body?.cancel();
      return undefined;
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body exceeds byte limit");
        return undefined;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}
