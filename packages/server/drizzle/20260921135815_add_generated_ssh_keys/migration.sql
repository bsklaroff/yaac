-- Rows before this column were imported user keys with no public half on
-- record; every key is generated now (regenerate with `yaac auth update`).
-- The DELETE is also what makes the NOT NULL add below safe.
DELETE FROM "git_ssh_keys";
--> statement-breakpoint
ALTER TABLE "git_ssh_keys" ADD COLUMN "public_key" text NOT NULL;