CREATE TABLE "launch_approvals" (
	"spec" text,
	"ref" text,
	"workflow_id" uuid NOT NULL,
	"site_id" uuid,
	CONSTRAINT "launch_approvals_pkey" PRIMARY KEY("spec","ref")
);
--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "approval_request" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "requested_commits" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "requested_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "person_written" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "hostname" DROP NOT NULL;--> statement-breakpoint
-- Every site so far was routed as soon as it was made, so it stays published.
UPDATE "sites" SET "published" = true;--> statement-breakpoint
-- Only a person could write a named workflow so far.
UPDATE "workflows" SET "person_written" = true
WHERE "id" IN (SELECT "workflow_id" FROM "named_workflows");--> statement-breakpoint
-- A named workflow's approvals become its current workflow's.
INSERT INTO "launch_approvals" ("spec", "ref", "workflow_id")
SELECT nw."workflow_id"::text, wa."ref", nw."workflow_id"
FROM "workflow_approvals" wa JOIN "named_workflows" nw ON nw."id" = wa."named_workflow_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A non-interactive run that got secrets approved its commits by running,
-- and one with no repos approved its workflow alone (`-`).
INSERT INTO "launch_approvals" ("spec", "ref", "workflow_id")
SELECT DISTINCT w."workflow_id"::text, coalesce(wr."start_commit", '-'), w."workflow_id"
FROM "workspaces" w JOIN "workflows" f ON f."id" = w."workflow_id"
LEFT JOIN "workspace_repos" wr ON wr."workspace_id" = w."workspace_id"
WHERE w."non_interactive" AND w."site_id" IS NULL AND cardinality(f."secrets") > 0
  AND (wr."start_commit" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM "workspace_repos" r WHERE r."workspace_id" = w."workspace_id"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A site's last release is approved as it ran, so a replacement and
-- `site start` repeat it (`siteSpec`: site, workflow, port, volume).
INSERT INTO "launch_approvals" ("spec", "ref", "workflow_id", "site_id")
SELECT s."id"::text || ':' || w."workflow_id"::text || ':' || coalesce(s."live_port", s."port")::text || ':' || coalesce(w."volume_id"::text, ''),
  c."value", w."workflow_id", s."id"
FROM "sites" s JOIN "workspaces" w ON w."workspace_id" = s."release_workspace_id"
CROSS JOIN LATERAL jsonb_each_text(s."release_commits") c
WHERE w."workflow_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A following site keeps following what a person set it to follow, for its
-- current settings.
INSERT INTO "launch_approvals" ("spec", "ref", "workflow_id", "site_id")
SELECT s."id"::text || ':' || nw."workflow_id"::text || ':' || s."port"::text || ':' || coalesce(s."volume_id"::text, ''),
  coalesce(r->>'commit', (r->>'repo') || ':refs/heads/' || (r->>'branch')), nw."workflow_id", s."id"
FROM "sites" s JOIN "named_workflows" nw ON nw."id" = s."named_workflow_id"
CROSS JOIN LATERAL jsonb_array_elements(s."repos") r
WHERE s."follow" AND (r->>'commit' IS NOT NULL OR r->>'branch' IS NOT NULL)
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "workflow_approvals";--> statement-breakpoint
ALTER TABLE "launch_approvals" ADD CONSTRAINT "launch_approvals_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "launch_approvals" ADD CONSTRAINT "launch_approvals_site_id_sites_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;
