UPDATE "workspaces" w SET "mode" = COALESCE((
  SELECT s."mode" FROM "workspace_agent_sessions" l
  JOIN "agent_sessions" s ON s."project_id" = l."project_id" AND s."tool" = l."tool"
    AND s."agent_session_id" = l."agent_session_id"
  WHERE l."project_id" = w."project_id" AND l."workspace_id" = w."workspace_id"
  ORDER BY l."ordinal" LIMIT 1
), 'acp') WHERE w."mode" IS NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "mode" SET DEFAULT 'acp';--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "mode" SET NOT NULL;
