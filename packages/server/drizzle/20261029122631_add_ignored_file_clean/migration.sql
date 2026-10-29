ALTER TABLE "projects" ADD COLUMN "kept_ignored_paths" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ignored_cleaned_at" timestamp with time zone;--> statement-breakpoint
UPDATE "workspaces" SET "ignored_cleaned_at" = "stopped_at" WHERE "stopped_at" IS NOT NULL;