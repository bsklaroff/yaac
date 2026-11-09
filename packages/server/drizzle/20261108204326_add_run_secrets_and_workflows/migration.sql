CREATE TABLE "named_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"named_workflow_id" uuid,
	"ref" text,
	CONSTRAINT "workflow_approvals_pkey" PRIMARY KEY("named_workflow_id","ref")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"workflow_id" uuid,
	"commit" text,
	CONSTRAINT "workflow_runs_pkey" PRIMARY KEY("workflow_id","commit")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"steps" json NOT NULL,
	"secrets" text[] DEFAULT '{}'::text[] NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "init_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "init_named_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "named_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "named_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "named_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_steps" ADD COLUMN "workflow_name" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workflow_name" text;--> statement-breakpoint
-- Every graph held inline becomes a workflow, one per project and content,
-- keyed as workflowHash in workflow-store.ts keys a graph naming no secrets.
INSERT INTO "workflows" ("project_id", "steps", "hash")
SELECT DISTINCT ON ("project_id", "hash") "project_id", "steps", "hash" FROM (
  SELECT "id" AS "project_id", "init_steps" AS "steps", encode(sha256(convert_to("init_steps"::text || E'\n', 'UTF8')), 'hex') AS "hash" FROM "projects" WHERE "init_steps"::text <> '{}'
  UNION ALL SELECT "project_id", "steps", encode(sha256(convert_to("steps"::text || E'\n', 'UTF8')), 'hex') FROM "queued_workspaces" WHERE "steps" IS NOT NULL
  UNION ALL SELECT "project_id", "steps", encode(sha256(convert_to("steps"::text || E'\n', 'UTF8')), 'hex') FROM "routines" WHERE "steps" IS NOT NULL
  UNION ALL SELECT "project_id", "steps", encode(sha256(convert_to("steps"::text || E'\n', 'UTF8')), 'hex') FROM "sites"
  UNION ALL SELECT "project_id", "start_steps", encode(sha256(convert_to("start_steps"::text || E'\n', 'UTF8')), 'hex') FROM "workspaces" WHERE "start_steps" IS NOT NULL
) "graphs";--> statement-breakpoint
UPDATE "projects" "p" SET "init_workflow_id" = "w"."id" FROM "workflows" "w"
  WHERE "w"."project_id" = "p"."id" AND "w"."hash" = encode(sha256(convert_to("p"."init_steps"::text || E'\n', 'UTF8')), 'hex') AND "p"."init_steps"::text <> '{}';--> statement-breakpoint
UPDATE "queued_workspaces" "q" SET "workflow_id" = "w"."id" FROM "workflows" "w"
  WHERE "w"."project_id" = "q"."project_id" AND "w"."hash" = encode(sha256(convert_to("q"."steps"::text || E'\n', 'UTF8')), 'hex') AND "q"."steps" IS NOT NULL;--> statement-breakpoint
UPDATE "workspaces" "s" SET "workflow_id" = "w"."id" FROM "workflows" "w"
  WHERE "w"."project_id" = "s"."project_id" AND "w"."hash" = encode(sha256(convert_to("s"."start_steps"::text || E'\n', 'UTF8')), 'hex') AND "s"."start_steps" IS NOT NULL;--> statement-breakpoint
-- Routines and sites run named workflows: one each, named after it.
INSERT INTO "named_workflows" ("project_id", "name", "workflow_id")
SELECT "r"."project_id", 'routine-' || "r"."id"::text, "w"."id" FROM "routines" "r"
  JOIN "workflows" "w" ON "w"."project_id" = "r"."project_id" AND "w"."hash" = encode(sha256(convert_to("r"."steps"::text || E'\n', 'UTF8')), 'hex')
  WHERE "r"."steps" IS NOT NULL;--> statement-breakpoint
UPDATE "routines" "r" SET "named_workflow_id" = "n"."id" FROM "named_workflows" "n"
  WHERE "n"."project_id" = "r"."project_id" AND "n"."name" = 'routine-' || "r"."id"::text;--> statement-breakpoint
INSERT INTO "named_workflows" ("project_id", "name", "workflow_id")
SELECT "s"."project_id", 'site-' || "s"."name", "w"."id" FROM "sites" "s"
  JOIN "workflows" "w" ON "w"."project_id" = "s"."project_id" AND "w"."hash" = encode(sha256(convert_to("s"."steps"::text || E'\n', 'UTF8')), 'hex');--> statement-breakpoint
UPDATE "sites" "s" SET "named_workflow_id" = "n"."id" FROM "named_workflows" "n"
  WHERE "n"."project_id" = "s"."project_id" AND "n"."name" = 'site-' || "s"."name";--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "named_workflow_id" SET NOT NULL;--> statement-breakpoint
-- A routine's pending runs follow its named workflow until they launch.
UPDATE "queued_workspaces" "q" SET "named_workflow_id" = "r"."named_workflow_id", "workflow_id" = NULL FROM "routines" "r"
  WHERE "q"."routine_id" = "r"."id" AND "r"."named_workflow_id" IS NOT NULL AND "q"."launched_workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "init_steps";--> statement-breakpoint
ALTER TABLE "queued_workspaces" DROP COLUMN "steps";--> statement-breakpoint
ALTER TABLE "routines" DROP COLUMN "steps";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "steps";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "start_steps";--> statement-breakpoint
CREATE UNIQUE INDEX "named_workflows_project_id_name_index" ON "named_workflows" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_run_secrets_project_id_name_index" ON "project_run_secrets" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_project_id_hash_index" ON "workflows" ("project_id","hash");--> statement-breakpoint
ALTER TABLE "named_workflows" ADD CONSTRAINT "named_workflows_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_init_workflow_id_workflows_id_fkey" FOREIGN KEY ("init_workflow_id") REFERENCES "workflows"("id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_init_named_workflow_id_named_workflows_id_fkey" FOREIGN KEY ("init_named_workflow_id") REFERENCES "named_workflows"("id");--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD CONSTRAINT "queued_workspaces_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id");--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD CONSTRAINT "queued_workspaces_named_workflow_id_named_workflows_id_fkey" FOREIGN KEY ("named_workflow_id") REFERENCES "named_workflows"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_named_workflow_id_named_workflows_id_fkey" FOREIGN KEY ("named_workflow_id") REFERENCES "named_workflows"("id");--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_named_workflow_id_named_workflows_id_fkey" FOREIGN KEY ("named_workflow_id") REFERENCES "named_workflows"("id");--> statement-breakpoint
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_named_workflow_id_named_workflows_id_fkey" FOREIGN KEY ("named_workflow_id") REFERENCES "named_workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id");