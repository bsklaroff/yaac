ALTER TABLE "draft_worktrees" RENAME TO "draft_workspaces";--> statement-breakpoint
ALTER TABLE "queued_worktrees" RENAME TO "queued_workspaces";--> statement-breakpoint
ALTER TABLE "worktree_agent_sessions" RENAME TO "workspace_agent_sessions";--> statement-breakpoint
ALTER TABLE "worktree_groups" RENAME TO "workspace_groups";--> statement-breakpoint
ALTER TABLE "worktrees" RENAME TO "workspaces";--> statement-breakpoint
ALTER TABLE "queued_workspaces" RENAME COLUMN "parent_worktree_id" TO "parent_workspace_id";--> statement-breakpoint
ALTER TABLE "queued_workspaces" RENAME COLUMN "launch_worktree_id" TO "launch_workspace_id";--> statement-breakpoint
ALTER TABLE "queued_workspaces" RENAME COLUMN "launched_worktree_id" TO "launched_workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" RENAME COLUMN "worktree_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME COLUMN "worktree_id" TO "workspace_id";--> statement-breakpoint
ALTER INDEX "draft_worktrees_project_slug_index" RENAME TO "draft_workspaces_project_slug_index";--> statement-breakpoint
ALTER INDEX "queued_worktrees_project_slug_parent_worktree_id_index" RENAME TO "queued_workspaces_project_slug_parent_workspace_id_index";--> statement-breakpoint
ALTER INDEX "queued_worktrees_parent_queued_id_index" RENAME TO "queued_workspaces_parent_queued_id_index";--> statement-breakpoint
ALTER INDEX "worktrees_project_slug_index" RENAME TO "workspaces_project_slug_index";--> statement-breakpoint
ALTER TABLE "queued_workspaces" RENAME CONSTRAINT "queued_worktrees_bd37KT4zgNlW_fkey" TO "queued_workspaces_bd37KT4zgNlW_fkey";--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" RENAME CONSTRAINT "worktree_agent_sessions_pkey" TO "workspace_agent_sessions_pkey";--> statement-breakpoint
ALTER TABLE "workspace_groups" RENAME CONSTRAINT "worktree_groups_pkey" TO "workspace_groups_pkey";--> statement-breakpoint
ALTER TABLE "draft_workspaces" RENAME CONSTRAINT "draft_worktrees_pkey" TO "draft_workspaces_pkey";--> statement-breakpoint
ALTER TABLE "queued_workspaces" RENAME CONSTRAINT "queued_worktrees_pkey" TO "queued_workspaces_pkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "worktrees_pkey" TO "workspaces_pkey";