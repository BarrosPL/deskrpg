import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedFormData } from "./upload-body";
test("chunked upload is rejected before accumulating more than the byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(12));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("http://local", { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(readBoundedFormData(req, 10), { status: 413 });
  assert.equal(cancelled, true);
});
test("valid multipart contents survive the bounded reader", async () => {
  const form = new FormData();
  form.append("file", new Blob(["pdf"]), "a.pdf");
  const result = await readBoundedFormData(
    new Request("http://local", { method: "POST", body: form }),
    1024,
  );
  assert.equal(await (result.get("file") as File).text(), "pdf");
});
