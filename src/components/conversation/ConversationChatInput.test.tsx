import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n";
import ConversationChatInput from "./ConversationChatInput";

test("sends selected room history as opaque IDs even without text", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).includes("/requests/")
          ? { requestId: "req", state: "done" }
          : {
              files: [
                {
                  id: "file-id",
                  name: "brief.pdf",
                  bytes: 4,
                  sha256: "hash",
                  mimeType: "application/pdf",
                  state: "stored",
                },
              ],
            },
      ),
    );
  const el = document.createElement("div");
  const root = createRoot(el);
  let sent: unknown[] = [];
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          <ConversationChatInput
            channelId="c"
            conversation={{ kind: "room", id: "r" }}
            onSend={(...args) => {
              sent = args;
            }}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => (el.querySelector("input[type=checkbox]") as HTMLInputElement).click());
    const send = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Send")!;
    assert.equal(send.disabled, false);
    await act(async () => send.click());
    assert.equal(sent[0], "");
    assert.equal(sent[1], undefined);
    assert.deepEqual((sent[3] as { attachmentIds: string[] }).attachmentIds, ["file-id"]);
    assert.deepEqual((sent[3] as { attachmentConversation: unknown }).attachmentConversation, {
      kind: "room",
      id: "r",
    });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
  }
});
