CREATE TABLE "draft_worktrees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt" text NOT NULL,
	"title" text,
	"tool" text NOT NULL,
	"mode" text NOT NULL,
	"permission_mode" text NOT NULL,
	"model" text,
	"branch" text,
	"start_after" text
);
--> statement-breakpoint
CREATE INDEX "draft_worktrees_project_slug_index" ON "draft_worktrees" ("project_slug");