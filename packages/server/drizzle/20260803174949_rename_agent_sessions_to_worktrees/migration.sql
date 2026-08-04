ALTER TABLE "agent_sessions" RENAME TO "worktrees";--> statement-breakpoint
ALTER TABLE "worktrees" RENAME COLUMN "session_id" TO "worktree_id";--> statement-breakpoint
ALTER TABLE "worktrees" RENAME COLUMN "deleted_at" TO "stopped_at";--> statement-breakpoint
/* Hand-added: postgres renames a table but NOT its constraints, so the primary
   key would still be called "agent_sessions_pkey" — and the next migration
   creates a *new* agent_sessions whose own pkey then collides with it.
   drizzle-kit does not emit this because the constraint name is derived, not
   declared. */
ALTER TABLE "worktrees" RENAME CONSTRAINT "agent_sessions_pkey" TO "worktrees_pkey";