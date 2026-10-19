import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  setupThrowawaySqlite,
  seedUser,
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
} from "@/test-setup/npc-seed";
setupThrowawaySqlite("original-attachment-integration");

test("original attachment services enforce conversation privacy and prepare verified bytes over HTTP", async (t) => {
  const files = new Map<
    string,
    { id: string; name: string; mimeType: string; bytes: number; sha256: string }
  >();
  const grants = new Map<string, string>();
  const released: string[] = [];
  const linked: string[] = [];
  let corruptUpload = false;
  let corruptPrepared = false;
  let failPrepared = false;
  let upstreamCalls = 0;
  const server = createServer(async (req, res) => {
    try {
      upstreamCalls++;
      const url = req.url!;
      const profile = url.startsWith("/p/");
      assert.equal(
        req.headers.authorization,
        `Bearer ${profile ? "profile-key-1234567890" : "gateway-owner-key-1234567890"}`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body =
        raw.length && !req.headers["content-type"]?.includes("multipart")
          ? JSON.parse(raw.toString())
          : {};
      let response: unknown = { ok: true };
      if (url === "/deskrpg/info") response = { capabilities: ["conversation_files_v1"] };
      else if (url === "/deskrpg/conversation-files" && req.method === "POST") {
        const form = await new Response(raw, {
          headers: { "content-type": req.headers["content-type"]! },
        }).formData();
        const file = form.get("file") as File;
        const meta = {
          id: randomUUID(),
          name: file.name,
          mimeType: file.type,
          bytes: file.size,
          sha256: createHash("sha256")
            .update(Buffer.from(await file.arrayBuffer()))
            .digest("hex"),
        };
        files.set(meta.id, meta);
        response = { ...meta, sha256: corruptUpload ? "wrong" : meta.sha256 };
      } else if (url.endsWith("/grant")) {
        assert.equal(body.sessionId, "hermes-session");
        assert.equal(body.sessionKey, "desk-scope");
        const grant = randomUUID();
        grants.set(grant, url.split("/")[3]);
        response = { grant, expiresAt: "2099-01-01" };
      } else if (url.endsWith("/prepare")) {
        if (failPrepared) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "attachment_prepare_failed" }));
          return;
        }
        const meta = files.get(grants.get(body.grant)!)!;
        response = {
          ...meta,
          sha256: corruptPrepared ? "wrong" : meta.sha256,
          agentPath: "/private/cache/original.pdf",
          leaseId: `lease-${meta.id}`,
          expiresAt: "2099-01-01",
        };
      } else if (url.endsWith("/release")) released.push(url.split("/").at(-2)!);
      else if (url.endsWith("/link")) linked.push(body.messageId);
      else if (req.method === "DELETE") response = { deleted: true };
      else throw new Error(`Unexpected request ${req.method} ${url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const owner = await seedUser();
  const other = await seedUser();
  const outsider = await seedUser();
  const channel = await seedChannel(owner.id);
  const gateway = await seedGateway(owner.id, `http://127.0.0.1:${address.port}`);
  const { db, channelGatewayBindings, channelMembers } = await import("@/db");
  await db
    .insert(channelGatewayBindings)
    .values({ channelId: channel.id, gatewayId: gateway.id, boundByUserId: owner.id });
  await db.insert(channelMembers).values({ channelId: channel.id, userId: other.id });
  const profile = await seedHermesProfile(gateway.id, { profileName: "alpha" });
  const npc = await seedNpc({ channelId: channel.id, hermesProfileId: profile.id });
  const { resolveAttachmentAccess, createMeetingContext } = await import("./access");
  const {
    uploadOriginal,
    listAttachments,
    prepareAttachments,
    linkAttachments,
    requestAttachmentDeletion,
    requireLink,
  } = await import("./service");
  const { getLink } = await import("./repository");
  const conversation = { kind: "dm" as const, id: npc.id };
  const access = await resolveAttachmentAccess(owner.id, channel.id, conversation, "upload");
  const original = new File(["%PDF original bytes"], "reference.pdf", { type: "application/pdf" });
  const file = await uploadOriginal(access, "upload-1", original);
  const request = {
    requestId: "send-1",
    conversation,
    revision: 0,
    fileIds: [file.id],
    targets: [
      {
        npcId: npc.id,
        profileName: "alpha",
        sessionId: "hermes-session",
        sessionKey: "desk-scope",
      },
    ],
  };
  await t.test("DM files stay private and browser metadata omits server capabilities", async () => {
    const otherAccess = await resolveAttachmentAccess(other.id, channel.id, conversation, "read");
    assert.notEqual(access.context.id, otherAccess.context.id);
    assert.deepEqual(await listAttachments(otherAccess), []);
    await assert.rejects(requireLink(otherAccess, file.id), { status: 404 });
    const views = await listAttachments(access);
    assert.deepEqual(
      Object.keys(views[0]).sort(),
      ["id", "name", "mimeType", "bytes", "sha256", "state"].sort(),
    );
    const before = upstreamCalls;
    await assert.rejects(resolveAttachmentAccess(outsider.id, channel.id, conversation, "read"), {
      status: 403,
    });
    assert.equal(upstreamCalls, before);
  });
  await t.test(
    "group files require room membership and active meeting files require live authorization",
    async () => {
      const { createRoom } = await import("@/lib/chat-rooms");
      const room = await createRoom({
        channelId: channel.id,
        createdBy: owner.id,
        name: "private",
        npcIds: [],
        userIds: [],
      });
      await resolveAttachmentAccess(owner.id, channel.id, { kind: "room", id: room.id }, "upload");
      await assert.rejects(
        resolveAttachmentAccess(other.id, channel.id, { kind: "room", id: room.id }, "read"),
        { status: 403 },
      );
      const context = await createMeetingContext({ channelId: channel.id, userId: owner.id });
      const { registerMeetingAttachmentAccess } = await import("./meeting-access-registry");
      registerMeetingAttachmentAccess(
        ({ userId, contextId }) => userId === owner.id && contextId === context.id,
      );
      await resolveAttachmentAccess(
        owner.id,
        channel.id,
        { kind: "meeting", id: context.id },
        "upload",
      );
      await assert.rejects(
        resolveAttachmentAccess(
          other.id,
          channel.id,
          { kind: "meeting", id: context.id },
          "upload",
        ),
        { status: 403 },
      );
    },
  );
  await t.test("upload checksum mismatch never creates a local file link", async () => {
    corruptUpload = true;
    await assert.rejects(uploadOriginal(access, "corrupt-upload", original), {
      code: "attachment_checksum_mismatch",
    });
    corruptUpload = false;
    assert.equal((await listAttachments(access)).length, 1);
  });
  await t.test(
    "failed preparation blocks readiness and releases checksum-invalid prepared leases",
    async () => {
      corruptPrepared = true;
      const result = await prepareAttachments(access, request);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failures[0].errorCode, "attachment_checksum_mismatch");
      assert.equal(released.length, 1);
      corruptPrepared = false;
      failPrepared = true;
      assert.equal((await prepareAttachments(access, request)).ok, false);
      failPrepared = false;
    },
  );
  await t.test(
    "a rejected target releases successful peers without resolving an empty lease set",
    async () => {
      const before = released.length;
      const result = await prepareAttachments(access, {
        ...request,
        targets: [...request.targets, { ...request.targets[0], npcId: "missing-npc" }],
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failures[0].npcId, "missing-npc");
      assert.equal(released.length, before + 1);
    },
  );
  await t.test("verified preparation links the original and deletion hides it", async () => {
    const prepared = await prepareAttachments(access, request);
    assert.equal(prepared.ok, true);
    if (prepared.ok) {
      const executionFile = prepared.byNpc[npc.id][0];
      assert.equal(executionFile.sha256, file.sha256);
      assert.equal(executionFile.id, file.id);
      assert.notEqual(executionFile.pluginFileId, file.id);
      assert.ok(files.has(executionFile.pluginFileId!));
      assert.ok(
        !JSON.stringify(await listAttachments(access)).includes(executionFile.pluginFileId!),
      );
    }
    await linkAttachments(access, [file.id], "message-1");
    assert.equal((await getLink(file.id))?.messageId, "message-1");
    assert.deepEqual(linked, ["message-1"]);
    await requestAttachmentDeletion(access, file.id);
    assert.equal((await getLink(file.id))?.status, "deleted");
    await assert.rejects(requireLink(access, file.id), { status: 404 });
  });
});
