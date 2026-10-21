-- Death and waiting-spell read marks become per user. A mark already set
-- was set by the project's owner, the only user who could set one.
ALTER TABLE "workspaces" ADD COLUMN "death_seen_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "waiting_seen_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
UPDATE "workspaces" SET
  "death_seen_by" = CASE WHEN "workspaces"."death_seen" THEN ARRAY["projects"."owner"] ELSE '{}'::uuid[] END,
  "waiting_seen_by" = CASE WHEN "workspaces"."waiting_seen" THEN ARRAY["projects"."owner"] ELSE '{}'::uuid[] END
  FROM "projects" WHERE "projects"."id" = "workspaces"."project_id"
  AND ("workspaces"."death_seen" OR "workspaces"."waiting_seen");--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "death_seen";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "waiting_seen";
