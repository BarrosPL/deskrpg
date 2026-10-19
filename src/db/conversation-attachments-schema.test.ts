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
test("source deletion preserves cleanup ledger and immutable source identity", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE channels (id TEXT PRIMARY KEY); CREATE TABLE gateway_resources (id TEXT PRIMARY KEY); INSERT INTO channels VALUES ('ch'); INSERT INTO gateway_resources VALUES ('gw');",
  );
  ensureConversationAttachments(db);
  db.prepare(
    "INSERT INTO conversation_attachment_contexts (id,kind,scope_key,channel_id,gateway_id,source_channel_id,source_gateway_id,owner_user_id,revision,lifecycle,created_at) VALUES ('c','room','scope','ch','gw','ch','gw','u',0,'active','now')",
  ).run();
  db.exec("DELETE FROM channels; DELETE FROM gateway_resources;");
  const row = db
    .prepare(
      "SELECT channel_id,gateway_id,source_channel_id,source_gateway_id FROM conversation_attachment_contexts",
    )
    .get();
  assert.deepEqual(row, {
    channel_id: null,
    gateway_id: null,
    source_channel_id: "ch",
    source_gateway_id: "gw",
  });
  db.close();
});
test("fresh base schema and compatibility upgrade both contain the attachment ledger", () => {
  const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");
  const { ensureSqliteCompatibility } = require("./server-db.js");
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  for (const table of [
    "conversation_attachment_links",
    "conversation_attachment_requests",
    "conversation_attachment_contexts",
  ])
    db.exec(`DROP TABLE ${table}`);
  ensureSqliteCompatibility(db);
  ensureSqliteCompatibility(db);
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'conversation_attachment_%'",
        )
        .get() as { n: number }
    ).n,
    3,
  );
  db.close();
});
