import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/context";
import AttachmentTray from "./AttachmentTray";

test("shows shared scope, original status and selectable history without exposing paths", async () => {
  const el = document.createElement("div");
  const root = createRoot(el);
  let selected = "";
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="en">
        <AttachmentTray
          files={[
            {
              id: "opaque",
              name: "reference.pdf",
              mimeType: "application/pdf",
              bytes: 100,
              sha256: "abc",
              state: "stored",
            },
          ]}
          selectedIds={[]}
          sharedScope="room"
          onSelect={(id) => {
            selected = id;
          }}
        />
      </I18nProvider>,
    ),
  );
  assert.match(el.textContent ?? "", /reference.pdf/);
  assert.match(el.textContent ?? "", /Everyone/);
  await act(async () => (el.querySelector("input") as HTMLInputElement).click());
  assert.equal(selected, "opaque");
  await act(async () => root.unmount());
});
