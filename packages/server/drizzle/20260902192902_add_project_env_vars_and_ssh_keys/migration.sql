CREATE TABLE "git_ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"pattern" text NOT NULL,
	"sealed_private_key" text NOT NULL,
	"known_hosts_entry" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_slug" text NOT NULL,
	"name" text NOT NULL,
	"value" text,
	"sealed_value" text,
	"secret" boolean DEFAULT false NOT NULL,
	"rule" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "git_ssh_keys_pattern_index" ON "git_ssh_keys" ("pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_vars_project_slug_name_index" ON "project_env_vars" ("project_slug","name");