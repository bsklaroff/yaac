ALTER TABLE "draft_workspaces" ADD COLUMN "agent_options" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tool_defaults" ADD COLUMN "agent_options" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_workspaces" ADD COLUMN "agent_options" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "agent_options" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_options" jsonb DEFAULT '{}' NOT NULL;