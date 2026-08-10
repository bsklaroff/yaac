ALTER TABLE "worktrees" ADD COLUMN "spare" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "life_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "life_log_bytes" integer DEFAULT 0 NOT NULL;