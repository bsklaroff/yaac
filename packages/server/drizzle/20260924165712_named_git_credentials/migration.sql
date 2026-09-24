CREATE TABLE "git_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"sealed_secret" text NOT NULL,
	"public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "known_hosts_entry" text;--> statement-breakpoint
CREATE UNIQUE INDEX "git_credentials_name_index" ON "git_credentials" ("name");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_git_credential_id_git_credentials_id_fkey" FOREIGN KEY ("git_credential_id") REFERENCES "git_credentials"("id") ON DELETE RESTRICT;