CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"time_zone" text NOT NULL,
	"prompt" text NOT NULL,
	"tool" text NOT NULL,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"permission_mode" text NOT NULL,
	"effort" text,
	"branch" text NOT NULL,
	"group_id" text,
	"timeout_minutes" integer,
	"paused" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "cron" text;--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deadline" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "queued_workspaces_routine_id_index" ON "queued_workspaces" ("routine_id");--> statement-breakpoint
CREATE INDEX "routines_project_id_index" ON "routines" ("project_id");--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD CONSTRAINT "queued_workspaces_routine_id_routines_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "routines"("id") ON DELETE SET NULL;