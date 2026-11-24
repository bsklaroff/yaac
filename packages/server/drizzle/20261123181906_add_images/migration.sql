CREATE TABLE "image_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"image_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"layer" text NOT NULL,
	"tag" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"no_cache" boolean DEFAULT false NOT NULL,
	"requested_by" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"warnings" jsonb DEFAULT '[]' NOT NULL,
	"parent_tag" text,
	"base_digests" jsonb DEFAULT '{}' NOT NULL,
	"buildkit_version" text,
	"cached_steps" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"blocked_hosts" jsonb DEFAULT '[]' NOT NULL,
	"log_path" text
);
--> statement-breakpoint
CREATE TABLE "image_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"image_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"dockerfile" text NOT NULL,
	"files" jsonb DEFAULT '{}' NOT NULL,
	"content_hash" text NOT NULL,
	"author" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"current_revision_id" uuid,
	"last_built_revision_id" uuid,
	"last_built_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "install_settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_image_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_image_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "image_cache_days" integer;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "image_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "image_tag" text;--> statement-breakpoint
CREATE INDEX "image_builds_image_id_index" ON "image_builds" ("image_id");--> statement-breakpoint
CREATE INDEX "image_builds_project_id_index" ON "image_builds" ("project_id");--> statement-breakpoint
CREATE INDEX "image_builds_status_index" ON "image_builds" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "image_revisions_image_id_number_index" ON "image_revisions" ("image_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "images_project_id_name_index" ON "images" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "images_user_id_name_index" ON "images" ("user_id","name");--> statement-breakpoint
ALTER TABLE "image_builds" ADD CONSTRAINT "image_builds_image_id_images_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "image_revisions" ADD CONSTRAINT "image_revisions_image_id_images_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE;