CREATE TABLE "project_tool_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_slug" text NOT NULL,
	"tool" text NOT NULL,
	"model" text,
	"permission_mode" text,
	"mode" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_tool_defaults_project_slug_tool_index" ON "project_tool_defaults" ("project_slug","tool");--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_tool" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "mode" text;--> statement-breakpoint
INSERT INTO "project_tool_defaults" ("project_slug", "tool", "permission_mode")
  SELECT p."slug", t."tool", p."last_permission_mode"
  FROM "projects" p
  CROSS JOIN (VALUES ('claude'), ('codex'), ('opencode')) AS t("tool")
  WHERE p."last_permission_mode" IS NOT NULL
    AND NOT (t."tool" = 'opencode' AND p."last_permission_mode" = 'auto');--> statement-breakpoint
UPDATE "projects" SET "last_tool" = (SELECT "value" FROM "preferences" WHERE "key" = 'default_tool')
  WHERE "last_tool" IS NULL;--> statement-breakpoint
DELETE FROM "preferences" WHERE "key" = 'default_tool';--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "last_permission_mode";
