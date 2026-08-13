CREATE TABLE "worktree_groups" (
	"project_slug" text,
	"group_id" text,
	"name" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worktree_groups_pkey" PRIMARY KEY("project_slug","group_id")
);
--> statement-breakpoint
ALTER TABLE "worktrees" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "worktrees" DROP COLUMN "background";