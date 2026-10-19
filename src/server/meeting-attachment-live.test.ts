import assert from "node:assert/strict";
import test from "node:test";
import { LiveMeetingAttachments } from "./meeting-attachment-live";
import type { AttachmentAccess } from "../lib/conversation-attachments/access";
import type { NpcAdapter } from "../lib/adapters/types";

test("prepares every participant at staging and re-prepares the original for the actual turn", async () => {
  const prepared: string[][] = [];
  const prompts: string[] = [];
  const runtime = new LiveMeetingAttachments(
    {
      channelId: "channel",
      userId: "owner",
      isParticipant: () => true,
      canControl: () => true,
      changed: () => {},
    },
    "context",
    {
      submit: async (input) => {
        const targets = await input.targets();
        prepared.push(targets.map((t) => t.npcId));
        input.changed?.({ requestId: input.requestId, state: "preparing" });
        await input.validate?.();
        await input.run(
          Object.fromEntries(
            targets.map((t) => [
              t.npcId,
              [
                {
                  id: "original",
                  name: "brief.pdf",
                  mimeType: "application/pdf",
                  bytes: 5,
                  sha256: "hash",
                  agentPath: "/safe/cache/brief",
                  leaseId: "lease",
                  expiresAt: "later",
                },
              ],
            ]),
          ),
          new AbortController().signal,
        );
        input.changed?.({ requestId: input.requestId, state: "done" });
      },
      control: async (_access, id) => ({ requestId: id, state: "cancelled" }),
      getRequest: async () => null,
      updateLink: async () => {},
      updateContext: async () => {},
    },
  );
  const adapter: NpcAdapter = {
    type: "fake",
    execute: async (options) => {
      prompts.push(options.prompt);
      return { response: "read", session: { sessionRef: "session" } };
    },
    testConnection: async () => ({ status: "ok" }),
  };
  const wrapped = runtime.wrap("a", adapter, "session-a");
  runtime.wrap("b", adapter, "session-b");
  await runtime.stage("owner", "req", ["file"], "message");
  assert.deepEqual(prepared[0], ["a", "b"]);
  await wrapped.execute({ sessionKey: "session-a", prompt: "Read this" });
  assert.deepEqual(prepared[1], ["a"]);
  assert.match(prompts[0], /brief.pdf/);
  assert.match(prompts[0], /untrusted/);
});
test("a participant cannot control another participant's failed material", async () => {
  let controls = 0;
  const runtime = new LiveMeetingAttachments(
    {
      channelId: "c",
      userId: "owner",
      isParticipant: () => true,
      canControl: () => false,
      changed: () => {},
    },
    "context",
    {
      submit: async () => {},
      control: async (_access, id) => {
        controls++;
        return { requestId: id, state: "cancelled" };
      },
      getRequest: async () => null,
      updateLink: async () => {},
      updateContext: async () => {},
    },
  );
  await assert.rejects(
    runtime.control({ userId: "member" } as AttachmentAccess, "req", "cancel"),
    /forbidden/,
  );
  assert.equal(controls, 0);
});
