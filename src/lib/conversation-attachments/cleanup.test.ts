import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { setupThrowawaySqlite, seedGateway, seedUser } from "@/test-setup/npc-seed";
setupThrowawaySqlite("attachment-recovery");
test("recovery revokes persisted bindings, retries offline failures, and preserves originals", async (t) => {
  let offline = true;
  const calls: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/deskrpg/conversation-files/bindings/revoke");
    assert.equal(req.headers.authorization, "Bearer gateway-owner-key-1234567890");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(offline ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(offline ? { code: "attachment_prepare_failed" } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const owner = await seedUser();
  const gateway = await seedGateway(
    owner.id,
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  const repo = await import("./repository");
  const { revokeInterruptedAttachmentBindings, runAttachmentCleanup } = await import("./cleanup");
  const context = await repo.createContext({
    kind: "dm",
    scopeKey: "recovery",
    gatewayId: gateway.id,
    sourceGatewayId: gateway.id,
    sourceChannelId: "channel",
    ownerUserId: owner.id,
  });
  await repo.insertLink({
    id: "retained",
    contextId: context.id,
    pluginFileId: "remote",
    uploaderId: owner.id,
    messageId: "message",
    name: "reference.pdf",
    mimeType: "application/pdf",
    bytes: 3,
    sha256: "hash",
    status: "stored",
    requestId: "upload",
    createdAt: "2020-01-01",
    updatedAt: "2020-01-01",
  });
  await repo.createRequest({
    id: "crashed",
    contextId: context.id,
    senderId: owner.id,
    revision: 0,
    targets: [],
    fileIds: ["retained"],
  });
  const payload = {
    targets: [{ npcId: "npc", profileName: "alpha", sessionKey: "scope", sessionId: "actual" }],
    byNpc: {},
  };
  await repo.transitionRequest("crashed", ["pending"], "preparing", {
    leaseStateJson: JSON.stringify(payload),
  });
  await repo.recoverInterruptedRequests();
  assert.equal((await repo.getRequest("crashed"))?.status, "outcome_unknown");
  assert.deepEqual(await revokeInterruptedAttachmentBindings(), { revoked: 0, pending: 1 });
  assert.equal(
    JSON.parse((await repo.getRequest("crashed"))!.leaseStateJson).bindingsRevoked,
    undefined,
  );
  offline = false;
  await repo.createRequest({
    id: "newer",
    contextId: context.id,
    senderId: owner.id,
    revision: 0,
    targets: [],
    fileIds: [],
  });
  const before = calls.length;
  assert.deepEqual(await revokeInterruptedAttachmentBindings(), { revoked: 0, pending: 1 });
  assert.equal(calls.length, before, "live requests defer old binding revocation");
  await repo.transitionRequest("newer", ["pending"], "done");
  assert.deepEqual(await revokeInterruptedAttachmentBindings(), { revoked: 1, pending: 0 });
  assert.deepEqual(calls.at(-1), {
    conversationId: context.id,
    profileName: "alpha",
    sessionId: "actual",
  });
  assert.equal(
    JSON.parse((await repo.getRequest("crashed"))!.leaseStateJson).bindingsRevoked,
    true,
  );
  const after = calls.length;
  await runAttachmentCleanup();
  assert.equal(calls.length, after, "successful revocation is not repeated");
  assert.equal((await repo.getLink("retained"))?.status, "stored");
  await repo.transitionRequest("newer", ["done"], "done", {
    leaseStateJson: JSON.stringify(payload),
  });
  await repo.markContextDeleted(context.id);
  assert.deepEqual(await revokeInterruptedAttachmentBindings(), { revoked: 1, pending: 0 });
  assert.equal((await repo.getLink("retained"))?.status, "delete_pending");
});
