ALTER TABLE "project_tool_defaults" ADD COLUMN "efforts" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE "project_tool_defaults" SET "efforts" = jsonb_build_object("model", "effort") WHERE "model" IS NOT NULL AND "effort" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tool_defaults" DROP COLUMN "effort";
