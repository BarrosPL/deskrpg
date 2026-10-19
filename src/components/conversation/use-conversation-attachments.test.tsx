import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useConversationAttachments } from "./use-conversation-attachments";

test("uploads originals, retains opaque IDs and restores stored history", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify(
        init?.method === "POST"
          ? {
              file: {
                id: "server-id",
                name: "report.pdf",
                bytes: 4,
                mimeType: "application/pdf",
                sha256: "hash",
                state: "stored",
              },
            }
          : {
              files: [
                {
                  id: "history",
                  name: "old.pdf",
                  bytes: 4,
                  mimeType: "application/pdf",
                  sha256: "hash",
                  state: "stored",
                },
              ],
            },
      ),
    );
  };
  let api!: ReturnType<typeof useConversationAttachments>;
  function Harness() {
    const value = useConversationAttachments({
      channelId: "channel",
      conversation: { kind: "room", id: "room" },
    });
    useEffect(() => {
      api = value;
    }, [value]);
    return null;
  }
  const el = document.createElement("div");
  const root = createRoot(el);
  try {
    await act(async () => root.render(<Harness />));
    assert.equal(api.files[0].id, "history");
    await act(async () =>
      api.upload([new File(["data"], "report.pdf", { type: "application/pdf" })]),
    );
    assert.deepEqual(api.selectedIds, ["server-id"]);
    assert.equal(api.busy, false);
    const post = calls.find((c) => c.init?.method === "POST")!;
    assert.match(post.url, /kind=room&id=room/);
    assert.ok(post.init?.body instanceof FormData);
    await act(async () =>
      api.upload([new File(["x"], "a.pdf"), new File(["x"], "b.pdf"), new File(["x"], "c.pdf")]),
    );
    assert.equal(api.error, "attachment_count_exceeded");
    assert.equal(calls.filter((c) => c.init?.method === "POST").length, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
  }
});

test("capability failure leaves original upload unavailable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "attachment_feature_unavailable" }), { status: 428 });
  let api!: ReturnType<typeof useConversationAttachments>;
  function Harness() {
    const value = useConversationAttachments({
      channelId: "c",
      conversation: { kind: "dm", id: "npc" },
    });
    useEffect(() => {
      api = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness />));
    assert.equal(api.available, false);
    assert.equal(api.error, "attachment_feature_unavailable");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
  }
});

test("cancels pending uploads and does not leak selections into another conversation", async () => {
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST")
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    return new Response(JSON.stringify({ files: [] }));
  };
  let api!: ReturnType<typeof useConversationAttachments>;
  function Harness({ id }: { id: string }) {
    const value = useConversationAttachments({
      channelId: "c",
      conversation: { kind: "room", id },
    });
    useEffect(() => {
      api = value;
    }, [value]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  let uploading: Promise<void> | undefined;
  try {
    await act(async () => root.render(<Harness id="one" />));
    await act(async () => {
      uploading = api.upload([new File(["data"], "a.pdf")]);
    });
    assert.equal(api.busy, true);
    await act(async () => root.render(<Harness id="two" />));
    await uploading;
    assert.equal(aborted, true);
    assert.deepEqual(api.selectedIds, []);
    assert.deepEqual(api.files, []);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
  }
});
