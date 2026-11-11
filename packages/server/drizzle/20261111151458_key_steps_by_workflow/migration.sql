-- A step of a life started before steps had workflows keeps its bare name,
-- under which its window and log files run (docs/legacy-compat-shims.md).
UPDATE "workspace_steps" SET "workflow_name" = '';--> statement-breakpoint
ALTER TABLE "workspace_steps" ALTER COLUMN "workflow_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "workspace_steps" ALTER COLUMN "workflow_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_steps" DROP CONSTRAINT "workspace_steps_pkey";--> statement-breakpoint
ALTER TABLE "workspace_steps" ADD PRIMARY KEY ("workspace_id","workflow_name","name");--> statement-breakpoint
-- A workflow's name follows a step's rule: no ".", which joins the two, and
-- at most 48 long. A name that becomes another of its project's gets a
-- suffix from its id, which no name it could meet holds.
UPDATE "workspaces" AS w SET "workflow_name" = f.new FROM (
  SELECT project_id, old, CASE WHEN rn = 1 THEN base ELSE substr(base, 1, 41) || '-' || substr(md5(id::text), 1, 6) END AS new
  FROM (
    SELECT id, project_id, name AS old, substr(regexp_replace(name, '\.', '-', 'g'), 1, 48) AS base,
      row_number() OVER (PARTITION BY project_id, substr(regexp_replace(name, '\.', '-', 'g'), 1, 48)
        ORDER BY (name = substr(regexp_replace(name, '\.', '-', 'g'), 1, 48)) DESC, created_at, id) AS rn
    FROM "named_workflows"
  ) ranked
) AS f WHERE w.project_id = f.project_id AND w.workflow_name = f.old AND f.old <> f.new;--> statement-breakpoint
UPDATE "workspaces" SET "workflow_name" = substr(regexp_replace("workflow_name", '\.', '-', 'g'), 1, 48)
  WHERE "workflow_name" LIKE '%.%' OR length("workflow_name") > 48;--> statement-breakpoint
UPDATE "named_workflows" AS n SET "name" = f.new FROM (
  SELECT id, old, CASE WHEN rn = 1 THEN base ELSE substr(base, 1, 41) || '-' || substr(md5(id::text), 1, 6) END AS new
  FROM (
    SELECT id, name AS old, substr(regexp_replace(name, '\.', '-', 'g'), 1, 48) AS base,
      row_number() OVER (PARTITION BY project_id, substr(regexp_replace(name, '\.', '-', 'g'), 1, 48)
        ORDER BY (name = substr(regexp_replace(name, '\.', '-', 'g'), 1, 48)) DESC, created_at, id) AS rn
    FROM "named_workflows"
  ) ranked
) AS f WHERE n.id = f.id AND f.old <> f.new;--> statement-breakpoint
-- A workspace that brought its own graph names its workflow, which its
-- steps are known by from its next life.
UPDATE "workspaces" SET "workflow_name" = substr(md5("workspace_id"), 1, 4)
  WHERE "workflow_id" IS NOT NULL AND "workflow_name" IS NULL;
