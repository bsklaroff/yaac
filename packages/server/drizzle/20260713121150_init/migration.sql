CREATE TABLE "opencode_session_meta" (
	"project_slug" text,
	"session_id" text,
	"first_message" text,
	"captured_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opencode_session_meta_pkey" PRIMARY KEY("project_slug","session_id")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_titles" (
	"project_slug" text,
	"session_id" text,
	"title" text NOT NULL,
	CONSTRAINT "session_titles_pkey" PRIMARY KEY("project_slug","session_id")
);
--> statement-breakpoint
CREATE TABLE "shortcut_overrides" (
	"command_id" text PRIMARY KEY,
	"code" text NOT NULL,
	"alt" boolean NOT NULL,
	"ctrl" boolean NOT NULL,
	"meta" boolean NOT NULL,
	"shift" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"name" text PRIMARY KEY,
	"token" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text
);
