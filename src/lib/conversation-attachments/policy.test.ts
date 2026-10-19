import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAttachmentSelection,
  validateOriginalFile,
  requestMatchesOriginal,
} from "./policy";

test("accepts exactly three attachments and rejects a fourth", () => {
  assert.equal(validateAttachmentSelection(["a", "b", "c"]), null);
  assert.equal(validateAttachmentSelection(["a", "b", "c", "d"]), "attachment_count_exceeded");
});

test("accepts the exact file byte limit and rejects overflow", () => {
  assert.equal(validateOriginalFile({ name: "reference.pdf", bytes: 5 * 1024 * 1024 }), null);
  assert.equal(
    validateOriginalFile({ name: "reference.pdf", bytes: 5 * 1024 * 1024 + 1 }),
    "attachment_too_large",
  );
});

test("rejects empty files, unsafe names, and unsupported extensions", () => {
  for (const name of [
    "../reference.pdf",
    "/reference.pdf",
    "a\\reference.pdf",
    "a\u0000.pdf",
    "file.exe",
  ])
    assert.equal(validateOriginalFile({ name, bytes: 1 }), "attachment_invalid_file");
  assert.equal(
    validateOriginalFile({ name: "reference.pdf", bytes: 0 }),
    "attachment_invalid_file",
  );
});

test("retries must match original content and metadata", () => {
  const original = {
    name: "reference.pdf",
    mimeType: "application/pdf",
    bytes: 10,
    sha256: "a".repeat(64),
  };
  assert.equal(requestMatchesOriginal(original, { ...original }), true);
  assert.equal(requestMatchesOriginal(original, { ...original, sha256: "b".repeat(64) }), false);
  assert.equal(requestMatchesOriginal(original, { ...original, name: "other.pdf" }), false);
});

test("rejects duplicate selection IDs and invalid byte lengths", () => {
  assert.equal(validateAttachmentSelection(["a", "a"]), "attachment_invalid_selection");
  for (const bytes of [NaN, Infinity, -1, 1.5])
    assert.equal(validateOriginalFile({ name: "file.pdf", bytes }), "attachment_invalid_file");
});
