ALTER TABLE "workspace_lives" ADD COLUMN "tree_dir" text;--> statement-breakpoint
ALTER TABLE "workspace_lives" ADD COLUMN "node" text;--> statement-breakpoint
ALTER TABLE "workspace_lives" ADD COLUMN "checkpointed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_lives" ADD COLUMN "checkpoint_outcome" text;