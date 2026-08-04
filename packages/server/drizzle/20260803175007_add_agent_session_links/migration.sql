CREATE TABLE "agent_sessions" (
	"project_slug" text,
	"tool" text,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transcript_path" text,
	"first_prompt" text,
	"last_active_at" timestamp with time zone,
	CONSTRAINT "agent_sessions_pkey" PRIMARY KEY("project_slug","tool","agent_session_id")
);
--> statement-breakpoint
CREATE TABLE "worktree_agent_sessions" (
	"project_slug" text,
	"worktree_id" text,
	"tool" text,
	"agent_session_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"pane_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worktree_agent_sessions_pkey" PRIMARY KEY("project_slug","worktree_id","tool","agent_session_id")
);
--> statement-breakpoint
/* Backfill (hand-written — drizzle-kit generates DDL only).
   Until now yaac pinned the agent's own conversation id to the worktree id
   (`claude --session-id <id>`), so every existing worktree has exactly one
   agent session whose id IS the worktree id, and this is exact rather than a
   guess. Both inserts must run before the DROP COLUMN below, which is why
   they sit here instead of in a later migration.

   `active = true` for stopped worktrees too, so restart brings back exactly
   what it would have brought back before this change. */
INSERT INTO "agent_sessions"
  ("project_slug", "tool", "agent_session_id", "transcript_path", "first_prompt", "created_at")
  SELECT "project_slug", "tool", "worktree_id", "transcript_path", "prompt", "created_at"
  FROM "worktrees";--> statement-breakpoint
INSERT INTO "worktree_agent_sessions"
  ("project_slug", "worktree_id", "tool", "agent_session_id",
   "active", "ordinal", "first_seen_at", "last_seen_at")
  SELECT "project_slug", "worktree_id", "tool", "worktree_id",
         true, 0, "created_at", "created_at"
  FROM "worktrees";--> statement-breakpoint
ALTER TABLE "worktrees" DROP COLUMN "transcript_path";