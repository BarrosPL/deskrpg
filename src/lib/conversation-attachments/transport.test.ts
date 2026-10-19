import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnerConversationFilesClient,
  createProfileConversationFilesClient,
} from "../hermes/plugin-client";
test("original file grants and preparation use separate keys and bind both session identities", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: URL | string | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({ grant: "g", expiresAt: "later" });
  }) as typeof fetch;
  const owner = createOwnerConversationFilesClient({
    baseUrl: "http://gateway",
    ownerToken: "owner",
    fetchImpl,
  });
  const profile = createProfileConversationFilesClient({
    baseUrl: "http://gateway",
    profileName: "a/b",
    profileToken: "profile",
    fetchImpl,
  });
  await owner.grant("f", {
    conversationId: "c",
    profileName: "a/b",
    sessionId: "actual",
    sessionKey: "scope",
  });
  await profile.prepare({ grant: "g", requestId: "r" });
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer owner");
  assert.equal(new Headers(calls[1].init?.headers).get("authorization"), "Bearer profile");
  assert.match(calls[1].url, /p\/a%2Fb\/deskrpg\/conversation-files\/prepare/);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    conversationId: "c",
    profileName: "a/b",
    sessionId: "actual",
    sessionKey: "scope",
  });
});
