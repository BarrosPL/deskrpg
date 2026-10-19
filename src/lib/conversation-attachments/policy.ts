import {
  ORIGINAL_FILE_MAX_BYTES,
  ORIGINAL_FILE_MAX_COUNT,
  type AttachmentErrorCode,
  type FileMeta,
} from "./types";

const ALLOWED_EXTENSIONS = new Set([
  "txt",
  "md",
  "json",
  "csv",
  "pdf",
  "xlsx",
  "xls",
  "docx",
  "doc",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

export function validateAttachmentSelection(ids: readonly string[]): AttachmentErrorCode | null {
  if (ids.length > ORIGINAL_FILE_MAX_COUNT) return "attachment_count_exceeded";
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
    return "attachment_invalid_selection";
  return null;
}

export function validateOriginalFile(file: {
  name: string;
  bytes: number;
}): AttachmentErrorCode | null {
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) return "attachment_invalid_file";
  if (file.bytes > ORIGINAL_FILE_MAX_BYTES) return "attachment_too_large";
  if (!file.name.trim() || file.name.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(file.name))
    return "attachment_invalid_file";
  const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  if (!file.name.includes(".") || !ALLOWED_EXTENSIONS.has(extension))
    return "attachment_invalid_file";
  return null;
}

export function requestMatchesOriginal(a: Omit<FileMeta, "id">, b: Omit<FileMeta, "id">): boolean {
  return (
    a.name === b.name && a.mimeType === b.mimeType && a.bytes === b.bytes && a.sha256 === b.sha256
  );
}
