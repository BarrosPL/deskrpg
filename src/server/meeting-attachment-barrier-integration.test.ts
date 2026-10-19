import assert from "node:assert/strict";
import test from "node:test";
import { ChannelRuntime, type EngineParticipant } from "../lib/conversation/channel-runtime";
import { MeetingAttachmentBarrier } from "./meeting-attachment-runtime";

// The pure barrier has no server dependencies at runtime; domain tests inject the same callback.
test("stopping a meeting cancels the attachment wait without starting an NPC", async () => {
  const barrier = new MeetingAttachmentBarrier();
  barrier.stage("request", ["file"]);
  let calls = 0;
  const participant: EngineParticipant = {
    npcId: "a",
    displayName: "A",
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    sessionKey: "a",
    adapter: {
      type: "fake",
      execute: async () => {
        calls++;
        return { response: "hello", session: { sessionRef: "a" } };
      },
      testConnection: async () => ({ status: "ok" }),
    },
  };
  const runtime = new ChannelRuntime(
    {
      mode: "meeting",
      topic: "files",
      participants: [participant],
      quota: { maxTurnsPerAgent: 2, maxTotalTurns: 2, cooldownMs: 0 },
      beforeTurn: (_id, signal) => barrier.wait(signal),
    },
    {},
  );
  const running = runtime.run();
  runtime.stop();
  await running;
  assert.equal(calls, 0);
});
