import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ensureConversationAttachments } = require("./sqlite-conversation-attachments.js");
test("attachment ledger bootstraps repeatedly and preserves tombstones", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE channels (id TEXT PRIMARY KEY); CREATE TABLE gateway_resources (id TEXT PRIMARY KEY);",
  );
  ensureConversationAttachments(db);
  ensureConversationAttachments(db);
  db.prepare(
    "INSERT INTO conversation_attachment_contexts (id,kind,scope_key,source_channel_id,source_gateway_id,owner_user_id,revision,lifecycle,created_at) VALUES ('c','dm','scope','ch','gw','u',0,'active','now')",
  ).run();
  db.prepare(
    "INSERT INTO conversation_attachment_links (id,context_id,plugin_file_id,uploader_id,name,mime_type,bytes,sha256,status,request_id,created_at,updated_at) VALUES ('f','c','p','u','a.pdf','application/pdf',1,'hash','deleted','r','now','now')",
  ).run();
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM conversation_attachment_links").get() as { n: number })
      .n,
    1,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO conversation_attachment_contexts (id,kind,scope_key,source_channel_id,source_gateway_id,owner_user_id,revision,lifecycle,created_at) VALUES ('d','dm','scope','ch','gw','u',0,'active','now')",
        )
        .run(),
    /UNIQUE/,
  );
  db.close();
});
