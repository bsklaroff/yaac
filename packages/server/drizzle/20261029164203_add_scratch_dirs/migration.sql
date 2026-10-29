ALTER TABLE "projects" ADD COLUMN "scratch_dirs" jsonb DEFAULT '{"dirs":[{"path":"node_modules"},{"path":"target"}],"ignoredTracked":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "scratch_dirs" text[];--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "tracked_scratch_dirs" text[] DEFAULT '{}'::text[] NOT NULL;