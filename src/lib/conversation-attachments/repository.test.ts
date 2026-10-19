import assert from "node:assert/strict";
import test, { before } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_TYPE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "attachments-")), "test.db");
let repo: typeof import("./repository");
let resolveAttachmentAccess: typeof import("./access").resolveAttachmentAccess;
let runAttachmentCleanup: typeof import("./cleanup").runAttachmentCleanup;
let uploadOriginal: typeof import("./service").uploadOriginal;
let listAttachments: typeof import("./service").listAttachments;
before(async () => {
  repo = await import("./repository");
  ({ resolveAttachmentAccess } = await import("./access"));
  ({ runAttachmentCleanup } = await import("./cleanup"));
  ({ uploadOriginal, listAttachments } = await import("./service"));
});
import type { AttachmentAccess } from "./access";
import { createHash } from "node:crypto";
test("durable idempotent requests use compare-and-swap and never rerun after recovery", async () => {
  const c = await repo.createContext({
    kind: "dm",
    scopeKey: "s",
    sourceChannelId: "ch",
    sourceGatewayId: "gw",
    ownerUserId: "u",
  });
  const row = await repo.createRequest({
    id: "req",
    contextId: c.id,
    senderId: "u",
    revision: 0,
    targets: [],
    fileIds: [],
  });
  assert.equal(row.status, "pending");
  assert.equal(await repo.transitionRequest("req", ["pending"], "preparing"), true);
  assert.equal(await repo.transitionRequest("req", ["pending"], "preparing"), false);
  await repo.recoverInterruptedRequests();
  assert.equal((await repo.getRequest("req"))?.status, "outcome_unknown");
});
test("unauthenticated and foreign channel requests fail before calling upstream", async () => {
  await assert.rejects(resolveAttachmentAccess(null, "missing", { kind: "dm", id: "n" }, "read"), {
    status: 401,
  });
  await assert.rejects(
    resolveAttachmentAccess("stranger", "missing", { kind: "room", id: "r" }, "read"),
    { status: 404 },
  );
});
test("upload retries preserve one opaque link and reject changed bytes", async () => {
  const context = await repo.createContext({
    kind: "dm",
    scopeKey: "upload",
    sourceChannelId: "ch",
    sourceGatewayId: "gw",
    ownerUserId: "u",
  });
  let uploads = 0;
  const access = {
    userId: "u",
    context,
    client: {
      upload: async (_c: string, _r: string, f: File) => {
        uploads++;
        return {
          ok: true,
          data: {
            id: "remote",
            name: f.name,
            mimeType: f.type,
            bytes: f.size,
            sha256: createHash("sha256")
              .update(Buffer.from(await f.arrayBuffer()))
              .digest("hex"),
          },
        };
      },
    },
  } as unknown as AttachmentAccess;
  const file = new File(["hello"], "a.pdf", { type: "application/pdf" });
  const first = await uploadOriginal(access, "upload-request", file);
  assert.deepEqual(await uploadOriginal(access, "upload-request", file), first);
  assert.equal(uploads, 1);
  assert.notEqual(first.id, "remote");
  await assert.rejects(
    uploadOriginal(
      access,
      "upload-request",
      new File(["other"], "a.pdf", { type: "application/pdf" }),
    ),
    { status: 409 },
  );
  assert.equal((await listAttachments(access)).length, 1);
  const response = JSON.stringify(first);
  assert.equal(response.includes("pluginFileId"), false);
  assert.equal(response.includes("agentPath"), false);
});
test("offline cleanup retains tombstone ledger and linked originals", async () => {
  const context = await repo.createContext({
    kind: "room",
    scopeKey: "cleanup",
    sourceChannelId: "ch",
    sourceGatewayId: "lost",
    ownerUserId: "u",
  });
  const row = {
    contextId: context.id,
    pluginFileId: "remote",
    uploaderId: "u",
    name: "a.pdf",
    mimeType: "application/pdf",
    bytes: 1,
    sha256: "hash",
    status: "stored",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
  };
  await repo.insertLink({ ...row, id: "orphan", requestId: "o" });
  await repo.insertLink({ ...row, id: "linked", requestId: "l", messageId: "msg" });
  const report = await runAttachmentCleanup();
  assert.ok(report.pending > 0);
  assert.equal((await repo.getLink("orphan"))?.status, "delete_pending");
  assert.equal((await repo.getLink("linked"))?.status, "stored");
});
