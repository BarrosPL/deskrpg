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

test("restarts preparation after a material revision changes without executing stale files", async () => {
  let runtime: LiveMeetingAttachments;
  let turnPreparations = 0;
  const prompts: string[] = [];
  runtime = new LiveMeetingAttachments(
    {
      channelId: "c",
      userId: "owner",
      isParticipant: () => true,
      canControl: () => true,
      changed: () => {},
    },
    "context",
    {
      submit: async (input) => {
        input.changed?.({ requestId: input.requestId, state: "preparing" });
        if (input.messageId.startsWith("meeting-turn-") && ++turnPreparations === 1) {
          await runtime.stage("owner", "second", ["two"], "message-two");
        }
        try {
          await input.validate?.();
        } catch {
          input.changed?.({ requestId: input.requestId, state: "failed" });
          return;
        }
        await input.run(
          {
            a: input.fileIds.map((id) => ({
              id,
              name: `${id}.pdf`,
              mimeType: "application/pdf",
              bytes: 1,
              sha256: "hash",
              agentPath: `/cache/${id}`,
              leaseId: id,
              expiresAt: "later",
            })),
          },
          new AbortController().signal,
        );
        input.changed?.({ requestId: input.requestId, state: "done" });
      },
      control: async (_a, id) => ({ requestId: id, state: "cancelled" }),
      getRequest: async () => null,
      updateLink: async () => {},
      updateContext: async () => {},
    },
  );
  const adapter = runtime.wrap(
    "a",
    {
      type: "fake",
      execute: async (options) => {
        prompts.push(options.prompt);
        return { response: "ok", session: { sessionRef: "s" } };
      },
      testConnection: async () => ({ status: "ok" }),
    },
    "s",
  );
  await runtime.stage("owner", "first", ["one"], "message-one");
  await adapter.execute({ sessionKey: "s", prompt: "read" });
  assert.equal(turnPreparations, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /one.pdf/);
  assert.match(prompts[0], /two.pdf/);
});

test("meeting wrappers retain steering and summary capabilities", async () => {
  const runtime = new LiveMeetingAttachments(
    {
      channelId: "c",
      userId: "u",
      isParticipant: () => true,
      canControl: () => true,
      changed: () => {},
    },
    "context",
  );
  let steered = "";
  const wrapped = runtime.wrap(
    "a",
    {
      type: "fake",
      execute: async () => ({ response: "", session: { sessionRef: "s" } }),
      steer: async (text) => {
        steered = text;
      },
      getSessionSummary: async () => "summary",
      testConnection: async () => ({ status: "ok" }),
    },
    "s",
  );
  await wrapped.steer?.("continue");
  assert.equal(steered, "continue");
  assert.equal(await wrapped.getSessionSummary?.("s"), "summary");
});

test("excluding completed material does not try to cancel a retired execution", async () => {
  const excluded: string[] = [];
  let controls = 0;
  const runtime = new LiveMeetingAttachments(
    {
      channelId: "c",
      userId: "owner",
      isParticipant: () => true,
      canControl: () => true,
      changed: () => {},
    },
    "context",
    {
      submit: async (input) => {
        input.changed?.({ requestId: input.requestId, state: "done" });
      },
      control: async (_access, id) => {
        controls++;
        throw new Error(`Unexpected cancel: ${id}`);
      },
      getRequest: async () => ({ status: "done" }) as never,
      updateLink: async (id) => {
        excluded.push(id);
      },
      updateContext: async () => {},
    },
  );
  await runtime.stage("owner", "request", ["file"], "message");
  const result = await runtime.control(
    { userId: "owner" } as AttachmentAccess,
    "request",
    "exclude",
    ["file"],
  );
  assert.equal(result.state, "cancelled");
  assert.deepEqual(excluded, ["file"]);
  assert.equal(controls, 0);
  assert.equal(runtime.ready, true);
});
