UPDATE "worktrees" SET "permission_mode" = "observed_permission_mode" WHERE "observed_permission_mode" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "worktrees" DROP COLUMN "observed_permission_mode";
