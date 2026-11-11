ALTER TABLE "named_workflows" ADD COLUMN "init" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A project's init steps become init workflows: the named workflow it
-- followed is marked, and a graph of its own becomes a named workflow
-- "init" ("init-steps" where the project already has an "init").
UPDATE "named_workflows" AS n SET "init" = true FROM "projects" AS p
  WHERE p.init_named_workflow_id = n.id;--> statement-breakpoint
INSERT INTO "named_workflows" ("project_id", "name", "workflow_id", "init")
  SELECT p.id,
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM "named_workflows" n WHERE n.project_id = p.id AND n.name = 'init') THEN 'init'
      WHEN NOT EXISTS (SELECT 1 FROM "named_workflows" n WHERE n.project_id = p.id AND n.name = 'init-steps') THEN 'init-steps'
      ELSE 'init-' || substr(md5(p.id::text), 1, 6)
    END,
    p.init_workflow_id, true
  FROM "projects" AS p WHERE p.init_workflow_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_init_workflow_id_workflows_id_fkey";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_init_named_workflow_id_named_workflows_id_fkey";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "init_workflow_id";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "init_named_workflow_id";
