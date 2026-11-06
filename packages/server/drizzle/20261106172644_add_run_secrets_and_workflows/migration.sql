CREATE TABLE "project_run_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sealed_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_approvals" (
	"workflow_id" uuid,
	"ref" text,
	CONSTRAINT "workflow_approvals_pkey" PRIMARY KEY("workflow_id","ref")
);
--> statement-breakpoint
CREATE TABLE "workflow_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workflow_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"steps" json NOT NULL,
	"secrets" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"revision_id" uuid,
	"commit" text,
	CONSTRAINT "workflow_runs_pkey" PRIMARY KEY("revision_id","commit")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "steps" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_run_secrets_project_id_name_index" ON "project_run_secrets" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_revisions_workflow_id_number_index" ON "workflow_revisions" ("workflow_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_project_id_name_index" ON "workflows" ("project_id","name");--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id");--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id");--> statement-breakpoint
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_revision_id_workflow_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "workflow_revisions"("id") ON DELETE CASCADE;