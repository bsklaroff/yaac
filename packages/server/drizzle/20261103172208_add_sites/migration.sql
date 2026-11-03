CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL UNIQUE,
	"port" integer NOT NULL,
	"steps" json NOT NULL,
	"volume_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"live_workspace_id" text,
	"live_since" timestamp with time zone,
	"live_port" integer,
	"release_workspace_id" text,
	"release_commit" text,
	"release_image" text,
	"deploy_workspace_id" text,
	"deploy_commit" text,
	"deploy_image" text,
	"deploy_port" integer,
	"deploy_phase" text,
	"deploy_started_at" timestamp with time zone,
	"deploy_deadline" timestamp with time zone,
	"deploy_replacing" boolean DEFAULT false NOT NULL,
	"deploy_handoff_from" text,
	"drain_workspace_id" text,
	"drain_until" timestamp with time zone,
	"last_deploy_workspace_id" text,
	"last_deploy_commit" text,
	"last_deploy_outcome" text,
	"last_deploy_error" text,
	"last_deploy_finished_at" timestamp with time zone,
	"replace_failures" integer DEFAULT 0 NOT NULL,
	"replace_after" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "volumes" ADD COLUMN "next_holder_workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "site_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_project_id_name_index" ON "sites" ("project_id","name");