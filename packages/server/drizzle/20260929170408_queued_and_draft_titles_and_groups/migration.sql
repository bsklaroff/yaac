ALTER TABLE "draft_worktrees" ADD COLUMN "generated_title" text;--> statement-breakpoint
ALTER TABLE "draft_worktrees" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "queued_worktrees" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "queued_worktrees" ADD COLUMN "group_id" text;--> statement-breakpoint
-- A draft's title was model-generated until now; the column is the user's.
UPDATE "draft_worktrees" SET "generated_title" = "title", "title" = NULL;--> statement-breakpoint
-- An entry launched into its nearest parent worktree's group; it now keeps
-- the group it was queued with, so it starts from that one. UNION, not
-- UNION ALL: a parent_queued_id cycle then repeats a row and ends the walk
-- instead of looping forever and keeping the server from starting.
WITH RECURSIVE "up" ("id", "next_queued_id", "parent_worktree_id") AS (
  SELECT "id", "parent_queued_id", "parent_worktree_id" FROM "queued_worktrees"
  UNION
  SELECT "up"."id", "q"."parent_queued_id", "q"."parent_worktree_id"
  FROM "up" JOIN "queued_worktrees" "q" ON "q"."id" = "up"."next_queued_id"
)
UPDATE "queued_worktrees" SET "group_id" = "w"."group_id"
FROM "up" JOIN "worktrees" "w" ON "w"."worktree_id" = "up"."parent_worktree_id"
WHERE "up"."id" = "queued_worktrees"."id";
