CREATE TABLE "workspace_life_workflows" (
	"workspace_id" text,
	"life" timestamp with time zone,
	"name" text,
	"workflow_id" uuid NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	CONSTRAINT "workspace_life_workflows_pkey" PRIMARY KEY("workspace_id","life","name")
);
--> statement-breakpoint
CREATE TABLE "workspace_lives" (
	"workspace_id" text,
	"started_at" timestamp with time zone,
	"launched_at" timestamp with time zone,
	"time_zone" text,
	"scratch_dirs" text[],
	"tracked_scratch_dirs" text[] DEFAULT '{}'::text[] NOT NULL,
	"deadline" timestamp with time zone,
	"timeout_minutes" integer,
	"deadline_is_next_run" boolean DEFAULT false NOT NULL,
	"stopped_at" timestamp with time zone,
	"death_reason" text,
	"death_detail" text,
	"death_seen_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"steps_outcome" text,
	"ignored_cleaned_at" timestamp with time zone,
	CONSTRAINT "workspace_lives_pkey" PRIMARY KEY("workspace_id","started_at")
);
--> statement-breakpoint
-- Each workspace's current life, with what it launched with and how it
-- ended. It is taken to have come up as it started, since nothing recorded
-- when it did. A clean of its ignored files counted only when it began
-- after the stop, which a life's own stamp now says by being set.
INSERT INTO "workspace_lives" (
  "workspace_id", "started_at", "launched_at", "time_zone", "scratch_dirs", "tracked_scratch_dirs", "deadline",
  "timeout_minutes", "deadline_is_next_run", "stopped_at", "death_reason", "death_detail", "death_seen_by",
  "steps_outcome", "ignored_cleaned_at"
)
SELECT "workspace_id", coalesce("life_started_at", "created_at"), coalesce("life_started_at", "created_at"), "time_zone",
  "scratch_dirs", "tracked_scratch_dirs", "deadline", "timeout_minutes", "deadline_is_next_run", "stopped_at",
  "death_reason", "death_detail", "death_seen_by", "steps_outcome",
  CASE WHEN "ignored_cleaned_at" >= "stopped_at" THEN "ignored_cleaned_at" END
FROM "workspaces";--> statement-breakpoint
-- A step recorded before steps named their stored workflow has none to
-- belong to.
DELETE FROM "workspace_steps" WHERE "workflow_id" IS NULL;--> statement-breakpoint
-- The earlier lives that still have step rows, which came up to run them.
-- No stop was recorded for them, so they have none.
INSERT INTO "workspace_lives" ("workspace_id", "started_at", "launched_at")
SELECT DISTINCT "workspace_id", "life", "life" FROM "workspace_steps"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Each life's workflows, as its step rows name them. Steps added to a life
-- before steps had workflows share the empty name, and take its first
-- step's workflow.
INSERT INTO "workspace_life_workflows" ("workspace_id", "life", "name", "workflow_id")
SELECT DISTINCT ON ("workspace_id", "life", "workflow_name") "workspace_id", "life", "workflow_name", "workflow_id"
FROM "workspace_steps" ORDER BY "workspace_id", "life", "workflow_name", "ordinal";--> statement-breakpoint
ALTER TABLE "workspace_steps" DROP CONSTRAINT "workspace_steps_workspace_id_workspaces_workspace_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_steps" DROP CONSTRAINT "workspace_steps_workflow_id_workflows_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_steps" DROP COLUMN "workflow_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "steps_outcome";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "stopped_at";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "death_reason";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "death_detail";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "death_seen_by";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "life_started_at";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "time_zone";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "deadline";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "timeout_minutes";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "deadline_is_next_run";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "ignored_cleaned_at";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "scratch_dirs";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "tracked_scratch_dirs";--> statement-breakpoint
ALTER TABLE "workspace_steps" DROP CONSTRAINT "workspace_steps_pkey";--> statement-breakpoint
ALTER TABLE "workspace_steps" ADD PRIMARY KEY ("workspace_id","life","workflow_name","name");--> statement-breakpoint
ALTER TABLE "workspace_life_workflows" ADD CONSTRAINT "workspace_life_workflows_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id");--> statement-breakpoint
ALTER TABLE "workspace_life_workflows" ADD CONSTRAINT "workspace_life_workflows_life_fkey" FOREIGN KEY ("workspace_id","life") REFERENCES "workspace_lives"("workspace_id","started_at") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_lives" ADD CONSTRAINT "workspace_lives_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_steps" ADD CONSTRAINT "workspace_steps_life_workflow_fkey" FOREIGN KEY ("workspace_id","life","workflow_name") REFERENCES "workspace_life_workflows"("workspace_id","life","name") ON DELETE CASCADE;