-- Users and owners (docs/remote-hosting.md "Access modes"). The built-in
-- user owns everything an install already holds, and an install with data
-- is recorded as `local`, so switching it to `tailnet` needs --owner.
CREATE TABLE "access_modes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mode" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"login" text UNIQUE,
	"name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "users" ("id", "login", "name") VALUES ('00000000-0000-0000-0000-000000000000', NULL, 'local');--> statement-breakpoint
INSERT INTO "access_modes" ("mode") SELECT 'local' WHERE EXISTS (SELECT 1 FROM "projects")
  OR EXISTS (SELECT 1 FROM "git_credentials") OR EXISTS (SELECT 1 FROM "preferences")
  OR EXISTS (SELECT 1 FROM "shortcut_overrides");--> statement-breakpoint
DROP INDEX "git_credentials_name_index";--> statement-breakpoint
ALTER TABLE "git_credentials" ADD COLUMN "owner" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';--> statement-breakpoint
ALTER TABLE "git_credentials" ALTER COLUMN "owner" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "owner" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';--> statement-breakpoint
ALTER TABLE "preferences" ALTER COLUMN "owner" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "owner" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shortcut_overrides" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "shortcut_overrides" ADD COLUMN "owner" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';--> statement-breakpoint
ALTER TABLE "shortcut_overrides" ALTER COLUMN "owner" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "preferences" DROP CONSTRAINT "preferences_pkey";--> statement-breakpoint
ALTER TABLE "preferences" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "shortcut_overrides" DROP CONSTRAINT "shortcut_overrides_pkey";--> statement-breakpoint
ALTER TABLE "shortcut_overrides" ADD PRIMARY KEY ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_credentials_owner_name_index" ON "git_credentials" ("owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "preferences_owner_key_index" ON "preferences" ("owner","key");--> statement-breakpoint
CREATE UNIQUE INDEX "shortcut_overrides_owner_command_id_index" ON "shortcut_overrides" ("owner","command_id");--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "shortcut_overrides" ADD CONSTRAINT "shortcut_overrides_owner_users_id_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id");