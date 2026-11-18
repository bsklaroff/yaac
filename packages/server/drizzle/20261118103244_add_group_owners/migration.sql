ALTER TABLE "workspace_groups" ADD COLUMN "owner_kind" text;--> statement-breakpoint
ALTER TABLE "workspace_groups" ADD COLUMN "owner_id" text;--> statement-breakpoint
-- A routine created with no group made one named after it moments before
-- its own row; that group becomes the routine's own, so the sidebar draws
-- its runs under the routine. A person's group the routine joined by name
-- is older than the routine, and a group two such routines share has no one
-- owner, so neither is claimed.
UPDATE "workspace_groups" AS g SET "owner_kind" = 'routine', "owner_id" = r."id"::text
FROM "routines" AS r
WHERE r."project_id" = g."project_id" AND r."group_id" = g."group_id" AND lower(r."name") = lower(g."name")
  AND g."created_at" BETWEEN r."created_at" - interval '5 seconds' AND r."created_at"
  AND NOT EXISTS (
    SELECT 1 FROM "routines" AS other
    WHERE other."project_id" = r."project_id" AND other."group_id" = r."group_id" AND other."id" <> r."id"
  );
