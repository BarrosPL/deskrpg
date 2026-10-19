CREATE TABLE "conversation_attachment_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"channel_id" uuid,
	"gateway_id" uuid,
	"source_channel_id" text NOT NULL,
	"source_gateway_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"npc_id" text,
	"room_id" text,
	"meeting_minutes_id" text,
	"revision" integer NOT NULL,
	"lifecycle" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "conversation_attachment_contexts_scope_unique" UNIQUE("scope_key")
);
--> statement-breakpoint
CREATE TABLE "conversation_attachment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"plugin_file_id" text NOT NULL,
	"uploader_id" text NOT NULL,
	"message_id" text,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"request_id" text NOT NULL,
	"error_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "conversation_attachment_links_scope_unique" UNIQUE("context_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_attachment_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"revision" integer NOT NULL,
	"target_snapshot_json" text NOT NULL,
	"selected_file_ids_json" text NOT NULL,
	"status" text NOT NULL,
	"lease_state_json" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_attachment_contexts" ADD CONSTRAINT "conversation_attachment_contexts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_attachment_contexts" ADD CONSTRAINT "conversation_attachment_contexts_gateway_id_gateway_resources_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateway_resources"("id") ON DELETE set null ON UPDATE no action;