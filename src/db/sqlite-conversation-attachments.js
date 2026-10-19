"use strict";
const CONVERSATION_ATTACHMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_attachment_contexts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  gateway_id TEXT REFERENCES gateway_resources(id) ON DELETE SET NULL,
  source_channel_id TEXT NOT NULL,
  source_gateway_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  npc_id TEXT,
  room_id TEXT,
  meeting_minutes_id TEXT,
  revision INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scope_key)
);
CREATE TABLE IF NOT EXISTS conversation_attachment_links (
  id TEXT PRIMARY KEY NOT NULL,
  context_id TEXT NOT NULL,
  plugin_file_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(context_id,request_id)
);
CREATE TABLE IF NOT EXISTS conversation_attachment_requests (
  id TEXT PRIMARY KEY NOT NULL,
  context_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  target_snapshot_json TEXT NOT NULL,
  selected_file_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
function ensureConversationAttachments(sqlite) {
  sqlite.exec(CONVERSATION_ATTACHMENTS_SCHEMA);
}
module.exports = { ensureConversationAttachments, CONVERSATION_ATTACHMENTS_SCHEMA };
