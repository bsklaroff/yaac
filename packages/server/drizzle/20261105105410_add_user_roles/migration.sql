-- Install roles (docs/multi-user.md "Roles"). The built-in user starts as
-- the admin, unless it is a tailnet install's built-in user with no login,
-- which nobody can sign in as; such an install names its admins on its
-- next start.
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_seen_at" DROP NOT NULL;--> statement-breakpoint
UPDATE "users" SET "role" = 'admin' WHERE "id" = '00000000-0000-0000-0000-000000000000' AND ("login" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM "access_modes" WHERE "mode" = 'tailnet'));
