CREATE TABLE "agent_sessions" (
	"project_slug" text,
	"session_id" text,
	"tool" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt" text,
	"title" text,
	"base_branch" text,
	"transcript_path" text,
	"background" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"death_reason" text,
	"death_detail" text,
	"death_seen" boolean DEFAULT false NOT NULL,
	CONSTRAINT "agent_sessions_pkey" PRIMARY KEY("project_slug","session_id")
);
--> statement-breakpoint
-- Fold the four per-session side tables into the spine. `tool` and
-- `created_at` are the only fields SQL has to guess at (an opencode meta row
-- proves the tool; everything else defaults to claude); the startup backfill
-- corrects both from the transcript that survives on disk, and adds the
-- sessions that only ever existed as a transcript file.
INSERT INTO "agent_sessions" (
	"project_slug", "session_id", "tool", "created_at", "prompt", "title",
	"background", "deleted_at", "death_reason", "death_detail", "death_seen"
)
SELECT
	k."project_slug",
	k."session_id",
	CASE WHEN m."session_id" IS NOT NULL THEN 'opencode' ELSE 'claude' END,
	COALESCE(m."created_at", d."deleted_at", now()),
	m."first_message",
	t."title",
	(b."session_id" IS NOT NULL),
	d."deleted_at",
	d."death_reason",
	d."death_detail",
	COALESCE(d."seen", false)
FROM (
	SELECT "project_slug", "session_id" FROM "session_titles"
	UNION SELECT "project_slug", "session_id" FROM "deleted_sessions"
	UNION SELECT "project_slug", "session_id" FROM "background_sessions"
	UNION SELECT "project_slug", "session_id" FROM "opencode_session_meta"
) k
LEFT JOIN "session_titles" t
	ON t."project_slug" = k."project_slug" AND t."session_id" = k."session_id"
LEFT JOIN "deleted_sessions" d
	ON d."project_slug" = k."project_slug" AND d."session_id" = k."session_id"
LEFT JOIN "background_sessions" b
	ON b."project_slug" = k."project_slug" AND b."session_id" = k."session_id"
LEFT JOIN "opencode_session_meta" m
	ON m."project_slug" = k."project_slug" AND m."session_id" = k."session_id";
--> statement-breakpoint
DROP TABLE "background_sessions";--> statement-breakpoint
DROP TABLE "deleted_sessions";--> statement-breakpoint
DROP TABLE "opencode_session_meta";--> statement-breakpoint
DROP TABLE "session_titles";