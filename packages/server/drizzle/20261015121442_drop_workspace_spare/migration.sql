DELETE FROM "workspaces" WHERE "spare";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "spare";
