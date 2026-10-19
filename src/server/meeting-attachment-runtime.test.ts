import assert from "node:assert/strict";
import test from "node:test";
import { MeetingAttachmentBarrier } from "./meeting-attachment-runtime";

test("next turn waits for every staged request and failed files stay blocked until excluded", async () => {
  const barrier = new MeetingAttachmentBarrier();
  barrier.stage("a", ["file-a"]);
  barrier.stage("b", ["file-b"]);
  let entered = false;
  const waiting = barrier.wait(new AbortController().signal).then(() => {
    entered = true;
  });
  barrier.change("a", "done");
  await Promise.resolve();
  assert.equal(entered, false);
  barrier.change("b", "failed");
  await Promise.resolve();
  assert.equal(entered, false);
  barrier.exclude("b", ["file-b"]);
  await waiting;
  assert.deepEqual(barrier.files(), ["file-a"]);
});
test("late completion cannot restore excluded material or restart an ended meeting", async () => {
  const barrier = new MeetingAttachmentBarrier();
  barrier.stage("a", ["file-a"]);
  barrier.exclude("a", ["file-a"]);
  barrier.change("a", "done");
  assert.deepEqual(barrier.files(), []);
  barrier.stage("b", ["file-b"]);
  const waiting = barrier.wait(new AbortController().signal);
  barrier.stop();
  await assert.rejects(waiting, /aborted/);
  barrier.change("b", "done");
  assert.equal(barrier.active, false);
});
test("aborting a waiting turn leaves original material available for a later turn", async () => {
  const barrier = new MeetingAttachmentBarrier();
  barrier.stage("a", ["file-a"]);
  const controller = new AbortController();
  const waiting = barrier.wait(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  barrier.change("a", "done");
  await barrier.wait(new AbortController().signal);
  assert.deepEqual(barrier.files(), ["file-a"]);
});

test("active meeting files fail closed for unknown contexts and nonparticipants", async () => {
  const { authorizeMeetingAttachment, registerMeetingAttachmentController } =
    await import("./meeting-attachment-runtime");
  let active = true;
  registerMeetingAttachmentController({
    conversation: { kind: "meeting", id: "access-context" },
    channelId: "c",
    get active() {
      return active;
    },
    authorize: async (id) => id === "participant",
    control: async (_a, id) => ({ requestId: id, state: "cancelled" }),
  });
  assert.equal(
    await authorizeMeetingAttachment({
      channelId: "c",
      contextId: "access-context",
      userId: "outsider",
      action: "read",
    }),
    false,
  );
  assert.equal(
    await authorizeMeetingAttachment({
      channelId: "c",
      contextId: "access-context",
      userId: "participant",
      action: "read",
    }),
    true,
  );
  assert.equal(
    await authorizeMeetingAttachment({
      channelId: "other",
      contextId: "access-context",
      userId: "participant",
      action: "read",
    }),
    false,
  );
  active = false;
  assert.equal(
    await authorizeMeetingAttachment({
      channelId: "c",
      contextId: "access-context",
      userId: "participant",
      action: "upload",
    }),
    false,
  );
});

test("approval wrappers preserve the session preparation capability", async () => {
  const { replaceExecute } = await import("../lib/adapters/replace-execute");
  const wrapped = replaceExecute(
    {
      type: "fake",
      ensureSession: async (key) => `session:${key}`,
      execute: async () => ({ response: "", session: { sessionRef: "s" } }),
      testConnection: async () => ({ status: "ok" }),
    },
    async () => ({ response: "", session: { sessionRef: "s" } }),
  );
  assert.equal(await wrapped.ensureSession?.("meeting"), "session:meeting");
});

test("a retried inner batch can complete while the outer batch still holds its lease", async () => {
  const barrier = new MeetingAttachmentBarrier();
  barrier.stage("outer", ["one"]);
  barrier.change("outer", "running");
  barrier.stage("inner", ["two"]);
  barrier.change("inner", "failed");
  const waiting = barrier.waitRequest("inner", new AbortController().signal);
  barrier.change("inner", "done");
  await waiting;
  assert.equal(barrier.ready, false);
  barrier.change("outer", "done");
  assert.equal(barrier.ready, true);
});
