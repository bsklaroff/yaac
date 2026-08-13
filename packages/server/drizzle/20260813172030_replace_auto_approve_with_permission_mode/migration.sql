ALTER TABLE "projects" ADD COLUMN "last_permission_mode" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "permission_mode" text DEFAULT 'bypass' NOT NULL;--> statement-breakpoint
UPDATE "worktrees" SET "permission_mode" = 'manual' WHERE "auto_approve" = false;--> statement-breakpoint
ALTER TABLE "worktrees" DROP COLUMN "auto_approve";