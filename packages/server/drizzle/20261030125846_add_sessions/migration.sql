CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"tool" text NOT NULL,
	"mode" text NOT NULL,
	"model" text,
	"permission_mode" text NOT NULL,
	"effort" text,
	"ordinal" integer NOT NULL,
	"window" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"launched_at" timestamp with time zone,
	"first_prompt" text,
	"pending_prompt" text,
	"conversation_id" text,
	"title" text,
	"waiting_seen_by" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_conversations" ADD COLUMN "session_id" uuid;--> statement-breakpoint
-- Each conversation that was live becomes an open session; in a workspace
-- with none live, its first conversation does, as its restart brought that
-- one back.
UPDATE "workspace_conversations" "l" SET "session_id" = gen_random_uuid()
WHERE "l"."active" OR (
  NOT EXISTS (SELECT 1 FROM "workspace_conversations" "a"
    WHERE "a"."project_id" = "l"."project_id" AND "a"."workspace_id" = "l"."workspace_id" AND "a"."active")
  AND "l"."ordinal" = (SELECT min("o"."ordinal") FROM "workspace_conversations" "o"
    WHERE "o"."project_id" = "l"."project_id" AND "o"."workspace_id" = "l"."workspace_id")
);--> statement-breakpoint
-- Settings come from the workspace row, which held them for all its agents;
-- the window is the one a create or restart gave it (`<tool>`, then
-- `<tool>-<n>` in restore order), or the acp handle it was last seen on. A
-- running workspace's sessions count as launched in its current life.
INSERT INTO "sessions" ("id", "project_id", "workspace_id", "tool", "mode", "model", "permission_mode", "effort",
  "ordinal", "window", "opened_at", "launched_at", "first_prompt", "pending_prompt", "conversation_id", "waiting_seen_by")
SELECT "l"."session_id", "l"."project_id", "l"."workspace_id", "l"."tool", "c"."mode",
  COALESCE("c"."model", CASE WHEN "n"."rn" = 1 THEN "w"."model" END),
  "w"."permission_mode", "w"."effort", "l"."ordinal",
  CASE WHEN "c"."mode" = 'acp' AND "l"."pane_id" IS NOT NULL THEN "l"."pane_id"
    WHEN "n"."rn" = 1 THEN "l"."tool" ELSE "l"."tool" || '-' || "n"."rn" END,
  "l"."first_seen_at",
  CASE WHEN "w"."stopped_at" IS NULL THEN "w"."life_started_at" END,
  "c"."first_prompt",
  CASE WHEN "n"."rn" = 1 THEN "w"."pending_prompt" END,
  -- codex and opencode name their own conversations, so one still under the
  -- workspace id never had a real one.
  CASE WHEN "l"."tool" IN ('codex', 'opencode') AND "l"."conversation_id" = "l"."workspace_id" THEN NULL
    ELSE "l"."conversation_id" END,
  "w"."waiting_seen_by"
FROM "workspace_conversations" "l"
JOIN "conversations" "c" ON "c"."project_id" = "l"."project_id" AND "c"."tool" = "l"."tool"
  AND "c"."conversation_id" = "l"."conversation_id"
JOIN "workspaces" "w" ON "w"."workspace_id" = "l"."workspace_id"
JOIN (SELECT "session_id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "ordinal") AS "rn"
  FROM "workspace_conversations" WHERE "session_id" IS NOT NULL) "n" ON "n"."session_id" = "l"."session_id";--> statement-breakpoint
-- A workspace that recorded no conversation (an acp agent that never
-- finished its handshake) gets the one session its restart started.
INSERT INTO "sessions" ("project_id", "workspace_id", "tool", "mode", "model", "permission_mode", "effort",
  "ordinal", "window", "launched_at", "first_prompt", "pending_prompt", "waiting_seen_by")
SELECT "w"."project_id", "w"."workspace_id", COALESCE("p"."last_tool", 'claude'), "w"."mode", "w"."model",
  "w"."permission_mode", "w"."effort", 0, COALESCE("p"."last_tool", 'claude'),
  CASE WHEN "w"."stopped_at" IS NULL THEN "w"."life_started_at" END,
  "w"."pending_prompt", "w"."pending_prompt", "w"."waiting_seen_by"
FROM "workspaces" "w" LEFT JOIN "projects" "p" ON "p"."id" = "w"."project_id"
WHERE NOT EXISTS (SELECT 1 FROM "workspace_conversations" "l"
  WHERE "l"."project_id" = "w"."project_id" AND "l"."workspace_id" = "w"."workspace_id");--> statement-breakpoint
-- A link whose conversation or workspace row is gone made no session.
UPDATE "workspace_conversations" SET "session_id" = NULL
WHERE "session_id" IS NOT NULL AND "session_id" NOT IN (SELECT "id" FROM "sessions");--> statement-breakpoint
-- Two of a workspace's sessions never share a window.
UPDATE "sessions" "s" SET "window" = "s"."window" || '-' || substr("s"."id"::text, 1, 8)
WHERE EXISTS (SELECT 1 FROM "sessions" "o"
  WHERE "o"."workspace_id" = "s"."workspace_id" AND "o"."window" = "s"."window" AND "o"."id" < "s"."id");--> statement-breakpoint
CREATE INDEX "sessions_workspace_id_index" ON "sessions" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_workspace_id_window_index" ON "sessions" ("workspace_id","window") WHERE "closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id") ON DELETE CASCADE;
