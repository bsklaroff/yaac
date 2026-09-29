CREATE TABLE "queued_worktrees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_slug" text NOT NULL,
	"parent_worktree_id" text,
	"parent_queued_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt" text NOT NULL,
	"tool" text NOT NULL,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"permission_mode" text NOT NULL,
	"branch" text NOT NULL,
	"released_at" timestamp with time zone,
	"launch_worktree_id" text,
	"launch_error" text
);
--> statement-breakpoint
CREATE INDEX "queued_worktrees_project_slug_parent_worktree_id_index" ON "queued_worktrees" ("project_slug","parent_worktree_id");--> statement-breakpoint
CREATE INDEX "queued_worktrees_parent_queued_id_index" ON "queued_worktrees" ("parent_queued_id");