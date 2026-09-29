/* Hand-edited: drizzle-kit emits the key's *derived* name from its snapshot,
   "agent_sessions_pkey", but rename_agent_sessions_to_worktrees renamed the
   constraint to "worktrees_pkey". */
ALTER TABLE "worktrees" DROP CONSTRAINT "worktrees_pkey";--> statement-breakpoint
ALTER TABLE "worktrees" ADD PRIMARY KEY ("worktree_id");--> statement-breakpoint
CREATE INDEX "worktrees_project_slug_index" ON "worktrees" ("project_slug");
