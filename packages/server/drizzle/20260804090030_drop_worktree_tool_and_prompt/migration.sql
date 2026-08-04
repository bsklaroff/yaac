/* Backfill (hand-written — drizzle-kit generates DDL only).
   Both columns move onto the worktree's first agent session, so nothing may
   be dropped until every worktree has one to move them to.

   Three cases, in order:
   1. A worktree with no conversation at all — created after the previous
      migration's backfill, when only discovery wrote these rows. Its one
      conversation is the id the old `--session-id` pin guaranteed.
   2. Its link, marked active so a restart still brings it back.
   3. A worktree that HAS conversations but whose first one never captured an
      opening message, while the worktree itself did. Without this the
      founding ask — the sidebar's label — would be dropped on the floor. */
INSERT INTO "agent_sessions"
  ("project_slug", "tool", "agent_session_id", "first_prompt", "created_at")
  SELECT w."project_slug", w."tool", w."worktree_id", w."prompt", w."created_at"
  FROM "worktrees" w
  WHERE NOT EXISTS (
    SELECT 1 FROM "worktree_agent_sessions" l
    WHERE l."project_slug" = w."project_slug" AND l."worktree_id" = w."worktree_id"
  )
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "worktree_agent_sessions"
  ("project_slug", "worktree_id", "tool", "agent_session_id",
   "active", "ordinal", "first_seen_at", "last_seen_at")
  SELECT w."project_slug", w."worktree_id", w."tool", w."worktree_id",
         true, 0, w."created_at", w."created_at"
  FROM "worktrees" w
  WHERE NOT EXISTS (
    SELECT 1 FROM "worktree_agent_sessions" l
    WHERE l."project_slug" = w."project_slug" AND l."worktree_id" = w."worktree_id"
  )
  ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "agent_sessions" a
  SET "first_prompt" = w."prompt"
  FROM "worktrees" w, "worktree_agent_sessions" l
  WHERE l."project_slug" = w."project_slug"
    AND l."worktree_id" = w."worktree_id"
    AND l."ordinal" = 0
    AND a."project_slug" = l."project_slug"
    AND a."tool" = l."tool"
    AND a."agent_session_id" = l."agent_session_id"
    AND a."first_prompt" IS NULL
    AND w."prompt" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "worktrees" DROP COLUMN "tool";--> statement-breakpoint
ALTER TABLE "worktrees" DROP COLUMN "prompt";
