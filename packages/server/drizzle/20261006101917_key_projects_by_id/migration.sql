-- Re-key every project reference from the slug to projects.id, and keep the
-- slug as the display-only name. Rows naming a slug with no project are
-- orphans nothing can reach, so they are dropped rather than backfilled.
ALTER TABLE "projects" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "projects" SET "name" = "slug";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
DELETE FROM "agent_sessions" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "agent_sessions" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "agent_sessions"."project_slug";--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "draft_workspaces" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "draft_workspaces" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "draft_workspaces" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "draft_workspaces"."project_slug";--> statement-breakpoint
ALTER TABLE "draft_workspaces" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "project_env_vars" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "project_env_vars" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "project_env_vars" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "project_env_vars"."project_slug";--> statement-breakpoint
ALTER TABLE "project_env_vars" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "project_tool_defaults" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "project_tool_defaults" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "project_tool_defaults" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "project_tool_defaults"."project_slug";--> statement-breakpoint
ALTER TABLE "project_tool_defaults" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "queued_workspaces" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "queued_workspaces" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "queued_workspaces"."project_slug";--> statement-breakpoint
ALTER TABLE "queued_workspaces" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "workspace_agent_sessions" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "workspace_agent_sessions" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "workspace_agent_sessions"."project_slug";--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "workspace_groups" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "workspace_groups" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "workspace_groups" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "workspace_groups"."project_slug";--> statement-breakpoint
ALTER TABLE "workspace_groups" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DELETE FROM "workspaces" WHERE "project_slug" NOT IN (SELECT "slug" FROM "projects");--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "workspaces" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."slug" = "workspaces"."project_slug";--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "draft_workspaces_project_slug_index";--> statement-breakpoint
DROP INDEX "project_env_vars_project_slug_name_index";--> statement-breakpoint
DROP INDEX "project_tool_defaults_project_slug_tool_index";--> statement-breakpoint
DROP INDEX "queued_workspaces_project_slug_parent_workspace_id_index";--> statement-breakpoint
DROP INDEX "workspaces_project_slug_index";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "draft_workspaces" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "project_env_vars" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "project_tool_defaults" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "queued_workspaces" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "workspace_groups" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "project_slug";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_id_key";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD PRIMARY KEY ("project_id","tool","agent_session_id");--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" ADD PRIMARY KEY ("project_id","workspace_id","tool","agent_session_id");--> statement-breakpoint
ALTER TABLE "workspace_groups" ADD PRIMARY KEY ("project_id","group_id");--> statement-breakpoint
ALTER TABLE "projects" ADD PRIMARY KEY ("id");--> statement-breakpoint
CREATE INDEX "draft_workspaces_project_id_index" ON "draft_workspaces" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_vars_project_id_name_index" ON "project_env_vars" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tool_defaults_project_id_tool_index" ON "project_tool_defaults" ("project_id","tool");--> statement-breakpoint
CREATE INDEX "queued_workspaces_project_id_parent_workspace_id_index" ON "queued_workspaces" ("project_id","parent_workspace_id");--> statement-breakpoint
CREATE INDEX "workspaces_project_id_index" ON "workspaces" ("project_id");