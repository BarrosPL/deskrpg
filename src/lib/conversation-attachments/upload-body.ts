import { AttachmentServiceError } from "./access";
/** Bound chunked multipart requests before the platform parser buffers the body. */
export async function readBoundedFormData(
  request: Request,
  maxBytes = 5 * 1024 * 1024 + 64 * 1024,
) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new AttachmentServiceError(413, "attachment_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new AttachmentServiceError(400, "attachment_invalid_file");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AttachmentServiceError(413, "attachment_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(buffer, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new AttachmentServiceError(400, "attachment_invalid_file");
  }
}
