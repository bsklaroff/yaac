CREATE TABLE "workspace_steps" (
	"workspace_id" text,
	"name" text,
	"project_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"spec" jsonb NOT NULL,
	"state" text NOT NULL,
	"exit_code" integer,
	"life" timestamp with time zone NOT NULL,
	"ordinal" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "workspace_steps_pkey" PRIMARY KEY("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "init_steps" json DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "steps" json;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "non_interactive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "commit" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "steps" json;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "non_interactive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "start_commit" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "start_steps" json;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "non_interactive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "steps_outcome" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "rerun_of" text;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ALTER COLUMN "prompt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ALTER COLUMN "branch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ALTER COLUMN "prompt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ALTER COLUMN "branch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_steps" ADD CONSTRAINT "workspace_steps_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id") ON DELETE CASCADE;